package turso

import (
	"context"
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
// It is the sqlite provider's shape, over the wire: the query narrows the
// rows — the tag filter in particular is a join and not a scan, which is the
// whole reason tags are their own table — and the shared matcher in
// internal/store then decides. Deciding twice costs one pass over a handful
// of rows and buys the guarantee the conformance suite is about: whatever
// this provider pushes down, the answer is the one the definition gives.
//
// The candidate rows, their tags and, when the filter needs it, the whole
// tree are three statements in one pipeline, so a listing is one round trip
// however much of the tree it has to consider.
func (s *Store) List(ctx context.Context, f store.Filter) ([]*task.Task, error) {
	if err := f.Validate(); err != nil {
		return nil, fmt.Errorf("turso: list tasks: %w", err)
	}
	where, args := pushDown(f)

	q := `SELECT ` + columns + ` FROM tasks`
	if len(where) > 0 {
		q += ` WHERE (` + strings.Join(where, `) AND (`) + `)`
	}
	q += ` ORDER BY id`

	var b batch
	b.add(q, true, args...)
	tagsAt := b.len()
	b.add(`SELECT task_id, tag FROM task_tags ORDER BY task_id, tag_key`, true)
	treeAt := -1
	if f.NeedsTree() {
		// Availability, a subtree scope and tree order are questions about
		// the whole tree, and the ancestors of a matching row need not match
		// themselves, so they cannot be answered from the rows selected
		// above.
		treeAt = b.len()
		b.add(`SELECT `+columns+` FROM tasks`, true)
	}

	res, err := s.send(ctx, &b)
	if err != nil {
		return nil, s.wrap(err, "list tasks")
	}
	candidates, err := scanTasks(res[0])
	if err != nil {
		return nil, fmt.Errorf("turso: list tasks: %w", err)
	}
	if err := attachTags(candidates, res[tagsAt]); err != nil {
		return nil, fmt.Errorf("turso: list tasks: %w", err)
	}
	var tree *store.Tree
	if treeAt >= 0 {
		if tree, err = treeFrom(res[treeAt]); err != nil {
			return nil, fmt.Errorf("turso: list tasks: %w", err)
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
	// The limit is applied last, on the listing the filter would have
	// returned, so that `--limit 2` is the first two of it and not two of
	// whatever the server happened to send.
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
		clause := inClause(len(f.Kinds))
		for _, k := range f.Kinds {
			args = append(args, string(k))
		}
		where = append(where, `kind `+clause)
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
// bound as typed protocol arguments, never interpolated: nothing a user types
// reaches the SQL text.
func inClause(n int) string {
	return "IN (" + strings.TrimSuffix(strings.Repeat("?,", n), ",") + ")"
}

// scanTasks decodes a whole result of task rows.
func scanTasks(res *executeResult) ([]*task.Task, error) {
	out := make([]*task.Task, 0, len(res.Rows))
	for _, row := range res.Rows {
		t, err := scanTask(row)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, nil
}

// treeFrom indexes a result of task rows. Tags are left off: no rule in §3.1
// or §3.3 depends on them, and this is read on every listing that asks about
// availability.
func treeFrom(res *executeResult) (*store.Tree, error) {
	tree, _, err := treeWithNodes(res)
	return tree, err
}

// treeWithNodes returns the tree and the rows it was built from, so a caller
// that has to fill the tags in does not have to walk the tree to find them.
func treeWithNodes(res *executeResult) (*store.Tree, []*task.Task, error) {
	all, err := scanTasks(res)
	if err != nil {
		return nil, nil, err
	}
	return store.NewTree(all), all, nil
}

// loadTree reads every row into an in-memory tree. It is the read half of
// every write: with no transaction to hold, the placement rules are decided
// against this snapshot before a single statement goes up.
func (s *Store) loadTree(ctx context.Context) (*store.Tree, error) {
	// The rows, the tags each task carries and the status of each tag, in
	// one pipeline: the two tag rules of §3.3 need all three, and a tree
	// read in three round trips would be three snapshots.
	var b batch
	b.add(`SELECT `+columns+` FROM tasks`, true)
	b.add(allTagsSQL, true)
	b.add(tagRowsSQL, true)
	res, err := s.send(ctx, &b)
	if err != nil {
		return nil, s.wrap(err, "read the tree")
	}
	tree, nodes, err := treeWithNodes(res[0])
	if err != nil {
		return nil, fmt.Errorf("turso: read the tree: %w", err)
	}
	if err := attachTags(nodes, res[1]); err != nil {
		return nil, fmt.Errorf("turso: read the tree: %w", err)
	}
	statuses, err := scanTagRows(res[2])
	if err != nil {
		return nil, err
	}
	tree.SetTagStatuses(statuses)
	return tree, nil
}

// allTagsSQL and tagRowsSQL are the two tag reads every tree needs.
const (
	allTagsSQL = `SELECT task_id, tag FROM task_tags ORDER BY task_id, tag_key`
	tagRowsSQL = `SELECT tag_key, tag, status, COALESCE(note, '') FROM tags ORDER BY tag_key`
)

// scanTagRows reads the tag table out of a result.
func scanTagRows(res *executeResult) ([]store.Tag, error) {
	out := make([]store.Tag, 0, len(res.Rows))
	for _, row := range res.Rows {
		if len(row) != 4 {
			return nil, fmt.Errorf("turso: read tags: a row came back with %d column(s), want 4", len(row))
		}
		name, err := text(row[1], "tag")
		if err != nil {
			return nil, fmt.Errorf("turso: read tags: %w", err)
		}
		status, err := text(row[2], "status")
		if err != nil {
			return nil, fmt.Errorf("turso: read tags: %w", err)
		}
		note, err := text(row[3], "note")
		if err != nil {
			return nil, fmt.Errorf("turso: read tags: %w", err)
		}
		out = append(out, store.Tag{Name: name, Status: task.Status(status), Note: note})
	}
	return out, nil
}

// Children returns the direct children of parentID in tree order,
// tombstoned ones included. An empty parentID returns the top level.
func (s *Store) Children(ctx context.Context, parentID string) ([]*task.Task, error) {
	return s.List(ctx, store.Filter{
		Scope:          store.Scope{Children: true, ParentID: id.Normalize(parentID)},
		IncludeDeleted: true,
	})
}

// Subtree returns id and everything beneath it, in pre-order. The rows and
// their tags travel in one pipeline.
func (s *Store) Subtree(ctx context.Context, taskID string) ([]*task.Task, error) {
	normalized := id.Normalize(taskID)

	var b batch
	b.add(`SELECT `+columns+` FROM tasks`, true)
	b.add(allTagsSQL, true)
	res, err := s.send(ctx, &b)
	if err != nil {
		return nil, s.wrap(err, "read subtree "+taskID)
	}
	tree, err := treeFrom(res[0])
	if err != nil {
		return nil, fmt.Errorf("turso: read subtree %s: %w", taskID, err)
	}
	nodes := tree.Subtree(normalized)
	if len(nodes) == 0 {
		return nil, fmt.Errorf("turso: %s: %w", taskID, store.ErrNotFound)
	}
	if err := attachTags(nodes, res[1]); err != nil {
		return nil, fmt.Errorf("turso: read subtree %s: %w", taskID, err)
	}
	return nodes, nil
}

// Availability computes §3.3 for each id over the whole tree. The rules are
// the shared ones: this provider reads the rows and asks, so that its answer
// cannot drift from the definition.
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
func (s *Store) Tags(ctx context.Context) ([]store.Tag, error) {
	const q = `SELECT tt.tag_key, MIN(tt.tag), COUNT(*) FROM task_tags tt
	           JOIN tasks t ON t.id = tt.task_id
	           WHERE t.deleted_at IS NULL
	           GROUP BY tt.tag_key ORDER BY tt.tag_key`
	var b batch
	b.add(q, true)
	b.add(tagRowsSQL, true)
	res, err := s.send(ctx, &b)
	if err != nil {
		return nil, s.wrap(err, "list tags")
	}
	uses := make([]store.TagUse, 0, len(res[0].Rows))
	for _, row := range res[0].Rows {
		if len(row) != 3 {
			return nil, fmt.Errorf("turso: list tags: a row came back with %d column(s), want 3", len(row))
		}
		key, err := text(row[0], "tag_key")
		if err != nil {
			return nil, fmt.Errorf("turso: list tags: %w", err)
		}
		name, err := text(row[1], "tag")
		if err != nil {
			return nil, fmt.Errorf("turso: list tags: %w", err)
		}
		count, err := integer(row[2], "count")
		if err != nil {
			return nil, fmt.Errorf("turso: list tags: %w", err)
		}
		uses = append(uses, store.TagUse{Key: key, Name: name, Count: int(count)})
	}
	stored, err := scanTagRows(res[1])
	if err != nil {
		return nil, err
	}
	rows := make([]store.TagRow, 0, len(stored))
	for _, tag := range stored {
		rows = append(rows, store.TagRow{
			Key: store.TagKey(tag.Name), Name: tag.Name, Status: tag.Status, Note: tag.Note,
		})
	}
	return store.MergeTags(uses, rows), nil
}

// SetTagStatus records a tag's status, creating the row when the tag has none
// yet. The tag need not be in use: putting a context on hold before filing
// anything under it is ordinary.
func (s *Store) SetTagStatus(ctx context.Context, name string, status task.Status, now time.Time) error {
	key := store.TagKey(name)
	if key == "" {
		return fmt.Errorf("turso: set tag status: a tag must have a name")
	}
	if !store.ValidTagStatus(status) {
		return fmt.Errorf("turso: set tag status: %q is not a tag status", status)
	}
	stamp := task.FormatTime(now)
	const q = `INSERT INTO tags (tag_key, tag, status, created_at, updated_at)
	           VALUES (?, ?, ?, ?, ?)
	           ON CONFLICT(tag_key) DO UPDATE SET status = excluded.status,
	                                              updated_at = excluded.updated_at`
	if _, err := s.exec(ctx, q, false, key, strings.TrimSpace(name), string(status), stamp, stamp); err != nil {
		return s.wrap(err, "set the status of tag "+name)
	}
	return nil
}

// RenameTag moves every task from one tag to another and takes the status
// with it when the destination has none of its own. There is no transaction
// over the wire, so the tag is read first and the whole rewrite travels as
// one pipeline.
func (s *Store) RenameTag(ctx context.Context, from, to string, now time.Time) error {
	fromKey, toKey := store.TagKey(from), store.TagKey(to)
	if fromKey == "" || toKey == "" {
		return fmt.Errorf("turso: rename tag: both the old and the new name must be given")
	}
	known, status, err := s.tagStatus(ctx, fromKey)
	if err != nil {
		return err
	}
	if !known {
		return fmt.Errorf("turso: tag %q: %w", from, store.ErrNotFound)
	}
	spelling := strings.TrimSpace(to)
	stamp := task.FormatTime(now)

	var b batch
	if fromKey == toKey {
		// Only the spelling changes. Both tables keep a copy of it, so both
		// are rewritten.
		b.add(`UPDATE tags SET tag = ?, updated_at = ? WHERE tag_key = ?`, false, spelling, stamp, toKey)
		b.add(`UPDATE task_tags SET tag = ? WHERE tag_key = ?`, false, spelling, toKey)
	} else {
		// A task that already carries the destination tag must not end up
		// with two rows for it, so the collisions go first.
		b.add(`DELETE FROM task_tags WHERE tag_key = ?
	           AND task_id IN (SELECT task_id FROM task_tags WHERE tag_key = ?)`, false, fromKey, toKey)
		b.add(`UPDATE task_tags SET tag = ?, tag_key = ? WHERE tag_key = ?`, false, spelling, toKey, fromKey)
		// The destination keeps its own status when it has one: renaming
		// into a context that is on hold must not quietly wake it up.
		b.add(`INSERT INTO tags (tag_key, tag, status, created_at, updated_at)
	           VALUES (?, ?, ?, ?, ?)
	           ON CONFLICT(tag_key) DO UPDATE SET tag = excluded.tag, updated_at = excluded.updated_at`,
			false, toKey, spelling, string(status), stamp, stamp)
		b.add(`DELETE FROM tags WHERE tag_key = ?`, false, fromKey)
	}
	if _, err := s.send(ctx, &b); err != nil {
		return s.wrap(err, "rename tag "+from)
	}
	return nil
}

// RemoveTag takes a tag off every task and forgets its status, returning how
// many tasks were changed.
func (s *Store) RemoveTag(ctx context.Context, name string) (int, error) {
	key := store.TagKey(name)
	if key == "" {
		return 0, fmt.Errorf("turso: remove tag: a tag must have a name")
	}
	known, _, err := s.tagStatus(ctx, key)
	if err != nil {
		return 0, err
	}
	if !known {
		return 0, fmt.Errorf("turso: tag %q: %w", name, store.ErrNotFound)
	}
	var b batch
	b.add(`DELETE FROM task_tags WHERE tag_key = ?`, false, key)
	b.add(`DELETE FROM tags WHERE tag_key = ?`, false, key)
	res, err := s.send(ctx, &b)
	if err != nil {
		return 0, s.wrap(err, "remove tag "+name)
	}
	return int(res[0].AffectedRowCount), nil
}

// tagStatus reports whether a tag is known — carried by a task or holding a
// row of its own — and the status it holds, defaulting to active.
func (s *Store) tagStatus(ctx context.Context, key string) (bool, task.Status, error) {
	var b batch
	b.add(`SELECT status FROM tags WHERE tag_key = ?`, true, key)
	b.add(`SELECT COUNT(*) FROM task_tags WHERE tag_key = ?`, true, key)
	res, err := s.send(ctx, &b)
	if err != nil {
		return false, "", s.wrap(err, "read tag "+key)
	}
	if len(res[0].Rows) > 0 {
		if len(res[0].Rows[0]) != 1 {
			return false, "", fmt.Errorf("turso: read tag %q: a row came back with %d column(s), want 1", key, len(res[0].Rows[0]))
		}
		raw, err := text(res[0].Rows[0][0], "status")
		if err != nil {
			return false, "", fmt.Errorf("turso: read tag %q: %w", key, err)
		}
		status := task.Status(raw)
		if !store.ValidTagStatus(status) {
			status = task.StatusActive
		}
		return true, status, nil
	}
	if len(res[1].Rows) == 0 || len(res[1].Rows[0]) != 1 {
		return false, "", fmt.Errorf("turso: read tag %q: the count came back empty", key)
	}
	used, err := integer(res[1].Rows[0][0], "count")
	if err != nil {
		return false, "", fmt.Errorf("turso: read tag %q: %w", key, err)
	}
	return used > 0, task.StatusActive, nil
}

// SavePerspective stores a perspective, replacing one of the same name.
// Names are compared case-insensitively, since they are typed.
func (s *Store) SavePerspective(ctx context.Context, p *store.Perspective) error {
	name := strings.TrimSpace(p.Name)
	if name == "" {
		return errors.New("turso: a perspective needs a name")
	}
	if err := p.Filter.Validate(); err != nil {
		return fmt.Errorf("turso: save perspective %s: %w", name, err)
	}
	filter, err := json.Marshal(p.Filter)
	if err != nil {
		return fmt.Errorf("turso: encode perspective %s: %w", name, err)
	}
	created := p.CreatedAt
	if created.IsZero() {
		created = p.UpdatedAt
	}
	const q = `INSERT INTO perspectives (name_key, name, filter, created_at, updated_at)
	           VALUES (?, ?, ?, ?, ?)
	           ON CONFLICT(name_key) DO UPDATE SET
	             name = excluded.name, filter = excluded.filter, updated_at = excluded.updated_at`
	_, err = s.exec(ctx, q, false, strings.ToLower(name), name, string(filter),
		task.FormatTime(created), task.FormatTime(p.UpdatedAt))
	if err != nil {
		return s.wrap(err, "save perspective "+name)
	}
	return nil
}

// Perspective returns one by name, or store.ErrNotFound.
func (s *Store) Perspective(ctx context.Context, name string) (*store.Perspective, error) {
	const q = `SELECT name, filter, created_at, updated_at FROM perspectives WHERE name_key = ?`
	res, err := s.exec(ctx, q, true, strings.ToLower(strings.TrimSpace(name)))
	if err != nil {
		return nil, s.wrap(err, "read perspective "+name)
	}
	if len(res.Rows) == 0 {
		return nil, fmt.Errorf("turso: perspective %s: %w", name, store.ErrNotFound)
	}
	p, err := scanPerspective(res.Rows[0])
	if err != nil {
		return nil, fmt.Errorf("turso: read perspective %s: %w", name, err)
	}
	return p, nil
}

// Perspectives returns all of them, sorted by name.
func (s *Store) Perspectives(ctx context.Context) ([]*store.Perspective, error) {
	const q = `SELECT name, filter, created_at, updated_at FROM perspectives ORDER BY name_key`
	res, err := s.exec(ctx, q, true)
	if err != nil {
		return nil, s.wrap(err, "list perspectives")
	}
	out := []*store.Perspective{}
	for _, row := range res.Rows {
		p, err := scanPerspective(row)
		if err != nil {
			return nil, fmt.Errorf("turso: list perspectives: %w", err)
		}
		out = append(out, p)
	}
	return out, nil
}

// DeletePerspective removes one by name, or returns store.ErrNotFound. A
// perspective is a query, so there is no tombstone to keep.
func (s *Store) DeletePerspective(ctx context.Context, name string) error {
	res, err := s.exec(ctx, `DELETE FROM perspectives WHERE name_key = ?`, false,
		strings.ToLower(strings.TrimSpace(name)))
	if err != nil {
		return s.wrap(err, "delete perspective "+name)
	}
	if res.AffectedRowCount == 0 {
		return fmt.Errorf("turso: perspective %s: %w", name, store.ErrNotFound)
	}
	return nil
}

func scanPerspective(row []value) (*store.Perspective, error) {
	if len(row) != 4 {
		return nil, fmt.Errorf("a row came back with %d column(s), want 4", len(row))
	}
	var p store.Perspective
	name, err := text(row[0], "name")
	if err != nil {
		return nil, err
	}
	p.Name = name
	filter, err := text(row[1], "filter")
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal([]byte(filter), &p.Filter); err != nil {
		return nil, fmt.Errorf("decode perspective %s: %w", p.Name, err)
	}
	created, err := text(row[2], "created_at")
	if err != nil {
		return nil, err
	}
	if p.CreatedAt, err = task.ParseTime(created); err != nil {
		return nil, err
	}
	updated, err := text(row[3], "updated_at")
	if err != nil {
		return nil, err
	}
	if p.UpdatedAt, err = task.ParseTime(updated); err != nil {
		return nil, err
	}
	return &p, nil
}
