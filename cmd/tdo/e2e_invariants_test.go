package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// This file holds the heart of the suite: proof, by watching the filesystem
// around every invocation, that a database comes into being only when the
// user asked for one with `tdo init`, and that nothing — `tdo rm --purge`
// included — ever takes one away.

// assertOnlyInitCreates runs a command and asserts that the set of paths under
// the data directory changed only in the way the caller allows: wantAdded
// lists the relative paths the command may bring into being, and nothing may
// ever disappear.
//
// It returns the command's result so a caller can assert on it as well.
func (h *harness) assertNoStoreChurn(t *testing.T, wantAdded []string, args ...string) result {
	t.Helper()
	before := snapshotDir(t, h.data)
	res := h.run(args...)
	after := snapshotDir(t, h.data)

	gone := removed(before, after)
	if len(gone) != 0 {
		t.Errorf("tdo %s removed %v from the data directory — nothing may ever delete a database\nbefore %v\nafter %v",
			strings.Join(args, " "), gone, before, after)
	}
	allowed := make(map[string]bool, len(wantAdded))
	for _, p := range wantAdded {
		allowed[p] = true
	}
	for _, p := range added(before, after) {
		// WAL mode creates and drops -wal and -shm beside the database as
		// connections come and go; those are the store's own scratch files,
		// not a second task list, so they are always allowed.
		if allowed[p] || strings.HasSuffix(p, "-wal") || strings.HasSuffix(p, "-shm") {
			continue
		}
		t.Errorf("tdo %s created %q, which only `tdo init` may do\nbefore %v\nafter %v",
			strings.Join(args, " "), p, before, after)
	}
	return res
}

// TestOnlyInitEverCreatesTheDatabase walks a whole session with a snapshot
// taken around every command: only init adds tasks.db, and no command removes
// it.
func TestOnlyInitEverCreatesTheDatabase(t *testing.T) {
	t.Parallel()
	h := newHarness(t)

	empty := snapshotDir(t, h.data)
	if empty.exists {
		t.Fatalf("the data directory existed before anything ran: %v", empty)
	}

	// init is the one command allowed to create the database.
	res := h.assertNoStoreChurn(t, []string{"tasks.db"}, "init", "--json")
	if res.code != 0 {
		t.Fatalf("init failed:\n%s", res.describe())
	}
	if snap := snapshotDir(t, h.data); !snap.has("tasks.db") {
		t.Fatalf("init did not create the database: %v", snap)
	}

	id := h.addTask("Something to do")
	other := h.addTask("Something else")
	archive := filepath.Join(h.root, "archive.json")
	export := h.mustRun("export", "--json", "--all")
	if err := os.WriteFile(archive, []byte(export.stdout), 0o600); err != nil {
		t.Fatalf("writing the archive: %v", err)
	}

	// Everything else may only write rows. Each of these is snapshotted.
	for _, args := range [][]string{
		{"ls", "--json"},
		{"ls", "--json", "--all"},
		{"ls", "--json", "--deleted"},
		{"ls", "--json", "--tree"},
		{"show", "--json", id},
		{"next", "--json"},
		{"inbox", "--json"},
		{"inbox", "--json", "--count"},
		{"review", "--json"},
		{"series", "--json", id},
		{"folder", "add", "--json", "Home"},
		{"project", "add", "--json", "Errands", "--folder", "Home"},
		{"project", "ls", "--json"},
		{"folder", "ls", "--json"},
		{"perspective", "save", "flagged", "--", "--flagged"},
		{"perspective", "ls", "--json"},
		{"ls", "--json", "--perspective", "flagged"},
		{"perspective", "rm", "flagged"},
		{"flag", "--json", id},
		{"unflag", "--json", id},
		{"hold", "--json", id},
		{"unhold", "--json", id},
		{"defer", "--json", id, "2030-01-01"},
		{"defer", "--json", id, "--clear"},
		{"due", "--json", id, "2030-01-01"},
		{"due", "--json", id, "--clear"},
		{"repeat", "--json", id, "1w"},
		{"repeat", "--json", id, "--stop"},
		{"mv", "--json", id, "--inbox"},
		{"drop", "--json", id},
		{"add", "--json", "One more"},
		{"done", "--json", id},
		{"undone", "--json", id},
		{"edit", "--json", id, "--title", "Renamed"},
		{"export", "--json"},
		{"import", "--json", archive},
		{"migrate", "--json"},
		{"doctor", "--json"},
		{"config", "--json"},
		{"version", "--json"},
		{"rm", "--json", id},
		{"rm", "--json", "--purge", "--yes", other},
	} {
		res := h.assertNoStoreChurn(t, nil, args...)
		if res.code != 0 {
			t.Errorf("expected success:\n%s", res.describe())
		}
	}

	if snap := snapshotDir(t, h.data); !snap.has("tasks.db") {
		t.Fatalf("the database is gone after a full session: %v", snap)
	}
}

// TestRemoveAndPurgeLeaveTheDatabaseInPlace pins down the one command whose
// name suggests it might delete a file. It removes rows; the file stays.
func TestRemoveAndPurgeLeaveTheDatabaseInPlace(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	h.mustRun("init")
	tombstoned := h.addTask("To be tombstoned")
	purged := h.addTask("To be purged")
	kept := h.addTask("To be kept")

	before, err := os.Stat(h.db)
	if err != nil {
		t.Fatalf("stat the database: %v", err)
	}

	h.mustRun("rm", "--json", tombstoned)
	if _, err := os.Stat(h.db); err != nil {
		t.Fatalf("tdo rm removed the database file: %v", err)
	}

	purge := h.mustRun("rm", "--json", "--purge", "--yes", purged)
	purgedIDs, ok := h.decode(purge)["purged"].([]any)
	if !ok || len(purgedIDs) != 1 || fmt.Sprint(purgedIDs[0]) != purged {
		t.Errorf("rm --purge reported %v, want the one id %s", h.decode(purge), purged)
	}
	info, err := os.Stat(h.db)
	if err != nil {
		t.Fatalf("tdo rm --purge removed the database file: %v", err)
	}
	if info.Mode().IsRegular() != before.Mode().IsRegular() {
		t.Errorf("the database stopped being a regular file")
	}

	// Only the contents changed: the tombstoned task is visible under
	// --deleted, the purged one is gone from the store entirely, and the
	// untouched one is still pending.
	// export is the one listing that holds everything, tombstones included.
	all := h.tasksOf(h.mustRun("export", "--json", "--all"))
	got := titles(all)
	if strings.Join(got, ",") != "To be kept,To be tombstoned" {
		t.Errorf("export --all = %v, want the kept and the tombstoned task", got)
	}
	for _, task := range all {
		if task["title"] == "To be tombstoned" && task["deleted_at"] == nil {
			t.Errorf("the tombstoned task has no deleted_at: %v", task)
		}
		if task["title"] == "To be kept" && task["deleted_at"] != nil {
			t.Errorf("the kept task was tombstoned: %v", task)
		}
	}
	if pending := titles(h.tasksOf(h.mustRun("ls", "--json"))); strings.Join(pending, ",") != "To be kept" {
		t.Errorf("the default listing = %v, want only the kept task", pending)
	}
	// The purged id is gone from the store, while the kept one still
	// resolves: a purge removed rows and nothing else.
	if res := h.run("show", "--json", purged); res.code != 5 {
		t.Errorf("the purged id still resolves (exit %d, want 5):\n%s", res.code, res.describe())
	}
	if task := h.taskOf(h.mustRun("show", "--json", kept)); task["title"] != "To be kept" {
		t.Errorf("the kept task reads back as %v", task)
	}
}

// TestNoCommandCreatesAnythingUnderAMissingParent is the table the contract
// asks for: against a path whose parent directory does not exist, every
// command other than init exits 3 and leaves no file and no directory behind.
func TestNoCommandCreatesAnythingUnderAMissingParent(t *testing.T) {
	t.Parallel()

	// A file in the current directory for import to name, so that import
	// fails because the store is missing rather than because the file is.
	cases := [][]string{
		{"ls"},
		{"show", "01J00000000000000000000000"},
		{"add", "Nope"},
		{"done", "01J00000000000000000000000"},
		{"undone", "01J00000000000000000000000"},
		{"edit", "01J00000000000000000000000", "--title", "Nope"},
		{"rm", "01J00000000000000000000000"},
		{"export"},
		{"import", "IMPORT_FILE"},
		{"migrate"},
		{"doctor"},
		{"config"},
	}

	for _, args := range cases {
		args := args
		t.Run(args[0], func(t *testing.T) {
			t.Parallel()
			h := newHarness(t)

			// The database is to live three levels below a directory that
			// does not exist, so that creating it would have to create
			// parents too — and both are watched.
			missing := filepath.Join(h.root, "missing")
			deep := filepath.Join(missing, "a", "b")
			h.env = h.childEnv(filepath.Join(deep, "tasks.db"))

			archive := filepath.Join(h.root, "import.json")
			if err := os.WriteFile(archive, []byte(`{"version":1,"tasks":[]}`), 0o600); err != nil {
				t.Fatalf("writing the import file: %v", err)
			}
			run := make([]string, len(args))
			for i, a := range args {
				if a == "IMPORT_FILE" {
					a = archive
				}
				run[i] = a
			}

			res := h.run(run...)
			// Every command that opens the store reports the documented
			// configuration failure. The two that do not open it are held to
			// what docs/agents.md says instead: `doctor` exits 1 and still
			// prints its report, and `config` only resolves the
			// configuration, which succeeds against a path that does not
			// exist yet. Neither may create anything, which is the point of
			// the test for all twelve.
			want := 3
			switch args[0] {
			case "doctor":
				want = 1
			case "config":
				want = 0
			}
			if res.code != want {
				t.Errorf("tdo %s exited %d, want %d:\n%s", strings.Join(args, " "), res.code, want, res.describe())
			}
			if _, err := os.Stat(missing); err == nil {
				t.Errorf("tdo %s created %s, which no command but init may do:\n%s\n%v",
					strings.Join(args, " "), missing, res.describe(), snapshotDir(t, missing))
			}
		})
	}
}

// TestInitTwiceKeepsTheExistingStore asserts that a second init is reported as
// a no-op and does not reset the file: the size does not shrink, the
// modification time is not pushed forward by a recreation, and the task added
// in between is still there.
func TestInitTwiceKeepsTheExistingStore(t *testing.T) {
	t.Parallel()
	h := newHarness(t)

	first := h.decode(h.mustRun("init", "--json"))
	if first["created"] != true {
		t.Fatalf("the first init did not report created=true: %v", first)
	}
	h.addTask("Survive the second init")

	before, err := os.Stat(h.db)
	if err != nil {
		t.Fatalf("stat the database: %v", err)
	}

	second := h.decode(h.mustRun("init", "--json"))
	if second["created"] != false {
		t.Errorf("the second init reported created=%#v, want false", second["created"])
	}
	if second["initialized"] != true {
		t.Errorf("the second init reported initialized=%#v, want true", second["initialized"])
	}

	after, err := os.Stat(h.db)
	if err != nil {
		t.Fatalf("the second init removed the database: %v", err)
	}
	if after.Size() < before.Size() {
		t.Errorf("the database shrank across a second init: %d -> %d bytes", before.Size(), after.Size())
	}
	// A recreated file would have a later modification time. Allowing it to
	// be equal, and only equal, is what "it was not reset" means here.
	if !after.ModTime().Equal(before.ModTime()) {
		t.Errorf("the second init rewrote the database: mtime %s -> %s",
			before.ModTime().Format(time.RFC3339Nano), after.ModTime().Format(time.RFC3339Nano))
	}

	got := titles(h.tasksOf(h.mustRun("ls", "--json", "--all")))
	if strings.Join(got, ",") != "Survive the second init" {
		t.Errorf("after a second init the store holds %v", got)
	}
}

// TestASecondDatabasePathDoesNotTouchTheFirst walks the two-store case: a
// mistyped or deliberately changed TODOCLOUD_SQLITE_PATH is a different task
// list, and neither store leaks into the other.
func TestASecondDatabasePathDoesNotTouchTheFirst(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	h.mustRun("init")
	h.addTask("Lives in A")

	infoA, err := os.Stat(h.db)
	if err != nil {
		t.Fatalf("stat A: %v", err)
	}

	b := h.second("store-b")
	// Before B is initialised it does not exist, and a read refuses rather
	// than creating a second, empty list.
	if res := b.run("ls", "--json"); res.code != 3 {
		t.Errorf("ls against an uninitialised second store exited %d, want 3:\n%s", res.code, res.describe())
	}
	b.mustRun("init")
	b.addTask("Lives in B")

	// A is untouched: same size, same modification time, same contents.
	afterA, err := os.Stat(h.db)
	if err != nil {
		t.Fatalf("stat A after using B: %v", err)
	}
	if afterA.Size() != infoA.Size() || !afterA.ModTime().Equal(infoA.ModTime()) {
		t.Errorf("working in B changed A: %d bytes at %s -> %d bytes at %s",
			infoA.Size(), infoA.ModTime(), afterA.Size(), afterA.ModTime())
	}
	if got := titles(h.tasksOf(h.mustRun("ls", "--json", "--all"))); strings.Join(got, ",") != "Lives in A" {
		t.Errorf("A holds %v", got)
	}
	if got := titles(b.tasksOf(b.mustRun("ls", "--json", "--all"))); strings.Join(got, ",") != "Lives in B" {
		t.Errorf("B holds %v", got)
	}
}
