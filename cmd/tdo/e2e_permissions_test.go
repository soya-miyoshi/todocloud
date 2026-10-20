package main

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/soya-miyoshi/todocloud/internal/shortref"
)

// A task list is private data, so the files tdo creates are its own business
// and nobody else's. These tests check the modes of what the real binary
// created, not what the code says it asks for.

// assertMode fails unless path exists with exactly the permission bits given.
func assertMode(t *testing.T, path string, want os.FileMode) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	if got := info.Mode().Perm(); got != want {
		t.Errorf("%s has mode %04o, want %04o", path, got, want)
	}
}

// TestCreatedFilesAreNotReadableByAnyoneElse checks the three files the tool
// brings into being: the database, the directory it put it in, and the
// short-number cache in the state directory.
func TestCreatedFilesAreNotReadableByAnyoneElse(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix permission bits have no equivalent on Windows")
	}
	t.Parallel()
	h := newHarness(t)

	h.mustRun("init")
	assertMode(t, h.db, 0o600)
	assertMode(t, h.data, 0o700)

	// The cache is written by a listing, not by init.
	h.addTask("Cache me")
	h.mustRun("ls")
	cache := filepath.Join(h.state, shortref.FileName)
	assertMode(t, cache, 0o600)
	assertMode(t, h.state, 0o700)
}

// TestALoosePermissiveUmaskIsNotInherited runs the same check with the umask
// opened all the way up. The tool has to set the modes itself rather than
// leave them to the environment it happened to be started from.
//
// It cannot run in parallel: the umask is process-wide, and the subprocess
// inherits whatever it is at fork time.
func TestALoosePermissiveUmaskIsNotInherited(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix permission bits have no equivalent on Windows")
	}
	restore, ok := setUmask(0o000)
	if !ok {
		t.Skip("the umask cannot be set on this platform")
	}
	defer restore()

	h := newHarness(t)
	h.mustRun("init")
	h.addTask("Written under a wide-open umask")
	h.mustRun("ls")

	assertMode(t, h.db, 0o600)
	assertMode(t, h.data, 0o700)
	assertMode(t, filepath.Join(h.state, shortref.FileName), 0o600)

	// The journal files WAL mode creates beside the database carry the same
	// data, so they are held to the same standard whenever they are present.
	for _, suffix := range []string{"-wal", "-shm"} {
		path := h.db + suffix
		if _, err := os.Stat(path); err != nil {
			continue
		}
		assertMode(t, path, 0o600)
	}
}
