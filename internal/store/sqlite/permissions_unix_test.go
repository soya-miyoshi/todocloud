//go:build unix

package sqlite

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/soya-miyoshi/todocloud/internal/id"
	"github.com/soya-miyoshi/todocloud/internal/task"
)

// A task list is private data, and SQLite creates its files with the process
// umask — which on a typical machine means world-readable. Everything this
// store writes has to be 0600 regardless of the umask it inherited.
func TestCreatedFilesAreNotReadableByOthers(t *testing.T) {
	// A deliberately permissive umask: the store must not inherit it.
	old := syscall.Umask(0o000)
	defer syscall.Umask(old)

	dir := filepath.Join(t.TempDir(), "data")
	path := filepath.Join(dir, "tasks.db")

	st, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer st.Close()

	ctx := context.Background()
	if err := st.Init(ctx); err != nil {
		t.Fatalf("Init: %v", err)
	}
	// A write forces the WAL files into existence, which are the ones that
	// come and go and would otherwise be missed.
	now := time.Now().UTC()
	if err := st.Add(ctx, &task.Task{
		ID: id.New(), Kind: task.KindTask, Title: "private", Status: task.StatusActive,
		CreatedAt: now, UpdatedAt: now, Fields: task.Fields{},
	}); err != nil {
		t.Fatalf("Add: %v", err)
	}

	assertMode(t, dir, 0o700)
	assertMode(t, path, fileMode)
	for _, suffix := range []string{"-wal", "-shm"} {
		journal := path + suffix
		if _, err := os.Stat(journal); err == nil {
			assertMode(t, journal, fileMode)
		}
	}
}

// An existing database whose mode is loose gets tightened when it is opened,
// because a file that was created before this behaviour existed — or by a
// restore from a backup — is just as readable as a new one.
func TestOpeningTightensALooseMode(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tasks.db")
	st, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err := st.Init(context.Background()); err != nil {
		t.Fatalf("Init: %v", err)
	}
	st.Close()

	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatalf("Chmod: %v", err)
	}

	reopened, err := OpenExisting(path)
	if err != nil {
		t.Fatalf("OpenExisting: %v", err)
	}
	defer reopened.Close()

	assertMode(t, path, fileMode)
}

func assertMode(t *testing.T, path string, want fs.FileMode) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat %s: %v", path, err)
	}
	if got := info.Mode().Perm(); got != want {
		t.Errorf("%s has mode %04o, want %04o", path, got, want)
	}
}
