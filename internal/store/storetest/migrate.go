// The migration conformance harness.
//
// Everything else in this package checks what a store does. This checks what
// happens to a store that already exists when a newer binary is pointed at
// it, which is the one failure in the project that cannot be undone: a Turso
// database lives in the user's own cloud account, there is no transaction
// over the wire and nothing to restore from.
//
// For every version that was ever released, the harness builds a store from
// that version's frozen DDL, fills it with representative data, runs the
// provider's own Migrate, and then asserts two things:
//
//   - the data is still there and still means what it meant, read back
//     through the Store API rather than through SQL; and
//   - the resulting schema is identical to the one Init writes today.
//
// The second assertion is the point of the whole file. An `init` and a
// `migrate` that quietly produce different schemas is the bug that corrupts
// data a year later, on exactly the installs nobody can restore, and the
// only way to catch it is to build both and compare them.

package storetest

import (
	"context"
	"fmt"
	"sort"
	"testing"

	"github.com/soya-miyoshi/todocloud/internal/store"
	"github.com/soya-miyoshi/todocloud/internal/store/schema"
)

// SQL is the raw access the harness needs and the Store interface does not
// offer: planting a historical schema is by definition writing statements no
// current provider method would write, and comparing two schemas means
// reading the engine's own catalogue.
//
// A provider supplies it from its own test package, so none of this is
// exported from the provider itself. There is no raw-SQL escape hatch in the
// shipped API, and there must not be one.
type SQL struct {
	// New returns a store with no schema at all, already open.
	New func(t *testing.T) store.Store
	// Exec runs statements in order against that store and fails the test
	// if any of them does.
	Exec func(t *testing.T, s store.Store, stmts ...string)
	// Query runs one query and returns its rows. A NULL comes back as
	// NullText, so that "no default" and the string "NULL" stay different
	// things.
	Query func(t *testing.T, s store.Store, query string) [][]string
}

// NullText is how Query renders a SQL NULL.
const NullText = "<null>"

// VersionData is representative data written at one version and what it must
// still mean once the store has been migrated.
type VersionData struct {
	// Insert is raw SQL valid at that version. It is raw because a store at
	// an old version may not have the columns today's provider writes.
	Insert []string
	// Verify reads the data back through the Store API after the migration.
	// Reading it back through SQL would only prove the rows are where the
	// migration left them; reading it through the API proves the tool can
	// still make sense of them.
	Verify func(t *testing.T, s store.Store)
}

// Ladder is one migration conformance run. RunMigrations fills it in for the
// shipped schema; the harness's own self-test fills it in with a ladder of
// its own, which is how a harness that has never failed becomes one that is
// known to work.
type Ladder struct {
	SQL SQL
	// Target is the version the ladder reaches.
	Target int
	// Historical maps each released version to the DDL that created it.
	Historical map[int][]string
	// Init creates a store at Target from nothing, the way `tdo init` does.
	Init func(t *testing.T, s store.Store)
	// Migrate carries an existing store forward, the way `tdo migrate` does.
	Migrate func(t *testing.T, s store.Store) error
	// Data is keyed by the version it is written at. A version with no entry
	// is migrated empty, which still checks the schema.
	Data map[int]VersionData
}

// RunMigrations checks the shipped ladder against one provider.
//
//	func TestMigrationsConform(t *testing.T) {
//		storetest.RunMigrations(t, storetest.SQL{New: ..., Exec: ..., Query: ...})
//	}
func RunMigrations(t *testing.T, h SQL) {
	t.Helper()
	historical := map[int][]string{}
	for _, v := range schema.HistoricalVersions() {
		stmts, ok := schema.Historical(v)
		if !ok {
			t.Fatalf("schema.HistoricalVersions names version %d but schema.Historical has no DDL for it", v)
		}
		historical[v] = stmts
	}
	t.Run("the recorded version marker is never written down to a lie", func(t *testing.T) {
		runVersionMarker(t, h)
	})
	RunLadder(t, Ladder{
		SQL:        h,
		Target:     schema.Version,
		Historical: historical,
		Init: func(t *testing.T, s store.Store) {
			t.Helper()
			if err := s.Init(context.Background()); err != nil {
				t.Fatalf("Init must create the current schema on an empty store, but it failed: %v", err)
			}
		},
		Migrate: func(t *testing.T, s store.Store) error {
			return s.Migrate(context.Background())
		},
		Data: DefaultData,
	})
}

// RunLadder is RunMigrations with the ladder spelled out.
func RunLadder(t *testing.T, l Ladder) {
	t.Helper()
	if len(l.Historical) == 0 {
		t.Fatal("the migration harness was given no historical schema to migrate from; every released version needs one")
	}
	versions := make([]int, 0, len(l.Historical))
	for v := range l.Historical {
		versions = append(versions, v)
	}
	sort.Ints(versions)

	// The schema Init produces today. Every run is compared against this
	// one and nothing else.
	fresh := l.snapshotOf(t, "a freshly initialized store", func(t *testing.T, s store.Store) {
		l.Init(t, s)
	})

	for _, from := range versions {
		t.Run(fmt.Sprintf("a store created at version %d migrates to version %d and ends up with the schema init would have written", from, l.Target), func(t *testing.T) {
			s := l.plant(t, from)
			data := l.Data[from]
			if len(data.Insert) > 0 {
				l.SQL.Exec(t, s, data.Insert...)
			}

			if err := l.Migrate(t, s); err != nil {
				t.Fatalf("Migrate must carry a store at version %d forward, but it failed: %v", from, err)
			}
			l.requireVersion(t, s, l.Target, fmt.Sprintf("after migrating from version %d", from))

			got := l.snapshot(t, s)
			diffSchemas(t, fmt.Sprintf(
				"a store migrated from version %d must end up with exactly the schema `tdo init` writes today;\n"+
					"  an init and a migrate that disagree are how a column comes to exist on new installs and not on old ones",
				from), fresh, got)

			if data.Verify != nil {
				data.Verify(t, s)
			}
		})

		t.Run(fmt.Sprintf("a migration from version %d that was interrupted before it recorded the version is resumed, not refused", from), func(t *testing.T) {
			// The version is recorded after each step and in its own round
			// trip, so a store can be left with a step's statements applied
			// and its version not yet moved. That is the state this builds:
			// migrate, wind the recorded version back, migrate again. Every
			// step therefore has to survive being run a second time over
			// its own result.
			s := l.plant(t, from)
			data := l.Data[from]
			if len(data.Insert) > 0 {
				l.SQL.Exec(t, s, data.Insert...)
			}
			if err := l.Migrate(t, s); err != nil {
				t.Fatalf("the first migration from version %d failed: %v", from, err)
			}
			l.setVersion(t, s, from)

			if err := l.Migrate(t, s); err != nil {
				t.Fatalf("a migration resumed from version %d must succeed, so that an interrupted `tdo migrate` is fixed by running it again, but it failed: %v", from, err)
			}
			l.requireVersion(t, s, l.Target, fmt.Sprintf("after resuming a migration from version %d", from))
			diffSchemas(t, fmt.Sprintf(
				"a step that ran twice must leave the same schema as a step that ran once;\n"+
					"  this is the retry an interrupted migration from version %d performs", from),
				fresh, l.snapshot(t, s))
			if data.Verify != nil {
				data.Verify(t, s)
			}
		})
	}
}

// plant builds a store holding exactly the schema of version from, with that
// version recorded, and nothing else.
func (l Ladder) plant(t *testing.T, from int) store.Store {
	t.Helper()
	s := l.SQL.New(t)
	l.SQL.Exec(t, s, l.Historical[from]...)
	l.setVersion(t, s, from)
	return s
}

func (l Ladder) setVersion(t *testing.T, s store.Store, v int) {
	t.Helper()
	l.SQL.Exec(t, s, fmt.Sprintf(
		`INSERT INTO meta (key, value) VALUES ('%s', %d) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		schema.MetaKey, v))
}

func (l Ladder) requireVersion(t *testing.T, s store.Store, want int, when string) {
	t.Helper()
	got, err := s.SchemaVersion(context.Background())
	if err != nil {
		t.Fatalf("SchemaVersion %s: %v", when, err)
	}
	if got != want {
		t.Fatalf("the store must be at version %d %s, but it reports %d", want, when, got)
	}
}

// snapshotOf builds a store, runs build on it and snapshots the result.
func (l Ladder) snapshotOf(t *testing.T, what string, build func(*testing.T, store.Store)) schemaSnapshot {
	t.Helper()
	s := l.SQL.New(t)
	build(t, s)
	snap := l.snapshot(t, s)
	if len(snap.tables) == 0 {
		t.Fatalf("%s holds no tables at all; the harness is not looking at the store it thinks it is", what)
	}
	return snap
}

// Diff builds the two stores RunLadder compares — one that Init created,
// one planted at version from and carried forward by Migrate — and returns
// a description of how their schemas differ, or "" when they are the same.
//
// It exists so that the harness itself can be tested. A conformance check
// that has never rejected anything is not known to work, and the only way
// to watch this one reject something is to hand it a ladder that really
// does drift from init and read what it says, without the attempt failing
// the test that is making it.
func (l Ladder) Diff(t *testing.T, from int) string {
	t.Helper()
	fresh := l.snapshotOf(t, "a freshly initialized store", func(t *testing.T, s store.Store) {
		l.Init(t, s)
	})
	s := l.plant(t, from)
	if data, ok := l.Data[from]; ok && len(data.Insert) > 0 {
		l.SQL.Exec(t, s, data.Insert...)
	}
	if err := l.Migrate(t, s); err != nil {
		return fmt.Sprintf("the migration from version %d failed outright: %v", from, err)
	}
	return compareSnapshots(fresh, l.snapshot(t, s))
}
