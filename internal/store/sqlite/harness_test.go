package sqlite

import (
	"context"
	"strconv"
	"strings"
	"testing"

	"github.com/soya-miyoshi/todocloud/internal/store"
	"github.com/soya-miyoshi/todocloud/internal/store/schema"
	"github.com/soya-miyoshi/todocloud/internal/store/storetest"
)

// This file tests the migration conformance harness rather than the
// provider. The shipped schema is at version 1 and the ladder is empty, so
// there is no real step to carry a store over yet — which would leave the
// harness unexercised, and a check that has never rejected anything is not
// a check anyone should trust with a database they cannot restore.
//
// So the ladder below is a test-only one: a toy schema at version 1, a
// version 2 that adds a table, and two ways of getting there — the right
// one, and one that produces a schema `init` would not have written. The
// harness must accept the first and reject the second.

const (
	harnessV1 = 1
	harnessV2 = 2
)

// harnessBase is the toy version 1: a table, an index, and the meta table
// the version is recorded in, which every store needs.
var harnessBase = []string{
	`CREATE TABLE IF NOT EXISTS widgets (
  id   TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL
)`,
	`CREATE INDEX IF NOT EXISTS widgets_name_idx ON widgets(name)`,
	`CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
)`,
}

// harnessV2Additions is what version 2 adds, as `init` writes it.
var harnessV2Additions = []string{
	`CREATE TABLE IF NOT EXISTS widget_notes (
  widget_id TEXT PRIMARY KEY NOT NULL,
  note      TEXT NOT NULL DEFAULT ''
)`,
	`CREATE INDEX IF NOT EXISTS widget_notes_note_idx ON widget_notes(note)`,
}

// harnessGoodStep reaches version 2 exactly the way init does. Every
// statement is idempotent, so the step survives being retried after an
// interrupted migration.
var harnessGoodStep = schema.Step{To: harnessV2, Name: "add widget notes", Statements: harnessV2Additions}

// harnessDriftingStep reaches version 2 with a schema that is almost right:
// the note column has lost its NOT NULL and its default, and the index was
// never created. This is what the drift being hunted actually looks like —
// nothing fails, nothing is logged, and a store that was migrated behaves
// differently from a store that was initialized.
var harnessDriftingStep = schema.Step{To: harnessV2, Name: "add widget notes, wrongly", Statements: []string{
	`CREATE TABLE IF NOT EXISTS widget_notes (
  widget_id TEXT PRIMARY KEY NOT NULL,
  note      TEXT
)`,
}}

// harnessLadder is a Ladder that runs one test-only step. Init and Migrate
// do by hand what the provider's own Init and Migrate do: run the
// statements, then record the version — for Migrate, after each step and
// never in the same breath as the statements themselves.
func harnessLadder(step schema.Step) storetest.Ladder {
	return storetest.Ladder{
		SQL:        migrationSQL(),
		Target:     harnessV2,
		Historical: map[int][]string{harnessV1: harnessBase},
		Init: func(t *testing.T, s store.Store) {
			t.Helper()
			h := migrationSQL()
			h.Exec(t, s, append(append([]string{}, harnessBase...), harnessV2Additions...)...)
			h.Exec(t, s, setVersionStatement(harnessV2))
		},
		Migrate: func(t *testing.T, s store.Store) error {
			current, err := s.SchemaVersion(context.Background())
			if err != nil {
				return err
			}
			if current >= step.To {
				return nil
			}
			h := migrationSQL()
			h.Exec(t, s, step.Statements...)
			h.Exec(t, s, setVersionStatement(step.To))
			return nil
		},
	}
}

func setVersionStatement(v int) string {
	return `INSERT INTO meta (key, value) VALUES ('` + schema.MetaKey + `', ` +
		strconv.Itoa(v) + `) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
}

// TestTheHarnessAcceptsAMigrationThatLandsOnTheSchemaInitWrites is the
// positive half: a correct step must pass every assertion the harness makes,
// including being run a second time after an interrupted migration.
func TestTheHarnessAcceptsAMigrationThatLandsOnTheSchemaInitWrites(t *testing.T) {
	storetest.RunLadder(t, harnessLadder(harnessGoodStep))
}

// TestTheHarnessRejectsAMigrationThatDriftsFromInit is the half that makes
// the other one worth anything. The drifting step produces a store that
// works, answers queries and loses no data today; the harness must still
// refuse it, and must say which column and which index are wrong, because
// the person reading the failure has to know what to fix.
func TestTheHarnessRejectsAMigrationThatDriftsFromInit(t *testing.T) {
	diff := harnessLadder(harnessDriftingStep).Diff(t, harnessV1)
	if diff == "" {
		t.Fatal("the harness accepted a migration that leaves widget_notes.note nullable and its index missing;\n" +
			"  that is exactly the drift it exists to catch, and a harness that cannot catch it proves nothing about the ones it passes")
	}
	if !strings.Contains(diff, "widget_notes") {
		t.Errorf("the failure must name the table that differs, and it says: %s", diff)
	}
	if !strings.Contains(diff, "note") {
		t.Errorf("the failure must name what differs about it, and it says: %s", diff)
	}
}

// The harness compares columns by name rather than by position, because
// SQLite appends a column added by ALTER TABLE while a fresh CREATE TABLE
// puts it where the DDL does. That is a difference in layout and not in
// schema, and the harness must not report it — otherwise every honest
// add-a-column migration fails and the check gets switched off.
func TestTheHarnessDoesNotMindWhereAnAddedColumnSits(t *testing.T) {
	l := harnessLadder(schema.Step{To: harnessV2, Name: "add a column by rewriting the table", Statements: []string{
		`ALTER TABLE widgets ADD COLUMN colour TEXT`,
	}})
	l.Init = func(t *testing.T, s store.Store) {
		t.Helper()
		h := migrationSQL()
		h.Exec(t, s,
			`CREATE TABLE IF NOT EXISTS widgets (
  id     TEXT PRIMARY KEY NOT NULL,
  colour TEXT,
  name   TEXT NOT NULL
)`,
			`CREATE INDEX IF NOT EXISTS widgets_name_idx ON widgets(name)`,
			`CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
)`,
			setVersionStatement(harnessV2))
	}
	if diff := l.Diff(t, harnessV1); diff != "" {
		t.Errorf("a column added at the end is the same schema as the same column written in the middle, but the harness says: %s", diff)
	}
}
