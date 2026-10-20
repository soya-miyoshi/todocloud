package turso

import (
	"context"
	"strconv"
	"strings"
	"testing"

	"github.com/soya-miyoshi/todocloud/internal/store"
	"github.com/soya-miyoshi/todocloud/internal/store/schema"
	"github.com/soya-miyoshi/todocloud/internal/store/storetest"
)

// TestTursoCarriesEveryReleasedSchemaForward runs the migration conformance
// harness over the pipeline transport.
//
// This is the run that matters most. A Turso database lives in the user's
// own cloud account, there is no transaction over the pipeline and nothing
// to restore from, so a ladder that lands on a different schema than `tdo
// init` writes is a corruption nobody can undo. The fake server executes the
// statements on a real engine, so what is being checked here is the real
// thing: the statements this provider actually sends, in the order it sends
// them.
func TestTursoCarriesEveryReleasedSchemaForward(t *testing.T) {
	storetest.RunMigrations(t, storetest.SQL{
		New: func(t *testing.T) store.Store {
			t.Helper()
			f := newFakeServer(t)
			s, err := Open(f.config())
			if err != nil {
				t.Fatalf("opening a store against the fake server: %v", err)
			}
			t.Cleanup(func() { s.Close() })
			return s
		},
		Exec: func(t *testing.T, s store.Store, stmts ...string) {
			t.Helper()
			var b batch
			for _, stmt := range stmts {
				b.add(stmt, false)
			}
			if _, err := s.(*Store).send(context.Background(), &b); err != nil {
				t.Fatalf("executing %d statement(s) over the pipeline: %v", len(stmts), err)
			}
		},
		Query: func(t *testing.T, s store.Store, query string) [][]string {
			t.Helper()
			res, err := s.(*Store).exec(context.Background(), query, true)
			if err != nil {
				t.Fatalf("querying over the pipeline: %v", err)
			}
			out := make([][]string, 0, len(res.Rows))
			for _, row := range res.Rows {
				cells := make([]string, 0, len(row))
				for _, v := range row {
					if v.IsNull() {
						cells = append(cells, storetest.NullText)
						continue
					}
					if text, ok := v.Text(); ok {
						cells = append(cells, text)
						continue
					}
					if n, ok := v.Int64(); ok {
						cells = append(cells, strconv.FormatInt(n, 10))
						continue
					}
					cells = append(cells, storetest.NullText)
				}
				out = append(out, cells)
			}
			return out
		},
	})
}

// A remote store cannot be backed up, and `tdo migrate` must say so rather
// than quietly changing a database the user cannot restore.
func TestMigratingARemoteStoreRequiresConfirmationBecauseThereIsNoBackup(t *testing.T) {
	f := newFakeServer(t)
	s, err := Open(f.config())
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer s.Close()
	ctx := context.Background()
	if err := s.Init(ctx); err != nil {
		t.Fatalf("init: %v", err)
	}
	if _, err := f.db.Exec(`UPDATE meta SET value = 0 WHERE key = ?`, schema.MetaKey); err != nil {
		t.Fatalf("winding the version back: %v", err)
	}

	plan, err := store.PlanMigration(ctx, s)
	if err != nil {
		t.Fatalf("PlanMigration: %v", err)
	}
	if plan.BackupPath != "" {
		t.Errorf("there is nothing to copy a remote database into, but the plan claims a backup at %s", plan.BackupPath)
	}
	if !plan.Confirm {
		t.Fatal("a migration that cannot be backed up must be confirmed by the user; the plan did not ask for it")
	}
	if !strings.Contains(plan.Warning, "backup") {
		t.Errorf("the warning must say plainly that there is no backup, and %q does not", plan.Warning)
	}
	if !strings.Contains(plan.Warning, s.database) {
		t.Errorf("the warning must name the store being changed, and %q does not mention %q", plan.Warning, s.database)
	}
	if strings.Contains(plan.Warning, testToken) {
		t.Error("the warning must not carry the token")
	}
}

// The version check every command makes must cost this provider nothing:
// OpenExisting already read the meta row.
func TestCheckSchemaCostsNoRoundTripAfterOpenExisting(t *testing.T) {
	f := newFakeServer(t)
	s, err := Open(f.config())
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := s.Init(context.Background()); err != nil {
		t.Fatalf("init: %v", err)
	}
	s.Close()

	opened, err := OpenExisting(f.config())
	if err != nil {
		t.Fatalf("OpenExisting: %v", err)
	}
	defer opened.Close()
	before := len(f.seen())
	if err := store.CheckSchema(context.Background(), opened); err != nil {
		t.Fatalf("a store at the current version must pass the check, but: %v", err)
	}
	if after := len(f.seen()); after != before {
		t.Errorf("CheckSchema made %d extra request(s); the version is already in hand from the probe OpenExisting makes, and every command calls this", after-before)
	}
}
