package sqlite

import (
	"context"
	"path/filepath"
	"testing"
)

// Tightening must never be a reason to refuse: a store on a filesystem that
// does not support chmod still has to open.
func TestAFailedChmodDoesNotFailTheOpen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tasks.db")
	st, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err := st.Init(context.Background()); err != nil {
		t.Fatalf("Init: %v", err)
	}
	st.Close()

	// secureFiles is called on every open and ignores its failures; calling it
	// against a store whose files are gone exercises that path.
	gone := &Store{path: filepath.Join(t.TempDir(), "missing", "tasks.db")}
	gone.secureFiles() // must not panic

	memory := &Store{path: MemoryPath}
	memory.secureFiles() // must not panic, and has nothing to chmod
}
