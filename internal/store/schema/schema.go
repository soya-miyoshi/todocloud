// Package schema is the one place the stored schema is written down.
//
// Both shipped providers speak the SQLite dialect, so the DDL, the version
// number and the migration ladder belong to neither of them. They live here
// and each provider executes them through its own transport: the sqlite
// provider inside a transaction, the turso provider as pipelines of
// statements over HTTP. A step added here reaches both providers at once,
// which is the point — a ladder duplicated per provider is a ladder that can
// be added to one and forgotten in the other, and the store that forgets is
// the one in somebody's cloud account that cannot be rolled back.
//
// Nothing here imports a provider, a transport or internal/exit, so the
// package is a pure description: statements, a version, and the order they
// go in.
package schema

import "fmt"

// Version is the schema version this binary writes and expects. A store
// recorded below it is upgraded by Migrate; one above it belongs to a newer
// binary and is refused rather than guessed at.
//
// Bumping it without appending the matching Step panics at init time, which
// any test in the module will catch.
const Version = 1

// MetaKey is the key the version lives under in the meta table. Every
// provider uses the same name, so `tdo migrate` reads the same thing
// everywhere and `tdo export | tdo import` moves between two stores that
// agree on what version means.
const MetaKey = "schema_version"

// SetVersionSQL records the version, inserting or updating in one statement
// so that neither Init nor Migrate needs a read first. Its arguments are
// MetaKey and the version, in that order.
const SetVersionSQL = `INSERT INTO meta (key, value) VALUES (?, ?)
	           ON CONFLICT(key) DO UPDATE SET value = excluded.value`

// initial is the schema a fresh store is created with: the current schema,
// in full. It is deliberately not assembled from the ladder below — a fresh
// store should not have to replay a decade of history — and that is exactly
// why storetest.RunMigrations exists, to prove that replaying the history
// lands on this.
//
// One statement per element, because the libSQL pipeline protocol executes
// one statement per request and will not take a script.
//
// The required fields of PLAN.md §3.2 are columns, tags are a real join
// table because `tdo ls --tag home` must be a join and not a scan, and every
// user-defined value lives in the fields JSON object, which is what lets a
// user add an attribute of their own without a migration.
//
// Nothing is deleted by default, so the parent foreign key is RESTRICT
// rather than CASCADE: a purge that would orphan a subtree is refused in Go,
// and the constraint is the second line of defence if it ever is not. A
// remote connection may well have foreign keys switched off, so no provider
// relies on the constraint or on a cascade.
var initial = []string{
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
	// tag_key is the tag folded to lower case. Tags are compared
	// case-insensitively everywhere, so it is the key of the pair; tag keeps
	// the spelling the user typed, which is what gets printed back.
	`CREATE TABLE IF NOT EXISTS task_tags (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tag     TEXT NOT NULL,
  tag_key TEXT NOT NULL,
  PRIMARY KEY (task_id, tag_key)
)`,
	`CREATE INDEX IF NOT EXISTS task_tags_key_idx ON task_tags(tag_key)`,
	// A perspective is a saved query: a name and the filter, as JSON. It
	// stores no results and pins no ids, so it cannot go stale.
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

// Initial returns the statements that create a store at Version, in order.
// The slice is a copy, so a provider may not edit the schema by accident.
func Initial() []string { return append([]string(nil), initial...) }

// Step is one rung of the upgrade ladder: the statements that move a store
// from To-1 to To, in order.
//
// Two rules hold for every step, and both exist because the turso provider
// has no transaction to hide behind:
//
//   - A step must be idempotent. The version is recorded after the step, in
//     a separate round trip, so a migration interrupted between the two
//     leaves a store whose statements have run but whose version has not
//     moved. The next `tdo migrate` runs the step again and must succeed.
//     In practice that means CREATE ... IF NOT EXISTS, UPDATE ... WHERE the
//     row still needs it, and a backfill written so that running it twice
//     changes nothing the second time. SQLite has no ALTER TABLE ADD COLUMN
//     IF NOT EXISTS, so a step that adds a column rebuilds the table, with
//     the new table created under a temporary name, IF NOT EXISTS.
//   - A step is forward-only. There is no Down. A mistake is corrected by a
//     further step, because the user's data has already moved.
//
// One case deserves its own note, because getting it wrong locks a user out
// of their own tasks: **promoting a user-defined field to a column.** Until
// it is promoted, `energy` lives in the open fields JSON and a user may
// already have set it with `--set energy=high`. The moment it becomes a
// required field its name is reserved, and from then on Task.MarshalJSON
// skips the stored copy while Task.Validate refuses the task outright — so
// the value disappears from output and the row can never be written again.
// A step that adds such a column must therefore also move the data out of
// the JSON, in the same step, idempotently:
//
//	UPDATE tasks SET energy = json_extract(fields, '$.energy'),
//	                 fields = json_remove(fields, '$.energy')
//	 WHERE json_extract(fields, '$.energy') IS NOT NULL;
//
// Running that twice is a no-op, because the WHERE clause stops matching
// once the key is gone.
type Step struct {
	// To is the version this step produces. Steps are contiguous and the
	// last one produces Version.
	To int
	// Name is what `tdo migrate` prints and what an error names.
	Name string
	// Statements run in order. Each one must succeed before the version is
	// recorded.
	Statements []string
}

// steps is the ladder. Version 1 is the initial schema and has no step: a
// store at 0 has no schema at all and is created by Init rather than
// migrated. New versions append here, and only here.
var steps = []Step{}

// Steps returns the whole ladder, in order.
func Steps() []Step { return append([]Step(nil), steps...) }

// Pending returns the steps a store at version from still owes, in order. A
// store already at Version owes none.
func Pending(from int) []Step {
	var out []Step
	for _, s := range steps {
		if s.To > from {
			out = append(out, s)
		}
	}
	return out
}

// init refuses a ladder that cannot be right. It is the mechanism behind
// "a step cannot be added to one provider and forgotten in the other":
// there is one ladder, and a Version that does not match it stops the
// process before any store is touched.
func init() {
	if err := validate(); err != nil {
		panic("store/schema: " + err.Error())
	}
}

func validate() error {
	want := 2 // version 1 is the initial schema, so the ladder starts at 2
	for _, s := range steps {
		if s.To != want {
			return fmt.Errorf("the ladder jumps to version %d where %d was expected; steps must be contiguous and in order", s.To, want)
		}
		if s.Name == "" {
			return fmt.Errorf("the step to version %d has no name", s.To)
		}
		if len(s.Statements) == 0 {
			return fmt.Errorf("the step to version %d has no statements", s.To)
		}
		want++
	}
	if reached := want - 1; reached != Version {
		return fmt.Errorf("the ladder reaches version %d but Version is %d; bumping the version means appending the step that gets there", reached, Version)
	}
	return nil
}
