package main

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/soya-miyoshi/todocloud/internal/store/schema"
)

// `tdo migrate` is the one administrative command that changes data it
// cannot put back, so it is the one that has to be watched from outside the
// process: a real file on disk, the real binary, and a snapshot of the
// directory around the run.

// setRecordedVersion rewrites the schema version in the database behind the
// tool's back. It is how a store the binary considers out of date is built
// without an older binary to build it with, and it touches only the meta
// row, so every task stays exactly as it was written.
func (h *harness) setRecordedVersion(t *testing.T, v int) {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+h.db)
	if err != nil {
		t.Fatalf("opening the database to plant version %d: %v", v, err)
	}
	defer db.Close()
	if _, err := db.Exec(schema.SetVersionSQL, schema.MetaKey, strconv.Itoa(v)); err != nil {
		t.Fatalf("planting schema version %d: %v", v, err)
	}
}

func TestMigratingALocalStoreCopiesItAsideBeforeChangingIt(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	h.mustRun("init")
	h.addTask("Written before the migration")
	h.addTask("Written before the migration too")

	// A store one version behind this binary. The number is relative to the
	// shipped version, so this test keeps meaning the same thing when the
	// ladder grows a rung.
	from := schema.Version - 1
	h.setRecordedVersion(t, from)

	before := snapshotDir(t, h.data)
	res := h.run("migrate", "--json")
	after := snapshotDir(t, h.data)

	// The backup lands beside the database, named for the version it holds,
	// and the user is told where it is — before the migration runs, so the
	// path is on screen even when the next step fails.
	backup := filepath.Base(h.db) + ".backup-v" + strconv.Itoa(from)
	if !after.has(backup) {
		t.Fatalf("migrate took no backup; %s is not beside the database\n%s\nafter %v", backup, res.describe(), after)
	}
	if !strings.Contains(res.stderr, backup) {
		t.Errorf("migrate did not say where the backup is:\n%s", res.describe())
	}

	backupPath := filepath.Join(h.data, backup)
	if runtime.GOOS != "windows" {
		// A task list is private. VACUUM INTO creates the copy with the
		// process umask, which on most machines would make it readable by
		// everyone, so the provider narrows it and this watches that it
		// did.
		info, err := os.Stat(backupPath)
		if err != nil {
			t.Fatalf("stat the backup: %v", err)
		}
		if got := info.Mode().Perm(); got != 0o600 {
			t.Errorf("the backup is mode %04o, want 0600: a copy of the task list may not be readable by anyone else", got)
		}
	}

	// The backup is the data as it was: both tasks, readable from the copy.
	if copied := tasksInFile(t, backupPath); strings.Join(copied, "|") != "Written before the migration|Written before the migration too" {
		t.Errorf("the backup does not hold the original tasks: %v", copied)
	}

	// Nothing else appeared and nothing disappeared. The backup is the only
	// file a migration may add, and no file it may ever take away.
	if gone := removed(before, after); len(gone) != 0 {
		t.Errorf("migrate removed %v from the data directory\nbefore %v\nafter %v", gone, before, after)
	}
	for _, p := range added(before, after) {
		if p == backup || strings.HasSuffix(p, "-wal") || strings.HasSuffix(p, "-shm") {
			continue
		}
		t.Errorf("migrate created %q, which is neither the backup nor the store's own scratch file\nbefore %v\nafter %v", p, before, after)
	}

	// The live database came through it intact. The recorded version is put
	// back first, because the shipped ladder is still one rung long: there
	// is no step for a migration to run, so what this test pins down is the
	// backup and the data, not the ladder — internal/store/storetest owns
	// that.
	h.setRecordedVersion(t, schema.Version)
	if kept := titles(h.tasksOf(h.mustRun("ls", "--json"))); len(kept) != 2 {
		t.Errorf("the original data did not survive the migration: %v", kept)
	}
}

// TestMigratingACurrentStoreIsACleanNoOpThatCopiesNothing is the other half:
// the command users run most often, against a store that needs nothing. It
// must take no backup — a backup per invocation would fill the directory
// with copies nobody asked for — and say plainly that there is nothing to do.
func TestMigratingACurrentStoreIsACleanNoOpThatCopiesNothing(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	h.mustRun("init")
	h.addTask("Already current")

	res := h.assertNoStoreChurn(t, nil, "migrate", "--json")
	if res.code != 0 {
		t.Fatalf("migrate on a current store is not an error:\n%s", res.describe())
	}
	got := h.decode(res)
	if got["from"] != float64(schema.Version) || got["to"] != float64(schema.Version) || got["migrated"] != false {
		t.Errorf("migrate shape: %v", got)
	}
	if got["backup_path"] != "" {
		t.Errorf("migrate copied a store that needed nothing: %v", got)
	}
	steps, ok := got["steps"].([]any)
	if !ok || len(steps) != 0 {
		t.Errorf("migrate reports steps it will not run: %v", got)
	}
}

// tasksInFile reads the titles straight out of a SQLite file, which is the
// only way to look inside a backup: it is not the configured store, and the
// tool offers no way to point at one.
func tasksInFile(t *testing.T, path string) []string {
	t.Helper()
	db, err := sql.Open("sqlite", fmt.Sprintf("file:%s?mode=ro", path))
	if err != nil {
		t.Fatalf("opening %s: %v", path, err)
	}
	defer db.Close()
	rows, err := db.Query(`SELECT title FROM tasks ORDER BY id`)
	if err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var title string
		if err := rows.Scan(&title); err != nil {
			t.Fatalf("scanning %s: %v", path, err)
		}
		out = append(out, title)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}
	return out
}
