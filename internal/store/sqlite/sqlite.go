// Package sqlite stores tasks in a local SQLite file.
//
// It is the reference provider: the one every test runs against, the one the
// shared conformance suite is written for, and the one whose column layout
// the cloud providers imitate. The required fields of PLAN.md §3.2 are
// columns, tags are a join table, and the user-defined part of a task is one
// JSON object in the fields column, so adding an attribute never needs a
// migration.
//
// The tree rules and the availability computation are not written here. They
// live in internal/store as pure functions over an in-memory tree, and this
// package loads the rows and asks. That is what keeps every provider's answer
// to "is this available?" the same answer.
//
// The driver is modernc.org/sqlite, a pure-Go implementation, so the binary
// still builds with CGO_ENABLED=0 for every platform the project ships.
package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/soya-miyoshi/todocloud/internal/id"
	"github.com/soya-miyoshi/todocloud/internal/store"
	"github.com/soya-miyoshi/todocloud/internal/task"

	_ "modernc.org/sqlite" // database/sql driver "sqlite"
)

var _ store.Store = (*Store)(nil)

// MemoryPath opens a private in-memory database. Tests use it; a user never
// does, because the tasks would vanish with the process.
const MemoryPath = ":memory:"

// Store is a SQLite-backed task store.
type Store struct {
	db   *sql.DB
	path string
}

// Open opens the database at path, creating the file and its parent
// directories when they are missing. Only `tdo init` may create a store;
// every other command opens one with OpenExisting.
//
// The special path ":memory:" opens a private in-memory database. A leading
// "~" is not expanded here: the config package resolves the path before
// calling Open, so that this package has no opinion about the filesystem
// layout.
func Open(path string) (*Store, error) {
	if path != MemoryPath {
		if dir := filepath.Dir(path); dir != "" {
			if err := os.MkdirAll(dir, 0o700); err != nil {
				return nil, fmt.Errorf("sqlite: create %s: %w", dir, err)
			}
		}
	}
	return open(path, path)
}

// OpenExisting opens a store that must already exist. It returns an error
// wrapping store.ErrNotInitialized when the file is absent, and it never
// creates a file or a directory: the path is checked first, and the driver is
// handed a DSN that cannot create one either.
//
// A read-only command that creates an empty second task list is worse than a
// command that fails, because the empty list looks exactly like the real one.
func OpenExisting(path string) (*Store, error) {
	// An in-memory database never exists before it is opened, so there is
	// nothing for a command other than `tdo init` to find.
	if path == MemoryPath {
		return nil, fmt.Errorf("sqlite: %s: %w", path, store.ErrNotInitialized)
	}
	if _, err := os.Stat(path); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("sqlite: %s: %w", path, store.ErrNotInitialized)
		}
		return nil, fmt.Errorf("sqlite: open %s: %w", path, err)
	}
	// mode=rw fails rather than creating the file, which keeps the guard
	// above from being the only thing standing between a typo and a stray
	// database.
	return open(path, "file:"+path+"?mode=rw")
}

// open is the shared body: dsn decides whether the driver may create the
// file, and path is what the store reports about itself.
func open(path, dsn string) (*Store, error) {
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("sqlite: open %s: %w", path, err)
	}
	// One connection: an in-memory database is per-connection, and the CLI is
	// single-goroutine anyway, so a pool would only invite lock contention.
	db.SetMaxOpenConns(1)

	for _, pragma := range []string{
		`PRAGMA foreign_keys = ON`,
		`PRAGMA busy_timeout = 5000`,
		`PRAGMA journal_mode = WAL`,
	} {
		if _, err := db.ExecContext(context.Background(), pragma); err != nil {
			db.Close()
			return nil, fmt.Errorf("sqlite: %s: %w", pragma, err)
		}
	}

	st := &Store{db: db, path: path}
	st.secureFiles()
	return st, nil
}

// fileMode is the mode the database and its journal files are kept at. A task
// list is private data, and SQLite creates its files with the process umask,
// which on most machines means world-readable.
const fileMode = 0o600

// secureFiles tightens the database file and the two files WAL mode creates
// beside it. It runs on every open because the journal files come and go with
// the connection, so creating them once at the right mode is not enough.
//
// A failure is deliberately ignored: the store still works, and refusing to
// open a task list because its mode could not be changed would be worse than
// the exposure. The permission test covers the case that matters, which is a
// file this tool created itself.
func (s *Store) secureFiles() {
	if s.path == MemoryPath {
		return
	}
	for _, path := range []string{s.path, s.path + "-wal", s.path + "-shm"} {
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() == fileMode {
			continue
		}
		if info.Mode().Perm()&0o177 != 0 {
			_ = os.Chmod(path, fileMode)
		}
	}
}

// notInitialized rewrites a failure whose real cause is a missing table into
// one wrapping store.ErrNotInitialized, so that a store with no schema is
// reported as a configuration problem with the advice to run `tdo init`
// instead of leaking the driver's "no such table: tasks". Every method that
// queries passes its error through here; nil and unrelated errors come back
// unchanged.
func (s *Store) notInitialized(err error) error {
	if err == nil || !missingTable(err) {
		return err
	}
	return fmt.Errorf("sqlite: %s: %w", s.path, store.ErrNotInitialized)
}

// missingTable reports whether err is the driver's complaint about a table
// that does not exist. The driver offers no error code for it, so the message
// is all there is to match on.
func missingTable(err error) bool {
	return err != nil && strings.Contains(strings.ToLower(err.Error()), "no such table")
}

// Describe returns the database path, which is not a credential, and nothing
// else.
func (s *Store) Describe() string { return "sqlite: " + s.path }

// Ping checks that the handle works and that the schema is present.
func (s *Store) Ping(ctx context.Context) error {
	if err := s.db.PingContext(ctx); err != nil {
		return fmt.Errorf("sqlite: ping %s: %w", s.path, err)
	}
	if _, err := s.SchemaVersion(ctx); err != nil {
		return err
	}
	return nil
}

// Close releases the handle. It is safe to call more than once.
func (s *Store) Close() error {
	if s.db == nil {
		return nil
	}
	db := s.db
	s.db = nil
	if err := db.Close(); err != nil {
		return fmt.Errorf("sqlite: close %s: %w", s.path, err)
	}
	return nil
}

const columns = `id, kind, title, parent_id, position, status, flagged, sequential,
	completed_by_children, defer_at, due_at, estimated_minutes, note, repeat, series_id,
	review_interval, last_reviewed_at, created_at, updated_at, completed_at, dropped_at,
	deleted_at, fields`

const placeholders = `?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?`

// Add inserts a new task with its tags. A duplicate id is an error rather
// than a silent overwrite, so a generator bug cannot destroy data.
func (s *Store) Add(ctx context.Context, t *task.Task) error {
	// Every lookup normalises the id, so an id stored in another case would
	// be unreachable afterwards. Normalising on the way in keeps the store's
	// one copy of an id canonical, and the same goes for the edge it carries.
	t = normalizedCopy(t)
	if err := t.Validate(); err != nil {
		return fmt.Errorf("sqlite: add task %s: %w", t.ID, err)
	}

	tx, err := s.begin(ctx, "add")
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if err := s.checkPlacement(ctx, tx, t); err != nil {
		return err
	}
	args, err := insertArgs(t)
	if err != nil {
		return err
	}
	const q = `INSERT INTO tasks (` + columns + `) VALUES (` + placeholders + `)`
	if _, err := tx.ExecContext(ctx, q, args...); err != nil {
		if isUniqueViolation(err) {
			// The caller decides what a duplicate means — `tdo import` skips
			// it — so report it as the sentinel rather than as the driver's
			// constraint message.
			return fmt.Errorf("sqlite: %s: %w", t.ID, store.ErrExists)
		}
		return s.notInitialized(fmt.Errorf("sqlite: add task %s: %w", t.ID, err))
	}
	if err := writeTags(ctx, tx, t); err != nil {
		return err
	}
	return s.commit(tx, "add")
}

// Update replaces every column of the task with this id, tags included.
func (s *Store) Update(ctx context.Context, t *task.Task) error {
	t = normalizedCopy(t)
	if err := t.Validate(); err != nil {
		return fmt.Errorf("sqlite: update task %s: %w", t.ID, err)
	}

	tx, err := s.begin(ctx, "update")
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if err := s.checkPlacement(ctx, tx, t); err != nil {
		return err
	}
	args, err := insertArgs(t)
	if err != nil {
		return err
	}
	// insertArgs puts the id first; the UPDATE wants it last.
	res, err := tx.ExecContext(ctx, updateSQL, append(args[1:], args[0])...)
	if err != nil {
		return s.notInitialized(fmt.Errorf("sqlite: update task %s: %w", t.ID, err))
	}
	if err := affected(res, t.ID, "update"); err != nil {
		return err
	}
	if err := writeTags(ctx, tx, t); err != nil {
		return err
	}
	if err := s.autoComplete(ctx, tx, t); err != nil {
		return err
	}
	return s.commit(tx, "update")
}

const updateSQL = `UPDATE tasks SET kind = ?, title = ?, parent_id = ?, position = ?, status = ?,
	           flagged = ?, sequential = ?, completed_by_children = ?, defer_at = ?, due_at = ?,
	           estimated_minutes = ?, note = ?, repeat = ?, series_id = ?, review_interval = ?,
	           last_reviewed_at = ?, created_at = ?, updated_at = ?, completed_at = ?,
	           dropped_at = ?, deleted_at = ?, fields = ? WHERE id = ?`

// autoComplete applies "complete with last action" (§3.2's
// completed_by_children) inside the transaction that closed t. The rule
// itself is the shared one in store.AutoComplete; this provider only reads
// the tree the update has already produced, asks, and writes the answer, so
// that its behaviour cannot drift from the other providers'.
func (s *Store) autoComplete(ctx context.Context, tx *sql.Tx, t *task.Task) error {
	if !store.TriggersAutoCompletion(t) {
		return nil
	}
	tree, err := s.loadTreeTx(ctx, tx)
	if err != nil {
		return err
	}
	for _, container := range store.AutoComplete(tree, t.ID, t.UpdatedAt) {
		args, err := insertArgs(container)
		if err != nil {
			return err
		}
		res, err := tx.ExecContext(ctx, updateSQL, append(args[1:], args[0])...)
		if err != nil {
			return s.notInitialized(fmt.Errorf("sqlite: complete container %s with its last child: %w", container.ID, err))
		}
		if err := affected(res, container.ID, "update"); err != nil {
			return err
		}
	}
	return nil
}

// Move reparents a task and sets its position, touching nothing else but
// updated_at. It is the one operation that exists so a caller does not have
// to read, edit and write back a whole task to drag it somewhere.
func (s *Store) Move(ctx context.Context, taskID, parentID string, position int, now time.Time) error {
	taskID = id.Normalize(taskID)
	parentID = id.Normalize(parentID)

	tx, err := s.begin(ctx, "move")
	if err != nil {
		return err
	}
	defer tx.Rollback()

	current, err := s.getTx(ctx, tx, taskID)
	if err != nil {
		return err
	}
	current.ParentID = parentID
	current.Position = position
	if err := s.checkPlacement(ctx, tx, current); err != nil {
		return err
	}

	const q = `UPDATE tasks SET parent_id = ?, position = ?, updated_at = ? WHERE id = ?`
	res, err := tx.ExecContext(ctx, q, nullString(parentID), position, task.FormatTime(now), taskID)
	if err != nil {
		return s.notInitialized(fmt.Errorf("sqlite: move task %s: %w", taskID, err))
	}
	if err := affected(res, taskID, "move"); err != nil {
		return err
	}
	return s.commit(tx, "move")
}

// checkPlacement enforces the tree rules of §3.1 for the placement t
// describes: the parent must exist, its kind must be allowed to contain this
// one, and the parent must not be t itself or one of its descendants.
func (s *Store) checkPlacement(ctx context.Context, tx *sql.Tx, t *task.Task) error {
	if t.ParentID == "" {
		return nil
	}
	if t.ParentID == t.ID {
		return store.CycleError(t.ID, t.ParentID)
	}
	parent, err := s.getTx(ctx, tx, t.ParentID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return fmt.Errorf("sqlite: parent %s: %w", t.ParentID, store.ErrNotFound)
		}
		return err
	}
	if err := store.CheckParent(t.Kind, parent); err != nil {
		return fmt.Errorf("sqlite: %w", err)
	}
	// Walking up from the new parent is cheaper than walking down from t,
	// and it terminates on the root. If t is on that path, the move would cut
	// t's branch loose from the tree entirely.
	seen := map[string]bool{parent.ID: true}
	for node := parent; node.ParentID != ""; {
		if node.ParentID == t.ID {
			return store.CycleError(t.ID, t.ParentID)
		}
		if seen[node.ParentID] {
			// A cycle already in the data: refuse rather than loop.
			return store.CycleError(node.ID, node.ParentID)
		}
		seen[node.ParentID] = true
		node, err = s.getTx(ctx, tx, node.ParentID)
		if err != nil {
			return err
		}
	}
	return nil
}

// Get returns the task with exactly this id, tombstoned or not.
func (s *Store) Get(ctx context.Context, taskID string) (*task.Task, error) {
	const q = `SELECT ` + columns + ` FROM tasks WHERE id = ?`
	normalized := id.Normalize(taskID)
	row := s.db.QueryRowContext(ctx, q, normalized)
	t, err := scanTask(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("sqlite: %s: %w", taskID, store.ErrNotFound)
	}
	if err != nil {
		return nil, s.notInitialized(fmt.Errorf("sqlite: get task %s: %w", taskID, err))
	}
	if err := s.attachTags(ctx, t); err != nil {
		return nil, err
	}
	return t, nil
}

// getTx reads one task inside an open transaction, so that a placement check
// and the write it guards see the same tree.
func (s *Store) getTx(ctx context.Context, tx *sql.Tx, taskID string) (*task.Task, error) {
	const q = `SELECT ` + columns + ` FROM tasks WHERE id = ?`
	row := tx.QueryRowContext(ctx, q, id.Normalize(taskID))
	t, err := scanTask(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("sqlite: %s: %w", taskID, store.ErrNotFound)
	}
	if err != nil {
		return nil, s.notInitialized(fmt.Errorf("sqlite: get task %s: %w", taskID, err))
	}
	return t, nil
}

// FindByPrefix returns the single task whose id starts with prefix. It reads
// at most two rows, because two is all it takes to know the prefix is
// ambiguous.
func (s *Store) FindByPrefix(ctx context.Context, prefix string) (*task.Task, error) {
	p := id.Normalize(prefix)
	const q = `SELECT ` + columns + ` FROM tasks WHERE id LIKE ? ESCAPE '\' ORDER BY id LIMIT 2`
	rows, err := s.db.QueryContext(ctx, q, escapeLike(p)+"%")
	if err != nil {
		return nil, s.notInitialized(fmt.Errorf("sqlite: find task %s: %w", prefix, err))
	}
	defer rows.Close()

	var found *task.Task
	for rows.Next() {
		t, err := scanTask(rows)
		if err != nil {
			return nil, fmt.Errorf("sqlite: find task %s: %w", prefix, err)
		}
		if found != nil {
			return nil, fmt.Errorf("sqlite: %s: %w", prefix, store.ErrAmbiguous)
		}
		found = t
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("sqlite: find task %s: %w", prefix, err)
	}
	if found == nil {
		return nil, fmt.Errorf("sqlite: %s: %w", prefix, store.ErrNotFound)
	}
	if err := s.attachTags(ctx, found); err != nil {
		return nil, err
	}
	return found, nil
}

// escapeLike neutralises the LIKE wildcards. An id prefix cannot contain them,
// but the caller is not required to have validated one.
func escapeLike(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return r.Replace(s)
}

// Purge removes a task irreversibly. Ordinary removal is an Update that sets
// the tombstone, so that multi-device sync stays possible.
//
// A task that still has children is refused: purging it would orphan them,
// and an orphan is invisible in every listing that walks the tree.
func (s *Store) Purge(ctx context.Context, taskID string) error {
	normalized := id.Normalize(taskID)

	tx, err := s.begin(ctx, "purge")
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var children int
	row := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM tasks WHERE parent_id = ?`, normalized)
	if err := row.Scan(&children); err != nil {
		return s.notInitialized(fmt.Errorf("sqlite: purge task %s: %w", taskID, err))
	}
	if children > 0 {
		return fmt.Errorf("sqlite: %s still contains %d item(s); purge them too with --recursive: %w",
			taskID, children, store.ErrNotEmpty)
	}

	res, err := tx.ExecContext(ctx, `DELETE FROM tasks WHERE id = ?`, normalized)
	if err != nil {
		return s.notInitialized(fmt.Errorf("sqlite: purge task %s: %w", taskID, err))
	}
	if err := affected(res, taskID, "purge"); err != nil {
		return err
	}
	return s.commit(tx, "purge")
}

// PurgeSubtree removes a task and everything beneath it irreversibly. It
// deletes depth-first so that no row is ever removed while a child still
// points at it, which the foreign key would refuse.
func (s *Store) PurgeSubtree(ctx context.Context, taskID string) (int, error) {
	normalized := id.Normalize(taskID)

	tx, err := s.begin(ctx, "purge")
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	tree, err := s.loadTreeTx(ctx, tx)
	if err != nil {
		return 0, err
	}
	nodes := tree.Subtree(normalized)
	if len(nodes) == 0 {
		return 0, fmt.Errorf("sqlite: %s: %w", taskID, store.ErrNotFound)
	}
	for i := len(nodes) - 1; i >= 0; i-- {
		if _, err := tx.ExecContext(ctx, `DELETE FROM tasks WHERE id = ?`, nodes[i].ID); err != nil {
			return 0, s.notInitialized(fmt.Errorf("sqlite: purge task %s: %w", nodes[i].ID, err))
		}
	}
	if err := s.commit(tx, "purge"); err != nil {
		return 0, err
	}
	return len(nodes), nil
}

func (s *Store) begin(ctx context.Context, op string) (*sql.Tx, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("sqlite: begin %s: %w", op, err)
	}
	return tx, nil
}

func (s *Store) commit(tx *sql.Tx, op string) error {
	if err := tx.Commit(); err != nil {
		return s.notInitialized(fmt.Errorf("sqlite: commit %s: %w", op, err))
	}
	return nil
}

// isUniqueViolation reports whether err is SQLite's primary-key conflict. The
// driver exposes no typed error for it, so the message is matched, in one
// place, and never passed on to the user.
func isUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "unique constraint failed") || strings.Contains(msg, "constraint failed: unique")
}

func affected(res sql.Result, taskID, op string) error {
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("sqlite: %s task %s: %w", op, taskID, err)
	}
	if n == 0 {
		return fmt.Errorf("sqlite: %s: %w", taskID, store.ErrNotFound)
	}
	return nil
}

// normalizedCopy returns a copy of t with its id and parent edge in the
// canonical spelling, so that a caller passing a lower-cased id neither
// writes an unreachable row nor has its own value rewritten underneath it.
func normalizedCopy(t *task.Task) *task.Task {
	c := t.Clone()
	c.ID = id.Normalize(c.ID)
	c.ParentID = id.Normalize(c.ParentID)
	c.SeriesID = id.Normalize(c.SeriesID)
	return c
}

func insertArgs(t *task.Task) ([]any, error) {
	fields, err := marshalFields(t.Fields)
	if err != nil {
		return nil, err
	}
	repeat, err := marshalJSON(t.Repeat, "repeat")
	if err != nil {
		return nil, err
	}
	review, err := marshalJSON(t.ReviewInterval, "review_interval")
	if err != nil {
		return nil, err
	}
	return []any{
		t.ID, string(t.Kind), t.Title, nullString(t.ParentID), t.Position, string(t.Status),
		boolToInt(t.Flagged), boolToInt(t.Sequential), boolToInt(t.CompletedByChildren),
		optionalTime(t.DeferAt), optionalTime(t.DueAt), t.EstimatedMinutes, nullString(t.Note),
		repeat, nullString(t.SeriesID), review, optionalTime(t.LastReviewedAt),
		task.FormatTime(t.CreatedAt), task.FormatTime(t.UpdatedAt),
		optionalTime(t.CompletedAt), optionalTime(t.DroppedAt), optionalTime(t.DeletedAt),
		fields,
	}, nil
}

// writeTags replaces the tag rows for a task. Replacing rather than diffing
// keeps the table a function of the task the caller handed over, which is
// what makes `tdo edit --tag a,b` subtractive as well as additive.
func writeTags(ctx context.Context, tx *sql.Tx, t *task.Task) error {
	if _, err := tx.ExecContext(ctx, `DELETE FROM task_tags WHERE task_id = ?`, t.ID); err != nil {
		return fmt.Errorf("sqlite: replace tags of %s: %w", t.ID, err)
	}
	const q = `INSERT INTO task_tags (task_id, tag, tag_key) VALUES (?, ?, ?)
	           ON CONFLICT(task_id, tag_key) DO UPDATE SET tag = excluded.tag`
	for _, tag := range t.Tags {
		tag = strings.TrimSpace(tag)
		if tag == "" {
			continue
		}
		if _, err := tx.ExecContext(ctx, q, t.ID, tag, strings.ToLower(tag)); err != nil {
			return fmt.Errorf("sqlite: tag %s: %w", t.ID, err)
		}
	}
	return nil
}

// attachTags fills in the tags of one task.
func (s *Store) attachTags(ctx context.Context, t *task.Task) error {
	const q = `SELECT tag FROM task_tags WHERE task_id = ? ORDER BY tag_key`
	rows, err := s.db.QueryContext(ctx, q, t.ID)
	if err != nil {
		return s.notInitialized(fmt.Errorf("sqlite: read tags of %s: %w", t.ID, err))
	}
	defer rows.Close()

	var tags []string
	for rows.Next() {
		var tag string
		if err := rows.Scan(&tag); err != nil {
			return fmt.Errorf("sqlite: read tags of %s: %w", t.ID, err)
		}
		tags = append(tags, tag)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("sqlite: read tags of %s: %w", t.ID, err)
	}
	t.SetTags(tags)
	return nil
}

// scanner is satisfied by both *sql.Row and *sql.Rows.
type scanner interface {
	Scan(dest ...any) error
}

func scanTask(src scanner) (*task.Task, error) {
	var (
		t                   task.Task
		parentID            sql.NullString
		flagged             int
		sequential          int
		completedByChildren int
		deferAt             sql.NullString
		dueAt               sql.NullString
		note                sql.NullString
		repeat              sql.NullString
		seriesID            sql.NullString
		review              sql.NullString
		lastReviewedAt      sql.NullString
		created             string
		updated             string
		completedAt         sql.NullString
		droppedAt           sql.NullString
		deletedAt           sql.NullString
		fields              string
	)
	if err := src.Scan(&t.ID, &t.Kind, &t.Title, &parentID, &t.Position, &t.Status,
		&flagged, &sequential, &completedByChildren, &deferAt, &dueAt, &t.EstimatedMinutes,
		&note, &repeat, &seriesID, &review, &lastReviewedAt, &created, &updated,
		&completedAt, &droppedAt, &deletedAt, &fields); err != nil {
		return nil, err
	}

	var err error
	t.ParentID = parentID.String
	t.Flagged = flagged != 0
	t.Sequential = sequential != 0
	t.CompletedByChildren = completedByChildren != 0
	t.Note = note.String
	t.SeriesID = seriesID.String
	if t.CreatedAt, err = task.ParseTime(created); err != nil {
		return nil, err
	}
	if t.UpdatedAt, err = task.ParseTime(updated); err != nil {
		return nil, err
	}
	for _, slot := range []struct {
		raw  sql.NullString
		into **time.Time
	}{
		{deferAt, &t.DeferAt},
		{dueAt, &t.DueAt},
		{lastReviewedAt, &t.LastReviewedAt},
		{completedAt, &t.CompletedAt},
		{droppedAt, &t.DroppedAt},
		{deletedAt, &t.DeletedAt},
	} {
		if *slot.into, err = parseOptionalTime(slot.raw); err != nil {
			return nil, err
		}
	}
	if repeat.Valid && repeat.String != "" {
		var r task.Repeat
		if err := json.Unmarshal([]byte(repeat.String), &r); err != nil {
			return nil, fmt.Errorf("sqlite: decode repeat of %s: %w", t.ID, err)
		}
		t.Repeat = &r
	}
	if review.Valid && review.String != "" {
		var r task.ReviewInterval
		if err := json.Unmarshal([]byte(review.String), &r); err != nil {
			return nil, fmt.Errorf("sqlite: decode review_interval of %s: %w", t.ID, err)
		}
		t.ReviewInterval = &r
	}
	if t.Fields, err = unmarshalFields(fields); err != nil {
		return nil, err
	}
	t.Tags = []string{}
	return &t, nil
}

// marshalFields renders the user-defined part of a task. An empty map is
// stored as an empty object rather than NULL, so the column is never null.
func marshalFields(f task.Fields) (string, error) {
	if len(f) == 0 {
		return "{}", nil
	}
	b, err := json.Marshal(map[string]any(f))
	if err != nil {
		return "", fmt.Errorf("sqlite: encode fields: %w", err)
	}
	return string(b), nil
}

// marshalJSON renders a small optional object column, NULL when unset.
func marshalJSON(v any, name string) (any, error) {
	switch t := v.(type) {
	case *task.Repeat:
		if t == nil {
			return nil, nil
		}
	case *task.ReviewInterval:
		if t == nil {
			return nil, nil
		}
	}
	b, err := json.Marshal(v)
	if err != nil {
		return nil, fmt.Errorf("sqlite: encode %s: %w", name, err)
	}
	return string(b), nil
}

// unmarshalFields reads the fields column back. Numbers are decoded through
// json.Number so that Fields.Normalize can give each one the Go type the rest
// of the CLI stores — an integer a user wrote comes back as an integer, at any
// depth, because `tdo export | tdo import` has to be lossless for fields this
// binary knows nothing about. The result is never nil.
func unmarshalFields(raw string) (task.Fields, error) {
	if strings.TrimSpace(raw) == "" {
		return task.Fields{}, nil
	}
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.UseNumber()
	var m map[string]any
	if err := dec.Decode(&m); err != nil {
		return nil, fmt.Errorf("sqlite: decode fields: %w", err)
	}
	f := task.Fields(m)
	f.Normalize()
	return f, nil
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func nullString(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func optionalTime(t *time.Time) any {
	if t == nil {
		return nil
	}
	return task.FormatTime(*t)
}

func parseOptionalTime(v sql.NullString) (*time.Time, error) {
	if !v.Valid || v.String == "" {
		return nil, nil
	}
	t, err := task.ParseTime(v.String)
	if err != nil {
		return nil, err
	}
	return &t, nil
}
