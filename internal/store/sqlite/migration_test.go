package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/soya-miyoshi/todocloud/internal/store"
	"github.com/soya-miyoshi/todocloud/internal/store/schema"
	"github.com/soya-miyoshi/todocloud/internal/store/storetest"
)

// TestSQLiteCarriesEveryReleasedSchemaForward runs the migration
// conformance harness. SQLite is the reference provider, so a failure here
// is a failure of the ladder itself rather than of one transport.
func TestSQLiteCarriesEveryReleasedSchemaForward(t *testing.T) {
	storetest.RunMigrations(t, migrationSQL())
}

// migrationSQL is the raw access the harness needs. It lives in the
// provider's own test package on purpose: the shipped API has no way to run
// an arbitrary statement, and it must not grow one.
func migrationSQL() storetest.SQL {
	return storetest.SQL{
		New: func(t *testing.T) store.Store {
			t.Helper()
			// A file rather than :memory:, because the backup path and the
			// file mode are part of what the migration machinery does.
			s, err := Open(filepath.Join(t.TempDir(), "tasks.db"))
			if err != nil {
				t.Fatalf("opening an empty store: %v", err)
			}
			t.Cleanup(func() { s.Close() })
			return s
		},
		Exec: func(t *testing.T, s store.Store, stmts ...string) {
			t.Helper()
			db := s.(*Store).db
			for _, stmt := range stmts {
				if _, err := db.ExecContext(context.Background(), stmt); err != nil {
					t.Fatalf("executing %s: %v", firstLine(stmt), err)
				}
			}
		},
		Query: func(t *testing.T, s store.Store, query string) [][]string {
			t.Helper()
			rows, err := s.(*Store).db.QueryContext(context.Background(), query)
			if err != nil {
				t.Fatalf("querying %s: %v", firstLine(query), err)
			}
			defer rows.Close()
			cols, err := rows.Columns()
			if err != nil {
				t.Fatalf("reading the columns of %s: %v", firstLine(query), err)
			}
			var out [][]string
			for rows.Next() {
				cells := make([]sql.NullString, len(cols))
				into := make([]any, len(cols))
				for i := range cells {
					into[i] = &cells[i]
				}
				if err := rows.Scan(into...); err != nil {
					t.Fatalf("scanning %s: %v", firstLine(query), err)
				}
				row := make([]string, len(cells))
				for i, c := range cells {
					row[i] = storetest.NullText
					if c.Valid {
						row[i] = c.String
					}
				}
				out = append(out, row)
			}
			if err := rows.Err(); err != nil {
				t.Fatalf("reading %s: %v", firstLine(query), err)
			}
			return out
		},
	}
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i] + " ..."
	}
	return s
}

// TestMigrateBacksTheDatabaseUpBeforeItChangesIt checks the copy a user is
// told about: it exists, it is private, and it is a real database holding
// the rows as they were.
func TestMigrateBacksTheDatabaseUpBeforeItChangesIt(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tasks.db")
	s, err := Open(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer s.Close()
	ctx := context.Background()
	if err := s.Init(ctx); err != nil {
		t.Fatalf("init: %v", err)
	}
	if _, err := s.db.ExecContext(ctx, `INSERT INTO meta (key, value) VALUES ('canary', 'still here')`); err != nil {
		t.Fatalf("seeding: %v", err)
	}

	plan, err := store.PlanMigration(ctx, s)
	if err != nil {
		t.Fatalf("PlanMigration must succeed on a store at the current version: %v", err)
	}
	if !plan.UpToDate {
		t.Fatalf("a store just created by Init must already be at the current version, but the plan says %d -> %d", plan.From, plan.To)
	}

	// A store that is behind is the case the backup exists for, so wind the
	// recorded version back to make one.
	if _, err := s.db.ExecContext(ctx, `UPDATE meta SET value = 0 WHERE key = ?`, schema.MetaKey); err != nil {
		t.Fatalf("winding the version back: %v", err)
	}
	plan, err = store.PlanMigration(ctx, s)
	if err != nil {
		t.Fatalf("PlanMigration on a store that is behind: %v", err)
	}
	if plan.Confirm {
		t.Error("a local store can be backed up, so `tdo migrate` must not have to ask the user to accept losing it")
	}
	if plan.BackupPath == "" {
		t.Fatal("a local store must be copied before a migration changes it, and the command layer must be told where the copy is")
	}
	if dir := filepath.Dir(plan.BackupPath); dir != filepath.Dir(path) {
		t.Errorf("the backup must sit beside the database, but it is in %s", dir)
	}
	base := filepath.Base(plan.BackupPath)
	if !strings.Contains(base, "backup") {
		t.Errorf("the backup's name must say that it is a backup, and %q does not", base)
	}
	if !strings.Contains(base, "v0") {
		t.Errorf("the backup's name must say which schema version it holds, and %q does not", base)
	}

	info, err := os.Stat(plan.BackupPath)
	if err != nil {
		t.Fatalf("the backup is not there: %v", err)
	}
	// A permission bit is a POSIX notion: on windows Go reports 0666 for a
	// file whatever its ACL says, so this assertion has nothing to read
	// there. The same limit decides product behaviour in
	// internal/config/filetoken_other.go, where a token in a file is refused
	// rather than guarded.
	if perm := info.Mode().Perm(); runtime.GOOS != "windows" && perm != 0o600 {
		t.Errorf("a backup of a task list is private data and must be mode 0600, but it is %o", perm)
	}

	// It must be a database, not a truncated file: the rows have to be
	// readable, which is the whole reason for taking it.
	copyDB, err := sql.Open("sqlite", "file:"+plan.BackupPath+"?mode=ro")
	if err != nil {
		t.Fatalf("opening the backup: %v", err)
	}
	defer copyDB.Close()
	var canary string
	if err := copyDB.QueryRow(`SELECT value FROM meta WHERE key = 'canary'`).Scan(&canary); err != nil {
		t.Fatalf("reading the backup: %v", err)
	}
	if canary != "still here" {
		t.Errorf("the backup holds %q where the database held %q", canary, "still here")
	}
}

// A second migration must not land on top of the copy the first one left:
// that copy may be the only remaining version of the data in its old shape.
func TestASecondBackupDoesNotOverwriteTheFirst(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tasks.db")
	s, err := Open(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer s.Close()
	ctx := context.Background()
	if err := s.Init(ctx); err != nil {
		t.Fatalf("init: %v", err)
	}

	first, err := s.BackupForMigration(ctx, 1)
	if err != nil {
		t.Fatalf("first backup: %v", err)
	}
	second, err := s.BackupForMigration(ctx, 1)
	if err != nil {
		t.Fatalf("second backup: %v", err)
	}
	if first == second {
		t.Fatalf("both backups were written to %s; the first one would have been destroyed", first)
	}
	for _, p := range []string{first, second} {
		if _, err := os.Stat(p); err != nil {
			t.Errorf("the backup at %s is missing: %v", p, err)
		}
	}
}

// Every command checks the version, so the two mismatches must each produce
// their own advice — and never a raw SQL error.
func TestCheckSchemaTellsTheUserWhichWayTheMismatchGoes(t *testing.T) {
	ctx := context.Background()
	s, err := Open(MemoryPath)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer s.Close()

	if err := store.CheckSchema(ctx, s); !errors.Is(err, store.ErrNotInitialized) {
		t.Fatalf("a store with no schema must be reported as uninitialized, got %v", err)
	}
	if err := s.Init(ctx); err != nil {
		t.Fatalf("init: %v", err)
	}
	if err := store.CheckSchema(ctx, s); err != nil {
		t.Fatalf("a store this binary just initialized must pass the version check, but: %v", err)
	}

	for _, tc := range []struct {
		name   string
		stored int
		advice string
		older  bool
	}{
		{"a store older than the binary is told to migrate", schema.Version - 1, "tdo migrate", true},
		{"a store newer than the binary is told to upgrade tdo", schema.Version + 1, "upgrade tdo", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := s.db.ExecContext(ctx, `UPDATE meta SET value = ? WHERE key = ?`, tc.stored, schema.MetaKey); err != nil {
				t.Fatalf("setting the stored version: %v", err)
			}
			err := store.CheckSchema(ctx, s)
			if !errors.Is(err, store.ErrSchemaMismatch) {
				t.Fatalf("a version mismatch must be reported as one, got %v", err)
			}
			var ve *store.VersionError
			if !errors.As(err, &ve) {
				t.Fatalf("the command layer must be able to read the detail off the error, but %v is not a *store.VersionError", err)
			}
			if ve.Older() != tc.older {
				t.Errorf("Older() = %v, want %v", ve.Older(), tc.older)
			}
			if !strings.Contains(err.Error(), tc.advice) {
				t.Errorf("the message must tell the user what to do; %q does not mention %q", err.Error(), tc.advice)
			}
			if strings.Contains(strings.ToLower(err.Error()), "no such") || strings.Contains(err.Error(), "SQL") {
				t.Errorf("no engine error text may reach the user, but the message is %q", err.Error())
			}
		})
	}
}
