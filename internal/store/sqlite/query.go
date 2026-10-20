package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/soya-miyoshi/todocloud/internal/id"
	"github.com/soya-miyoshi/todocloud/internal/store"
	"github.com/soya-miyoshi/todocloud/internal/task"
)

// List returns the tasks matching f, sorted as f requests.
//
// The query narrows the rows — the tag filter in particular is a join and not
// a scan, which is the whole reason tags are their own table — and the shared
// matcher in internal/store then decides. Deciding twice costs one pass over
// a handful of rows and buys the guarantee the conformance suite is about:
// whatever this provider pushes down, the answer is the one the definition
// gives.
func (s *Store) List(ctx context.Context, f store.Filter) ([]*task.Task, error) {
	if err := f.Validate(); err != nil {
		return nil, fmt.Errorf("sqlite: list tasks: %w", err)
	}
	where, args := pushDown(f)
	candidates, err := s.query(ctx, where, args)
	if err != nil {
		return nil, err
	}

	// Availability, a subtree scope and tree order are questions about the
	// whole tree, and the ancestors of a matching row need not match
	// themselves, so they cannot be answered from the rows selected above.
	var tree *store.Tree
	if f.NeedsTree() {
		if tree, err = s.loadTree(ctx); err != nil {
			return nil, err
		}
	}

	out := make([]*task.Task, 0, len(candidates))
	for _, t := range candidates {
		if f.Matches(t, tree) {
			out = append(out, t)
		}
	}
	var pathOf func(*task.Task) []string
	if tree != nil {
		pathOf = tree.SortKey
	}
	store.SortTasks(out, f.Order, pathOf)
	if f.Limit > 0 && len(out) > f.Limit {
		out = out[:f.Limit]
	}
	return out, nil
}

// pushDown builds the WHERE clause for the parts of a filter that are a
// property of the row alone. Everything it leaves out is decided by
// store.Filter.Matches afterwards, so an omission here is a slow query and
// never a wrong one.
func pushDown(f store.Filter) (where []string, args []any) {
	switch {
	case f.OnlyDeleted:
		where = append(where, `deleted_at IS NOT NULL`)
	case !f.IncludeDeleted:
		where = append(where, `deleted_at IS NULL`)
	}
	if len(f.Kinds) > 0 {
		for _, k := range f.Kinds {
			args = append(args, string(k))
		}
		where = append(where, `kind `+inClause(len(f.Kinds)))
	}
	if len(f.Statuses) > 0 {
		clause := inClause(len(f.Statuses))
		for _, st := range f.Statuses {
			args = append(args, string(st))
		}
		where = append(where, `status `+clause)
	}
	if f.Flagged != nil {
		where = append(where, `flagged = ?`)
		args = append(args, boolToInt(*f.Flagged))
	}
	if f.Scope.Inbox {
		where = append(where, `kind = 'task' AND parent_id IS NULL`)
	}
	if f.Scope.Children {
		if f.Scope.ParentID == "" {
			where = append(where, `parent_id IS NULL`)
		} else {
			where = append(where, `parent_id = ?`)
			args = append(args, id.Normalize(f.Scope.ParentID))
		}
	}
	if f.HasDue != nil {
		if *f.HasDue {
			where = append(where, `due_at IS NOT NULL`)
		} else {
			where = append(where, `due_at IS NULL`)
		}
	}
	// Timestamps are stored in the fixed-width RFC 3339 form, so comparing
	// them as text is chronological.
	for _, w := range []struct {
		at     *time.Time
		clause string
	}{
		{f.DeferBefore, `defer_at IS NOT NULL AND defer_at < ?`},
		{f.DeferAfter, `defer_at IS NOT NULL AND defer_at > ?`},
		{f.DueBefore, `due_at IS NOT NULL AND due_at < ?`},
		{f.DueAfter, `due_at IS NOT NULL AND due_at > ?`},
	} {
		if w.at != nil {
			where = append(where, w.clause)
			args = append(args, task.FormatTime(*w.at))
		}
	}
	if len(f.Tags) > 0 {
		keys := make([]any, 0, len(f.Tags))
		for _, tag := range f.Tags {
			tag = strings.TrimSpace(tag)
			if tag == "" {
				continue
			}
			keys = append(keys, strings.ToLower(tag))
		}
		if len(keys) > 0 {
			clause := inClause(len(keys))
			sub := `SELECT COUNT(DISTINCT tag_key) FROM task_tags WHERE task_id = tasks.id AND tag_key ` + clause
			if f.TagsAny {
				where = append(where, `(`+sub+`) > 0`)
			} else {
				where = append(where, `(`+sub+`) = `+fmt.Sprint(len(keys)))
			}
			args = append(args, keys...)
		}
	}
	return where, args
}

// inClause renders an IN list of n placeholders. The values are always
// bound, never interpolated: nothing a user types reaches the SQL text.
func inClause(n int) string {
	return "IN (" + strings.TrimSuffix(strings.Repeat("?,", n), ",") + ")"
}

// query runs a tasks SELECT and attaches the tags of every row it returns.
func (s *Store) query(ctx context.Context, where []string, args []any) ([]*task.Task, error) {
	q := `SELECT ` + columns + ` FROM tasks`
	if len(where) > 0 {
		q += ` WHERE (` + strings.Join(where, `) AND (`) + `)`
	}
	q += ` ORDER BY id`

	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, s.notInitialized(fmt.Errorf("sqlite: list tasks: %w", err))
	}
	defer rows.Close()

	var out []*task.Task
	for rows.Next() {
		t, err := scanTask(rows)
		if err != nil {
			return nil, fmt.Errorf("sqlite: list tasks: %w", err)
		}
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("sqlite: list tasks: %w", err)
	}
	if err := s.attachAllTags(ctx, out); err != nil {
		return nil, err
	}
	return out, nil
}

// attachAllTags fills in the tags of a whole listing with one query, rather
// than one per row.
func (s *Store) attachAllTags(ctx context.Context, tasks []*task.Task) error {
	if len(tasks) == 0 {
		return nil
	}
	const q = `SELECT task_id, tag FROM task_tags ORDER BY task_id, tag_key`
	rows, err := s.db.QueryContext(ctx, q)
	if err != nil {
		return s.notInitialized(fmt.Errorf("sqlite: read tags: %w", err))
	}
	defer rows.Close()

	byTask := make(map[string][]string)
	for rows.Next() {
		var taskID, tag string
		if err := rows.Scan(&taskID, &tag); err != nil {
			return fmt.Errorf("sqlite: read tags: %w", err)
		}
		byTask[taskID] = append(byTask[taskID], tag)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("sqlite: read tags: %w", err)
	}
	for _, t := range tasks {
		t.SetTags(byTask[t.ID])
	}
	return nil
}

// loadTree reads every row into an in-memory tree. Tags are left off: no rule
// in §3.1 or §3.3 depends on them, and this is read on every listing that
// asks about availability.
func (s *Store) loadTree(ctx context.Context) (*store.Tree, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+columns+` FROM tasks`)
	if err != nil {
		return nil, s.notInitialized(fmt.Errorf("sqlite: read tree: %w", err))
	}
	return treeFrom(rows)
}

func (s *Store) loadTreeTx(ctx context.Context, tx *sql.Tx) (*store.Tree, error) {
	rows, err := tx.QueryContext(ctx, `SELECT `+columns+` FROM tasks`)
	if err != nil {
		return nil, s.notInitialized(fmt.Errorf("sqlite: read tree: %w", err))
	}
	return treeFrom(rows)
}

func treeFrom(rows *sql.Rows) (*store.Tree, error) {
	defer rows.Close()
	var all []*task.Task
	for rows.Next() {
		t, err := scanTask(rows)
		if err != nil {
			return nil, fmt.Errorf("sqlite: read tree: %w", err)
		}
		all = append(all, t)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("sqlite: read tree: %w", err)
	}
	return store.NewTree(all), nil
}

// Children returns the direct children of parentID in tree order. An empty
// parentID returns the top level.
func (s *Store) Children(ctx context.Context, parentID string) ([]*task.Task, error) {
	f := store.Filter{
		Scope:          store.Scope{Children: true, ParentID: id.Normalize(parentID)},
		IncludeDeleted: true,
	}
	return s.List(ctx, f)
}

// Subtree returns id and everything beneath it, in pre-order.
func (s *Store) Subtree(ctx context.Context, taskID string) ([]*task.Task, error) {
	normalized := id.Normalize(taskID)
	tree, err := s.loadTree(ctx)
	if err != nil {
		return nil, err
	}
	nodes := tree.Subtree(normalized)
	if len(nodes) == 0 {
		return nil, fmt.Errorf("sqlite: %s: %w", taskID, store.ErrNotFound)
	}
	if err := s.attachAllTags(ctx, nodes); err != nil {
		return nil, err
	}
	return nodes, nil
}

// Availability computes §3.3 for each id over the whole tree.
func (s *Store) Availability(ctx context.Context, now time.Time, ids ...string) (map[string]store.Availability, error) {
	if len(ids) == 0 {
		return map[string]store.Availability{}, nil
	}
	tree, err := s.loadTree(ctx)
	if err != nil {
		return nil, err
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	normalized := make([]string, 0, len(ids))
	for _, raw := range ids {
		normalized = append(normalized, id.Normalize(raw))
	}
	return tree.AvailabilityOf(now, normalized...), nil
}

// Tags returns every tag in use on a live task with its count, sorted by
// name. Tombstoned tasks are left out: a tag whose only task is in the bin is
// not a tag the user still files things under.
func (s *Store) Tags(ctx context.Context) ([]store.TagCount, error) {
	const q = `SELECT MIN(tt.tag), COUNT(*) FROM task_tags tt
	           JOIN tasks t ON t.id = tt.task_id
	           WHERE t.deleted_at IS NULL
	           GROUP BY tt.tag_key ORDER BY tt.tag_key`
	rows, err := s.db.QueryContext(ctx, q)
	if err != nil {
		return nil, s.notInitialized(fmt.Errorf("sqlite: list tags: %w", err))
	}
	defer rows.Close()

	out := []store.TagCount{}
	for rows.Next() {
		var tc store.TagCount
		if err := rows.Scan(&tc.Name, &tc.Count); err != nil {
			return nil, fmt.Errorf("sqlite: list tags: %w", err)
		}
		out = append(out, tc)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("sqlite: list tags: %w", err)
	}
	return out, nil
}

// SavePerspective stores a perspective, replacing one of the same name.
func (s *Store) SavePerspective(ctx context.Context, p *store.Perspective) error {
	name := strings.TrimSpace(p.Name)
	if name == "" {
		return errors.New("sqlite: a perspective needs a name")
	}
	if err := p.Filter.Validate(); err != nil {
		return fmt.Errorf("sqlite: save perspective %s: %w", name, err)
	}
	filter, err := json.Marshal(p.Filter)
	if err != nil {
		return fmt.Errorf("sqlite: encode perspective %s: %w", name, err)
	}
	created := p.CreatedAt
	if created.IsZero() {
		created = p.UpdatedAt
	}
	const q = `INSERT INTO perspectives (name_key, name, filter, created_at, updated_at)
	           VALUES (?, ?, ?, ?, ?)
	           ON CONFLICT(name_key) DO UPDATE SET
	             name = excluded.name, filter = excluded.filter, updated_at = excluded.updated_at`
	_, err = s.db.ExecContext(ctx, q, strings.ToLower(name), name, string(filter),
		task.FormatTime(created), task.FormatTime(p.UpdatedAt))
	if err != nil {
		return s.notInitialized(fmt.Errorf("sqlite: save perspective %s: %w", name, err))
	}
	return nil
}

// Perspective returns one by name, or store.ErrNotFound.
func (s *Store) Perspective(ctx context.Context, name string) (*store.Perspective, error) {
	const q = `SELECT name, filter, created_at, updated_at FROM perspectives WHERE name_key = ?`
	row := s.db.QueryRowContext(ctx, q, strings.ToLower(strings.TrimSpace(name)))
	p, err := scanPerspective(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("sqlite: perspective %s: %w", name, store.ErrNotFound)
	}
	if err != nil {
		return nil, s.notInitialized(fmt.Errorf("sqlite: read perspective %s: %w", name, err))
	}
	return p, nil
}

// Perspectives returns all of them, sorted by name.
func (s *Store) Perspectives(ctx context.Context) ([]*store.Perspective, error) {
	const q = `SELECT name, filter, created_at, updated_at FROM perspectives ORDER BY name_key`
	rows, err := s.db.QueryContext(ctx, q)
	if err != nil {
		return nil, s.notInitialized(fmt.Errorf("sqlite: list perspectives: %w", err))
	}
	defer rows.Close()

	out := []*store.Perspective{}
	for rows.Next() {
		p, err := scanPerspective(rows)
		if err != nil {
			return nil, fmt.Errorf("sqlite: list perspectives: %w", err)
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("sqlite: list perspectives: %w", err)
	}
	return out, nil
}

// DeletePerspective removes one by name. A perspective is a query, so there
// is no tombstone to keep.
func (s *Store) DeletePerspective(ctx context.Context, name string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM perspectives WHERE name_key = ?`,
		strings.ToLower(strings.TrimSpace(name)))
	if err != nil {
		return s.notInitialized(fmt.Errorf("sqlite: delete perspective %s: %w", name, err))
	}
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("sqlite: delete perspective %s: %w", name, err)
	}
	if n == 0 {
		return fmt.Errorf("sqlite: perspective %s: %w", name, store.ErrNotFound)
	}
	return nil
}

func scanPerspective(src scanner) (*store.Perspective, error) {
	var (
		p       store.Perspective
		filter  string
		created string
		updated string
	)
	if err := src.Scan(&p.Name, &filter, &created, &updated); err != nil {
		return nil, err
	}
	if err := json.Unmarshal([]byte(filter), &p.Filter); err != nil {
		return nil, fmt.Errorf("sqlite: decode perspective %s: %w", p.Name, err)
	}
	var err error
	if p.CreatedAt, err = task.ParseTime(created); err != nil {
		return nil, err
	}
	if p.UpdatedAt, err = task.ParseTime(updated); err != nil {
		return nil, err
	}
	return &p, nil
}
