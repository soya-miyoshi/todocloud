// Package turso stores tasks in a Turso / libSQL database over the libSQL
// remote protocol.
//
// It mirrors the sqlite provider column for column: only the required fields
// of PLAN.md §3.2 are columns, tags are a join table, and everything a user
// defines lives in one JSON object in the fields column. The two packages are
// deliberately parallel, so that the same behaviour — the ordering, the
// sentinels, the LIKE escaping, the id normalization — is observable
// whichever store a command is pointed at.
//
// The tree rules of §3.1 and the availability computation of §3.3 are not
// written here. They live in internal/store as pure functions over an
// in-memory tree, and this package loads the rows and asks. That is what
// keeps every provider's answer to "is this available?" the same answer, and
// internal/store/storetest is what proves it.
//
// Writing is therefore always two round trips: one that reads the tree, and
// one that sends every statement of the change together. The decision in
// between is Go, not SQL, which is the only way a provider that cannot open a
// transaction over the wire can still refuse exactly what SQLite refuses.
//
// The transport is plain net/http: one POST of a /v2/pipeline request, with
// as many statements batched into it as the operation has, authenticated with
// a bearer token. There is no libSQL driver and no SQLite engine in this
// package, which keeps CGO_ENABLED=0 working and adds no dependency.
//
// What this package cannot do is as important as what it can. It issues
// requests to exactly one URL, the pipeline endpoint of the configured host,
// and executes SQL against the database that host serves. It never calls the
// Turso platform API, so no code path here can create, rename or destroy a
// database.
package turso

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/soya-miyoshi/todocloud/internal/exit"
	"github.com/soya-miyoshi/todocloud/internal/id"
	"github.com/soya-miyoshi/todocloud/internal/providercli"
	"github.com/soya-miyoshi/todocloud/internal/secret"
	"github.com/soya-miyoshi/todocloud/internal/store"
	"github.com/soya-miyoshi/todocloud/internal/task"
)

var _ store.Store = (*Store)(nil)

// Config is everything this provider needs. The token is a secret.Secret, so
// a Config that reaches a log line or --json output discloses nothing.
type Config struct {
	// URL is the database URL, e.g. libsql://example.turso.io. https:// is
	// accepted as the same thing; http:// reaches a self-hosted sqld.
	URL string
	// Token is the per-database auth token. It is sent as a bearer token and
	// is never placed in the URL.
	Token secret.Secret
	// HTTPClient overrides the client used for every request. It is the seam
	// the tests drive an httptest server through; a user never sets it.
	HTTPClient *http.Client
}

// requestTimeout bounds a request made without a deadline of the caller's
// own. Every command is one or two round trips, so a minute is generous.
const requestTimeout = 60 * time.Second

// probeTimeout bounds the one request OpenExisting makes. Open takes no
// context — the Store interface's methods carry them — so the schema probe
// uses a background context with this deadline.
const probeTimeout = 30 * time.Second

// Store is a Turso-backed task store.
type Store struct {
	client   *client
	database string

	// version is the schema version last seen in the meta table, and
	// versionKnown says whether anything has looked yet. OpenExisting reads
	// the row to prove the database is initialized, so by the time a
	// command runs, CheckSchema can answer from this without a second round
	// trip.
	version      int
	versionKnown bool
}

// Open prepares a store against the configured database. It is the entry
// point `tdo init` uses: it does not require a schema to be present, because
// Init is what puts one there.
//
// Opening performs no request. Nothing exists to create remotely — the
// database the URL names either exists or it does not, and this package never
// creates one — so a bad URL surfaces on the first command rather than here.
func Open(cfg Config) (*Store, error) {
	endpoint, host, err := endpointFor(cfg.URL)
	if err != nil {
		return nil, exit.Configf(err)
	}
	httpClient, owned := cfg.HTTPClient, false
	if httpClient == nil {
		httpClient = &http.Client{Timeout: requestTimeout}
		owned = true
	}
	return &Store{
		client: &client{
			endpoint: endpoint,
			host:     host,
			token:    cfg.Token,
			http:     httpClient,
			owned:    owned,
		},
		database: databaseName(cfg.URL, host),
	}, nil
}

// OpenExisting opens a store that must already hold a schema. It is what
// every command other than `tdo init` uses, and it creates nothing: the one
// request it makes is a read of the meta table.
//
// A database with no schema is reported as store.ErrNotInitialized, so that
// pointing the CLI at the wrong database fails with the advice to run
// `tdo init` instead of quietly growing a second, parallel task list.
//
// The probe reads the version, not merely the presence of the row, and the
// store keeps it: CheckSchema then costs nothing, which is what lets every
// command check the version rather than only `tdo doctor` and `tdo migrate`.
// A version this binary does not understand is deliberately not refused
// here — `tdo migrate` has to be able to open exactly that store.
func OpenExisting(cfg Config) (*Store, error) {
	s, err := Open(cfg)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()
	if _, err := s.SchemaVersion(ctx); err != nil {
		s.Close()
		return nil, err
	}
	return s, nil
}

// databaseName recovers the database's name from its URL, for Describe. The
// host is the fallback whenever the name cannot be read confidently; both are
// public information, neither is a credential.
func databaseName(rawURL, host string) string {
	if name, ok := providercli.DatabaseFromURL(rawURL); ok {
		return name
	}
	return host
}

// Describe names the database and nothing else. No token, no query string,
// nothing that would be unsafe in `tdo config` output or in a bug report.
func (s *Store) Describe() string {
	return fmt.Sprintf("turso database %q", s.database)
}

// Ping checks that the database is reachable and initialized.
func (s *Store) Ping(ctx context.Context) error {
	_, err := s.SchemaVersion(ctx)
	return err
}

// Close releases what there is to release. There is no connection to tear
// down — each command is a request or two — so it only drops idle
// connections, and only from a client this package created. It is safe to
// call twice.
func (s *Store) Close() error {
	if s.client == nil {
		return nil
	}
	c := s.client
	s.client = nil
	if c.owned && c.http != nil {
		c.http.CloseIdleConnections()
	}
	return nil
}

// errClosed is returned by a method called after Close, instead of a nil
// pointer dereference.
var errClosed = errors.New("turso: the store is closed")

// batch collects the statements of one pipeline. It carries the first binding
// failure rather than returning one per call, so that building a multi-
// statement operation reads as a list of statements and not as a ladder of
// error checks.
type batch struct {
	stmts []statement
	err   error
}

func (b *batch) add(sql string, wantRows bool, args ...any) {
	if b.err != nil {
		return
	}
	st, err := newStatement(sql, wantRows, args...)
	if err != nil {
		b.err = fmt.Errorf("turso: %w", err)
		return
	}
	b.stmts = append(b.stmts, st)
}

// len reports how many statements are queued, which is also the index the
// next one will have in the results.
func (b *batch) len() int { return len(b.stmts) }

// send executes a batch in one round trip and returns one result per
// statement, in order.
func (s *Store) send(ctx context.Context, b *batch) ([]*executeResult, error) {
	if s.client == nil {
		return nil, errClosed
	}
	if b.err != nil {
		return nil, b.err
	}
	return s.client.pipeline(ctx, b.stmts...)
}

// exec runs one statement and returns its result.
func (s *Store) exec(ctx context.Context, sql string, wantRows bool, args ...any) (*executeResult, error) {
	var b batch
	b.add(sql, wantRows, args...)
	out, err := s.send(ctx, &b)
	if err != nil {
		return nil, err
	}
	return out[0], nil
}

const columns = `id, kind, title, parent_id, position, status, flagged, sequential,
	completed_by_children, defer_at, due_at, estimated_minutes, note, repeat, series_id,
	review_interval, last_reviewed_at, created_at, updated_at, completed_at, dropped_at,
	deleted_at, fields`

const columnCount = 23

const placeholders = `?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?`

const insertSQL = `INSERT INTO tasks (` + columns + `) VALUES (` + placeholders + `)`

const updateSQL = `UPDATE tasks SET kind = ?, title = ?, parent_id = ?, position = ?, status = ?,
	           flagged = ?, sequential = ?, completed_by_children = ?, defer_at = ?, due_at = ?,
	           estimated_minutes = ?, note = ?, repeat = ?, series_id = ?, review_interval = ?,
	           last_reviewed_at = ?, created_at = ?, updated_at = ?, completed_at = ?,
	           dropped_at = ?, deleted_at = ?, fields = ? WHERE id = ?`

// Add inserts a new task with its tags. A duplicate id is store.ErrExists
// rather than a silent overwrite, so a generator bug cannot destroy data.
//
// The tree is read first. There is no transaction over the wire, so the
// placement rules of §3.1 and the duplicate check are decided here, before
// anything is written: a pipeline whose first statement fails still runs the
// rest, and a tag row written beside a refused insert would attach itself to
// whatever already holds that id.
func (s *Store) Add(ctx context.Context, t *task.Task) error {
	// Every lookup normalises the id, so an id stored in another case would
	// be unreachable afterwards. Normalising on the way in keeps the store's
	// one copy of an id canonical, and the same goes for the edges it carries.
	t = normalizedCopy(t)
	if err := t.Validate(); err != nil {
		return fmt.Errorf("turso: add task %s: %w", t.ID, err)
	}

	tree, err := s.loadTree(ctx)
	if err != nil {
		return err
	}
	if _, exists := tree.Get(t.ID); exists {
		// The caller decides what a duplicate means — `tdo import` skips it —
		// so report the sentinel, never the engine's constraint message.
		return fmt.Errorf("turso: %s: %w", t.ID, store.ErrExists)
	}
	if err := checkPlacement(tree, t); err != nil {
		return err
	}

	args, err := insertArgs(t)
	if err != nil {
		return err
	}
	var b batch
	b.add(insertSQL, false, args...)
	writeTags(&b, t)
	if _, err := s.send(ctx, &b); err != nil {
		if isUniqueViolation(err) {
			// The tree read above missed a concurrent writer. The answer is
			// still the sentinel and never the engine's message.
			return fmt.Errorf("turso: %s: %w", t.ID, store.ErrExists)
		}
		return s.wrap(err, "add task "+t.ID)
	}
	return nil
}

// Update replaces every column of the task with this id, tags included.
func (s *Store) Update(ctx context.Context, t *task.Task) error {
	t = normalizedCopy(t)
	if err := t.Validate(); err != nil {
		return fmt.Errorf("turso: update task %s: %w", t.ID, err)
	}

	tree, err := s.loadTree(ctx)
	if err != nil {
		return err
	}
	if _, exists := tree.Get(t.ID); !exists {
		return fmt.Errorf("turso: %s: %w", t.ID, store.ErrNotFound)
	}
	if err := checkPlacement(tree, t); err != nil {
		return err
	}

	args, err := insertArgs(t)
	if err != nil {
		return err
	}
	var b batch
	// insertArgs puts the id first; the UPDATE wants it last.
	b.add(updateSQL, false, append(append([]any{}, args[1:]...), args[0])...)
	writeTags(&b, t)
	// "Complete with last action" (§3.2's completed_by_children). The rule is
	// the shared one in store.AutoComplete; this provider only asks it and
	// writes the answer. There is no transaction over the wire, so it is
	// asked about the tree this update is about to produce, and the container
	// updates travel in the same pipeline as the update that caused them.
	if store.TriggersAutoCompletion(t) {
		for _, container := range store.AutoComplete(tree.WithUpdated(t), t.ID, t.UpdatedAt) {
			cargs, err := insertArgs(container)
			if err != nil {
				return err
			}
			b.add(updateSQL, false, append(append([]any{}, cargs[1:]...), cargs[0])...)
		}
	}
	if _, err := s.send(ctx, &b); err != nil {
		return s.wrap(err, "update task "+t.ID)
	}
	return nil
}

// Move reparents a task and sets its position, touching nothing else but
// updated_at. It is the one operation that exists so a caller does not have
// to read, edit and write back a whole task to drag it somewhere.
func (s *Store) Move(ctx context.Context, taskID, parentID string, position int, now time.Time) error {
	taskID = id.Normalize(taskID)
	parentID = id.Normalize(parentID)

	tree, err := s.loadTree(ctx)
	if err != nil {
		return err
	}
	current, ok := tree.Get(taskID)
	if !ok {
		return fmt.Errorf("turso: %s: %w", taskID, store.ErrNotFound)
	}
	moved := current.Clone()
	moved.ParentID = parentID
	moved.Position = position
	if err := checkPlacement(tree, moved); err != nil {
		return err
	}

	const q = `UPDATE tasks SET parent_id = ?, position = ?, updated_at = ? WHERE id = ?`
	if _, err := s.exec(ctx, q, false, nullString(parentID), position, task.FormatTime(now), taskID); err != nil {
		return s.wrap(err, "move task "+taskID)
	}
	return nil
}

// checkPlacement enforces the tree rules of §3.1 for the placement t
// describes, over the snapshot the caller read: the parent must exist, its
// kind must be allowed to contain this one, and the parent must not be t
// itself or one of its descendants.
//
// The table and the cycle rule are the shared ones, so that this provider
// cannot drift from SQLite about what a legal tree is.
func checkPlacement(tree *store.Tree, t *task.Task) error {
	if t.ParentID == "" {
		return nil
	}
	if t.ParentID == t.ID {
		return store.CycleError(t.ID, t.ParentID)
	}
	parent, ok := tree.Get(t.ParentID)
	if !ok {
		return fmt.Errorf("turso: parent %s: %w", t.ParentID, store.ErrNotFound)
	}
	if err := store.CheckParent(t.Kind, parent); err != nil {
		return fmt.Errorf("turso: %w", err)
	}
	// Moving an item under one of its own descendants would cut its branch
	// loose from the root.
	if tree.HasDescendant(t.ID, t.ParentID) {
		return store.CycleError(t.ID, t.ParentID)
	}
	return nil
}

// Get returns the task with exactly this id, tombstoned or not. The row and
// its tags travel in one pipeline, so a read is one round trip.
func (s *Store) Get(ctx context.Context, taskID string) (*task.Task, error) {
	normalized := id.Normalize(taskID)

	var b batch
	b.add(`SELECT `+columns+` FROM tasks WHERE id = ?`, true, normalized)
	b.add(`SELECT task_id, tag FROM task_tags WHERE task_id = ? ORDER BY tag_key`, true, normalized)
	res, err := s.send(ctx, &b)
	if err != nil {
		return nil, s.wrap(err, "get task "+taskID)
	}
	if len(res[0].Rows) == 0 {
		return nil, fmt.Errorf("turso: %s: %w", taskID, store.ErrNotFound)
	}
	t, err := scanTask(res[0].Rows[0])
	if err != nil {
		return nil, fmt.Errorf("turso: get task %s: %w", taskID, err)
	}
	if err := attachTags([]*task.Task{t}, res[1]); err != nil {
		return nil, fmt.Errorf("turso: get task %s: %w", taskID, err)
	}
	return t, nil
}

// FindByPrefix returns the single task whose id starts with prefix. It reads
// at most two rows, because two is all it takes to know the prefix is
// ambiguous, and it asks for the matching tags in the same pipeline.
func (s *Store) FindByPrefix(ctx context.Context, prefix string) (*task.Task, error) {
	pattern := escapeLike(id.Normalize(prefix)) + "%"

	var b batch
	b.add(`SELECT `+columns+` FROM tasks WHERE id LIKE ? ESCAPE '\' ORDER BY id LIMIT 2`, true, pattern)
	b.add(`SELECT task_id, tag FROM task_tags WHERE task_id LIKE ? ESCAPE '\' ORDER BY task_id, tag_key`, true, pattern)
	res, err := s.send(ctx, &b)
	if err != nil {
		return nil, s.wrap(err, "find task "+prefix)
	}
	switch len(res[0].Rows) {
	case 0:
		return nil, fmt.Errorf("turso: %s: %w", prefix, store.ErrNotFound)
	case 1:
		t, err := scanTask(res[0].Rows[0])
		if err != nil {
			return nil, fmt.Errorf("turso: find task %s: %w", prefix, err)
		}
		if err := attachTags([]*task.Task{t}, res[1]); err != nil {
			return nil, fmt.Errorf("turso: find task %s: %w", prefix, err)
		}
		return t, nil
	default:
		return nil, fmt.Errorf("turso: %s: %w", prefix, store.ErrAmbiguous)
	}
}

// escapeLike neutralises the LIKE wildcards. An id prefix cannot contain
// them, but the caller is not required to have validated one, so `%` must
// match a literal percent sign and nothing else.
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

	tree, err := s.loadTree(ctx)
	if err != nil {
		return err
	}
	if _, ok := tree.Get(normalized); !ok {
		return fmt.Errorf("turso: %s: %w", taskID, store.ErrNotFound)
	}
	if n := len(tree.Children(normalized)); n > 0 {
		return fmt.Errorf("turso: %s still contains %d item(s); purge them too with --recursive: %w",
			taskID, n, store.ErrNotEmpty)
	}

	var b batch
	deleteTask(&b, normalized)
	if _, err := s.send(ctx, &b); err != nil {
		return s.wrap(err, "purge task "+taskID)
	}
	return nil
}

// PurgeSubtree removes a task and everything beneath it irreversibly. The
// deletes are sent depth-first in one pipeline, so that no row is removed
// while a child still points at it — a foreign key that is switched on would
// refuse that, and a half-deleted subtree would be worse than a slow one.
func (s *Store) PurgeSubtree(ctx context.Context, taskID string) (int, error) {
	normalized := id.Normalize(taskID)

	tree, err := s.loadTree(ctx)
	if err != nil {
		return 0, err
	}
	nodes := tree.Subtree(normalized)
	if len(nodes) == 0 {
		return 0, fmt.Errorf("turso: %s: %w", taskID, store.ErrNotFound)
	}

	var b batch
	for i := len(nodes) - 1; i >= 0; i-- {
		deleteTask(&b, nodes[i].ID)
	}
	if _, err := s.send(ctx, &b); err != nil {
		return 0, s.wrap(err, "purge task "+taskID)
	}
	return len(nodes), nil
}

// deleteTask queues the removal of one row and its tags. The tag rows are
// deleted explicitly rather than left to ON DELETE CASCADE: a remote
// connection need not have foreign keys switched on, and a tag row pointing
// at a purged task would keep counting in `tdo tags`.
func deleteTask(b *batch, taskID string) {
	b.add(`DELETE FROM task_tags WHERE task_id = ?`, false, taskID)
	b.add(`DELETE FROM tasks WHERE id = ?`, false, taskID)
}

// writeTags queues the tag rows of a task, replacing whatever is there.
// Replacing rather than diffing keeps the table a function of the task the
// caller handed over, which is what makes `tdo edit --tag a,b` subtractive as
// well as additive.
func writeTags(b *batch, t *task.Task) {
	b.add(`DELETE FROM task_tags WHERE task_id = ?`, false, t.ID)
	const q = `INSERT INTO task_tags (task_id, tag, tag_key) VALUES (?, ?, ?)
	           ON CONFLICT(task_id, tag_key) DO UPDATE SET tag = excluded.tag`
	// A tag used for the first time gets a row of its own, active, so that
	// `tdo tag ls` and `tdo tag hold` can reach it. DO NOTHING on conflict:
	// a tag that already has a status must not be reset to active by
	// someone tagging a task with it.
	const row = `INSERT INTO tags (tag_key, tag, status, created_at, updated_at)
	           VALUES (?, ?, 'active', ?, ?) ON CONFLICT(tag_key) DO NOTHING`
	stamp := task.FormatTime(t.UpdatedAt)
	for _, tag := range t.Tags {
		tag = strings.TrimSpace(tag)
		if tag == "" {
			continue
		}
		key := strings.ToLower(tag)
		b.add(q, false, t.ID, tag, key)
		b.add(row, false, key, tag, stamp, stamp)
	}
}

// attachTags fills in the tags of the given tasks from a (task_id, tag)
// result, which the caller asked for in the same pipeline as the rows.
func attachTags(tasks []*task.Task, res *executeResult) error {
	byTask := make(map[string][]string, len(tasks))
	for _, row := range res.Rows {
		if len(row) != 2 {
			return fmt.Errorf("a tag row came back with %d column(s), want 2", len(row))
		}
		taskID, err := text(row[0], "task_id")
		if err != nil {
			return err
		}
		tag, err := text(row[1], "tag")
		if err != nil {
			return err
		}
		byTask[taskID] = append(byTask[taskID], tag)
	}
	for _, t := range tasks {
		t.SetTags(byTask[t.ID])
	}
	return nil
}

// wrap gives a failed statement its context and classifies it.
//
// A missing tasks table means the database holds no schema, which is a
// configuration problem with a known remedy, not a provider failure; it is
// reported as store.ErrNotInitialized and the engine's "no such table: tasks"
// never reaches the user. Everything else the remote engine refused is a
// provider error, so it exits 4.
func (s *Store) wrap(err error, what string) error {
	if err == nil {
		return nil
	}
	if missingTable(err) {
		return fmt.Errorf("turso: %s: %w", s.database, store.ErrNotInitialized)
	}
	var remote *remoteError
	if errors.As(err, &remote) {
		return exit.Providerf(fmt.Errorf("turso: %s: %w", what, err))
	}
	return fmt.Errorf("turso: %s: %w", what, err)
}

// missingTable reports whether err is the engine's complaint about a table
// that does not exist. libSQL offers no distinct code for it, so the message
// is matched — in one place, and never passed on to the user.
func missingTable(err error) bool {
	var remote *remoteError
	if !errors.As(err, &remote) {
		return false
	}
	return strings.Contains(strings.ToLower(remote.message()), "no such table")
}

// isUniqueViolation reports whether err is the primary-key conflict. Both the
// SQLITE_CONSTRAINT_* code and the message are matched, because servers
// differ in which of the two they fill in.
func isUniqueViolation(err error) bool {
	var remote *remoteError
	if !errors.As(err, &remote) {
		return false
	}
	msg := strings.ToLower(remote.message())
	return strings.Contains(msg, "unique constraint failed") ||
		strings.Contains(msg, "constraint failed: unique") ||
		strings.Contains(msg, "sqlite_constraint_primarykey") ||
		strings.Contains(msg, "sqlite_constraint_unique")
}

// normalizedCopy returns a copy of t with its id and its id-valued edges in
// the canonical spelling, so that a caller passing a lower-cased id neither
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

// scanTask reads one row of the column list above. Every malformed column is
// an error rather than a zero value: a task that came back with no title
// should be a failed command, not a blank line.
func scanTask(row []value) (*task.Task, error) {
	if len(row) != columnCount {
		return nil, fmt.Errorf("a row came back with %d column(s), want %d", len(row), columnCount)
	}
	var (
		t   task.Task
		err error
	)
	if t.ID, err = text(row[0], "id"); err != nil {
		return nil, err
	}
	kind, err := text(row[1], "kind")
	if err != nil {
		return nil, err
	}
	t.Kind = task.Kind(kind)
	if t.Title, err = text(row[2], "title"); err != nil {
		return nil, err
	}
	if t.ParentID, err = optionalText(row[3], "parent_id"); err != nil {
		return nil, err
	}
	position, err := integer(row[4], "position")
	if err != nil {
		return nil, err
	}
	t.Position = int(position)
	status, err := text(row[5], "status")
	if err != nil {
		return nil, err
	}
	t.Status = task.Status(status)
	for _, flag := range []struct {
		column string
		raw    value
		into   *bool
	}{
		{"flagged", row[6], &t.Flagged},
		{"sequential", row[7], &t.Sequential},
		{"completed_by_children", row[8], &t.CompletedByChildren},
	} {
		n, err := integer(flag.raw, flag.column)
		if err != nil {
			return nil, err
		}
		*flag.into = n != 0
	}
	estimated, err := integer(row[11], "estimated_minutes")
	if err != nil {
		return nil, err
	}
	t.EstimatedMinutes = int(estimated)
	if t.Note, err = optionalText(row[12], "note"); err != nil {
		return nil, err
	}
	if t.SeriesID, err = optionalText(row[14], "series_id"); err != nil {
		return nil, err
	}

	created, err := text(row[17], "created_at")
	if err != nil {
		return nil, err
	}
	if t.CreatedAt, err = task.ParseTime(created); err != nil {
		return nil, err
	}
	updated, err := text(row[18], "updated_at")
	if err != nil {
		return nil, err
	}
	if t.UpdatedAt, err = task.ParseTime(updated); err != nil {
		return nil, err
	}
	for _, slot := range []struct {
		column string
		raw    value
		into   **time.Time
	}{
		{"defer_at", row[9], &t.DeferAt},
		{"due_at", row[10], &t.DueAt},
		{"last_reviewed_at", row[16], &t.LastReviewedAt},
		{"completed_at", row[19], &t.CompletedAt},
		{"dropped_at", row[20], &t.DroppedAt},
		{"deleted_at", row[21], &t.DeletedAt},
	} {
		if *slot.into, err = optionalColumn(slot.raw, slot.column); err != nil {
			return nil, err
		}
	}

	repeat, err := optionalText(row[13], "repeat")
	if err != nil {
		return nil, err
	}
	if repeat != "" {
		var r task.Repeat
		if err := json.Unmarshal([]byte(repeat), &r); err != nil {
			return nil, fmt.Errorf("decode the repeat of %s: %w", t.ID, err)
		}
		t.Repeat = &r
	}
	review, err := optionalText(row[15], "review_interval")
	if err != nil {
		return nil, err
	}
	if review != "" {
		var r task.ReviewInterval
		if err := json.Unmarshal([]byte(review), &r); err != nil {
			return nil, fmt.Errorf("decode the review interval of %s: %w", t.ID, err)
		}
		t.ReviewInterval = &r
	}

	raw, err := optionalText(row[22], "fields")
	if err != nil {
		return nil, err
	}
	if t.Fields, err = unmarshalFields(raw); err != nil {
		return nil, err
	}
	t.Tags = []string{}
	return &t, nil
}

func text(v value, column string) (string, error) {
	if v.IsNull() {
		return "", fmt.Errorf("the %s column is null", column)
	}
	s, ok := v.Text()
	if !ok {
		return "", fmt.Errorf("the %s column is not text", column)
	}
	return s, nil
}

// optionalText reads a nullable text column, with NULL as the empty string:
// the Go side of every one of them is a string whose zero value means unset.
func optionalText(v value, column string) (string, error) {
	if v.IsNull() {
		return "", nil
	}
	return text(v, column)
}

func integer(v value, column string) (int64, error) {
	if v.IsNull() {
		return 0, fmt.Errorf("the %s column is null", column)
	}
	n, ok := v.Int64()
	if !ok {
		return 0, fmt.Errorf("the %s column is not an integer", column)
	}
	return n, nil
}

func optionalColumn(v value, column string) (*time.Time, error) {
	s, err := optionalText(v, column)
	if err != nil || s == "" {
		return nil, err
	}
	parsed, err := task.ParseTime(s)
	if err != nil {
		return nil, err
	}
	return &parsed, nil
}

// marshalFields renders the user-defined part of a task. An empty map is
// stored as an empty object rather than NULL, so the column is never null.
func marshalFields(f task.Fields) (string, error) {
	if len(f) == 0 {
		return "{}", nil
	}
	b, err := json.Marshal(map[string]any(f))
	if err != nil {
		return "", fmt.Errorf("turso: encode fields: %w", err)
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
		return nil, fmt.Errorf("turso: encode %s: %w", name, err)
	}
	return string(b), nil
}

// unmarshalFields reads the fields column back. Numbers are decoded through
// json.Number so that Fields.Normalize can give each one the Go type the rest
// of the CLI stores — an integer a user wrote comes back as an integer, at any
// depth and across the whole int64 range, because `tdo export | tdo import`
// has to be lossless for fields this binary knows nothing about. The result is
// never nil.
func unmarshalFields(raw string) (task.Fields, error) {
	if strings.TrimSpace(raw) == "" {
		return task.Fields{}, nil
	}
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.UseNumber()
	var m map[string]any
	if err := dec.Decode(&m); err != nil {
		return nil, fmt.Errorf("decode fields: %w", err)
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
