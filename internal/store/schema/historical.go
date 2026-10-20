package schema

// This file is the archive: for every version ever released, the statements
// a binary of that version created a store with.
//
// Each entry is a frozen, literal copy, never a reference to the live DDL in
// schema.go. That is the whole value of it. The conformance harness builds a
// store from each historical entry, runs the ladder over it, and compares
// the result with a store that Init created today. If someone changes the
// live DDL without appending a Step, the two stop matching and the harness
// says so — which is the drift that otherwise shows up a year later as a
// column that exists on new installs and not on old ones.
//
// So: when Version is bumped, copy the previous version's DDL into this
// file verbatim before editing the live DDL, and append the Step.

// historical maps a released version to the schema it created.
var historical = map[int][]string{
	1: historicalV1,
}

// Historical returns the DDL that created a store at version v, and whether
// that version was ever released.
func Historical(v int) ([]string, bool) {
	stmts, ok := historical[v]
	if !ok {
		return nil, false
	}
	return append([]string(nil), stmts...), true
}

// HistoricalVersions returns every released version up to and including
// Version, in ascending order. It is what the conformance harness iterates.
//
// The current version is included on purpose. Migrating a store that is
// already current is a no-op, so the run reduces to comparing the frozen DDL
// of this version with what Init writes today — which is the check that
// catches the live DDL being edited in place instead of through a Step, and
// is the only check there is to make while the ladder is still empty.
func HistoricalVersions() []int {
	out := make([]int, 0, len(historical))
	for v := 1; v <= Version; v++ {
		if _, ok := historical[v]; ok {
			out = append(out, v)
		}
	}
	return out
}

// historicalV1 is the schema of version 1, the first released schema.
// Frozen on the day version 1 shipped. Do not edit it, ever.
var historicalV1 = []string{
	`CREATE TABLE IF NOT EXISTS tasks (
  id                    TEXT PRIMARY KEY NOT NULL,
  kind                  TEXT NOT NULL,
  title                 TEXT NOT NULL,
  parent_id             TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
  position              INTEGER NOT NULL DEFAULT 0,
  status                TEXT NOT NULL DEFAULT 'active',
  flagged               INTEGER NOT NULL DEFAULT 0,
  sequential            INTEGER NOT NULL DEFAULT 0,
  completed_by_children INTEGER NOT NULL DEFAULT 0,
  defer_at              TEXT,
  due_at                TEXT,
  estimated_minutes     INTEGER NOT NULL DEFAULT 0,
  note                  TEXT,
  repeat                TEXT,
  series_id             TEXT,
  review_interval       TEXT,
  last_reviewed_at      TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  completed_at          TEXT,
  dropped_at            TEXT,
  deleted_at            TEXT,
  fields                TEXT NOT NULL DEFAULT '{}'
)`,
	`CREATE INDEX IF NOT EXISTS tasks_parent_idx ON tasks(parent_id, position, id)`,
	`CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status, deleted_at)`,
	`CREATE INDEX IF NOT EXISTS tasks_updated_idx ON tasks(updated_at)`,
	`CREATE INDEX IF NOT EXISTS tasks_due_idx ON tasks(due_at)`,
	`CREATE INDEX IF NOT EXISTS tasks_series_idx ON tasks(series_id)`,
	`CREATE TABLE IF NOT EXISTS task_tags (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tag     TEXT NOT NULL,
  tag_key TEXT NOT NULL,
  PRIMARY KEY (task_id, tag_key)
)`,
	`CREATE INDEX IF NOT EXISTS task_tags_key_idx ON task_tags(tag_key)`,
	`CREATE TABLE IF NOT EXISTS perspectives (
  name_key   TEXT PRIMARY KEY NOT NULL,
  name       TEXT NOT NULL,
  filter     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
	`CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
)`,
}
