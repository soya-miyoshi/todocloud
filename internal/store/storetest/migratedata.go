package storetest

import (
	"context"
	"strings"
	"testing"

	"github.com/soya-miyoshi/todocloud/internal/store"
	"github.com/soya-miyoshi/todocloud/internal/task"
)

// The rows the harness migrates. They are written with raw SQL, because a
// store at an old version does not necessarily have the columns today's
// provider writes, and they are read back through the Store API, because
// what matters is not that the bytes survived but that the tool still
// understands them.
//
// They are deliberately not a minimal row: a tree with a real parent edge, a
// tombstone, a tag whose spelling differs from its key, a user-defined
// field, and a saved perspective. Those are the things a migration that
// rebuilds a table silently drops.

const (
	// Ids are fixed so a failure names the same row every time. They are
	// well-formed ULIDs and obviously synthetic.
	migrateProjectID = "01J9A00000000000000000000P"
	migrateTaskID    = "01J9A00000000000000000000T"
	migrateGoneID    = "01J9A00000000000000000000X"
)

// DefaultData is the representative data for each released version. A
// version absent from the map is migrated empty, which still checks the
// schema but proves nothing about the rows.
var DefaultData = map[int]VersionData{
	1: {Insert: v1Rows, Verify: verifyV1},
}

var v1Rows = []string{
	`INSERT INTO tasks (id, kind, title, parent_id, position, status, flagged, sequential,
	  completed_by_children, defer_at, due_at, estimated_minutes, note, repeat, series_id,
	  review_interval, last_reviewed_at, created_at, updated_at, completed_at, dropped_at,
	  deleted_at, fields)
	 VALUES ('` + migrateProjectID + `', 'project', 'Move house', NULL, 1, 'active', 0, 1,
	  0, NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL,
	  '2026-01-02T03:04:05Z', '2026-01-02T03:04:05Z', NULL, NULL, NULL, '{}')`,

	`INSERT INTO tasks (id, kind, title, parent_id, position, status, flagged, sequential,
	  completed_by_children, defer_at, due_at, estimated_minutes, note, repeat, series_id,
	  review_interval, last_reviewed_at, created_at, updated_at, completed_at, dropped_at,
	  deleted_at, fields)
	 VALUES ('` + migrateTaskID + `', 'task', 'Book the van', '` + migrateProjectID + `', 2, 'on_hold', 1, 0,
	  0, '2026-02-01T00:00:00Z', '2026-03-01T00:00:00Z', 45, 'ring them in the morning', NULL, NULL, NULL, NULL,
	  '2026-01-02T03:04:06Z', '2026-01-02T03:04:07Z', NULL, NULL, NULL, '{"priority":2,"ref":"3.0.1"}')`,

	// A tombstone, because `tdo rm` is the common case and a migration that
	// loses deleted_at resurrects everything the user removed.
	`INSERT INTO tasks (id, kind, title, parent_id, position, status, flagged, sequential,
	  completed_by_children, defer_at, due_at, estimated_minutes, note, repeat, series_id,
	  review_interval, last_reviewed_at, created_at, updated_at, completed_at, dropped_at,
	  deleted_at, fields)
	 VALUES ('` + migrateGoneID + `', 'task', 'Cancel the skip', '` + migrateProjectID + `', 3, 'active', 0, 0,
	  0, NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL,
	  '2026-01-02T03:04:08Z', '2026-01-02T03:04:09Z', NULL, NULL, '2026-01-03T00:00:00Z', '{}')`,

	// tag keeps the spelling the user typed; tag_key is what is matched on.
	`INSERT INTO task_tags (task_id, tag, tag_key) VALUES ('` + migrateTaskID + `', 'Errands', 'errands')`,

	`INSERT INTO perspectives (name_key, name, filter, created_at, updated_at)
	 VALUES ('weekend', 'Weekend', '{"kinds":["task"],"flagged":true}',
	  '2026-01-02T03:04:05Z', '2026-01-02T03:04:05Z')`,
}

func verifyV1(t *testing.T, s store.Store) {
	t.Helper()
	ctx := context.Background()

	got, err := s.Get(ctx, migrateTaskID)
	if err != nil {
		t.Fatalf("a task that existed before the migration must still be readable afterwards, but Get failed: %v", err)
	}
	switch {
	case got.Title != "Book the van":
		t.Errorf("the migrated task's title is %q, it was %q", got.Title, "Book the van")
	case got.ParentID != migrateProjectID:
		t.Errorf("the migrated task's parent is %q, it was the project %q; a migration that drops the tree leaves every item in the inbox", got.ParentID, migrateProjectID)
	case got.Status != task.StatusOnHold:
		t.Errorf("the migrated task's status is %q, it was on_hold; a status that changes meaning changes what `tdo ls` shows", got.Status)
	case !got.Flagged:
		t.Error("the migrated task was flagged and is not any more")
	case got.EstimatedMinutes != 45:
		t.Errorf("the migrated task's estimate is %d minutes, it was 45", got.EstimatedMinutes)
	case got.DeferAt == nil || got.DueAt == nil:
		t.Error("the migrated task had both a defer and a due date and has lost one of them")
	}
	if ref, ok := got.Fields.String("ref"); !ok || ref != "3.0.1" {
		t.Errorf("a user-defined field must survive a migration untouched; ref came back %q (present: %v)", ref, ok)
	}
	if prio, ok := got.Fields.Int("priority"); !ok || prio != 2 {
		t.Errorf("a user-defined number must survive a migration as a number; priority came back %d (present: %v)", prio, ok)
	}

	gone, err := s.Get(ctx, migrateGoneID)
	if err != nil {
		t.Fatalf("a tombstoned task must survive a migration, since it is how `tdo rm` is undone, but Get failed: %v", err)
	}
	if gone.DeletedAt == nil {
		t.Error("a tombstoned task came back without its tombstone; a migration that loses deleted_at resurrects everything the user removed")
	}

	tags, err := s.Tags(ctx)
	if err != nil {
		t.Fatalf("Tags must work after a migration, but it failed: %v", err)
	}
	if len(tags) != 1 || tags[0].Name != "Errands" || tags[0].Count != 1 {
		t.Errorf("the tag rows must survive with the spelling the user typed; Tags() = %v", tags)
	}
	live := store.Filter{Tags: []string{"ERRANDS"}}
	found, err := s.List(ctx, live)
	if err != nil {
		t.Fatalf("listing by tag after a migration failed: %v", err)
	}
	if len(found) != 1 || found[0].ID != migrateTaskID {
		t.Errorf("a tag must still match case-insensitively after a migration; listing by ERRANDS returned %d item(s)", len(found))
	}

	p, err := s.Perspective(ctx, "weekend")
	if err != nil {
		t.Fatalf("a saved perspective must survive a migration, but reading it failed: %v", err)
	}
	if p.Name != "Weekend" || len(p.Filter.Kinds) != 1 || p.Filter.Kinds[0] != task.KindTask {
		t.Errorf("the saved perspective came back as %+v; its name and its filter are both part of it", p)
	}
	if p.Filter.Flagged == nil || !*p.Filter.Flagged {
		t.Error("the saved perspective's flagged condition did not survive the migration")
	}

	children, err := s.Children(ctx, migrateProjectID)
	if err != nil {
		t.Fatalf("Children must work after a migration, but it failed: %v", err)
	}
	if len(children) != 2 {
		t.Errorf("the project had two children including the tombstoned one, and has %d after the migration: %v", len(children), ids(children))
	}

	// An id is base32 and case-insensitive, and the migrated rows must stay
	// reachable through the same normalization every other call uses.
	if _, err := s.Get(ctx, strings.ToLower(migrateTaskID)); err != nil {
		t.Errorf("a migrated row must still be reachable by a lower-cased id, but Get failed: %v", err)
	}
}
