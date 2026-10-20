package shortref

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSaveAndLookup(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("TODOCLOUD_STATE_DIR", dir)

	ids := []string{"01AAA", "01BBB", "01CCC"}
	if err := Save("sqlite: /tmp/tasks.db", ids); err != nil {
		t.Fatal(err)
	}

	for i, want := range ids {
		got, ok := Lookup("sqlite: /tmp/tasks.db", i+1)
		if !ok || got != want {
			t.Fatalf("number %d: got %q, %v; want %q", i+1, got, ok, want)
		}
	}
	if _, ok := Lookup("sqlite: /tmp/tasks.db", 4); ok {
		t.Fatal("a number past the end of the listing must miss")
	}
	if _, ok := Lookup("sqlite: /tmp/tasks.db", 0); ok {
		t.Fatal("numbering starts at one")
	}
}

// TestLookupIsScopedToOneStore is the point of the key: a number read off a
// listing of one provider must never resolve against another.
func TestLookupIsScopedToOneStore(t *testing.T) {
	t.Setenv("TODOCLOUD_STATE_DIR", t.TempDir())
	if err := Save("sqlite: /tmp/one.db", []string{"01AAA"}); err != nil {
		t.Fatal(err)
	}
	if _, ok := Lookup("sqlite: /tmp/two.db", 1); ok {
		t.Fatal("a listing from another store must not resolve")
	}
}

func TestSaveUsesOwnerOnlyPermissions(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("TODOCLOUD_STATE_DIR", filepath.Join(dir, "state"))
	if err := Save("sqlite: /tmp/tasks.db", []string{"01AAA"}); err != nil {
		t.Fatal(err)
	}

	info, err := os.Stat(Path())
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("file mode %o, want 600", perm)
	}
	dirInfo, err := os.Stat(filepath.Dir(Path()))
	if err != nil {
		t.Fatal(err)
	}
	if perm := dirInfo.Mode().Perm(); perm != 0o700 {
		t.Fatalf("directory mode %o, want 700", perm)
	}
}

// TestLookupNeverFails covers every way the cache can be unusable. A miss is
// the only acceptable outcome; nothing here may panic or return an error.
func TestLookupNeverFails(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("TODOCLOUD_STATE_DIR", dir)

	if _, ok := Lookup("key", 1); ok {
		t.Fatal("a missing file should miss")
	}
	for _, content := range []string{"", "{not json", "[]", `{"key":"key","ids":null}`, `{"key":"key","ids":[""]}`} {
		if err := os.WriteFile(Path(), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, ok := Lookup("key", 1); ok {
			t.Fatalf("content %q should miss", content)
		}
	}
}

func TestPathHonoursTheStateDirectory(t *testing.T) {
	t.Setenv("TODOCLOUD_STATE_DIR", "/tmp/explicit")
	if got, want := Path(), filepath.Join("/tmp/explicit", FileName); got != want {
		t.Fatalf("got %q, want %q", got, want)
	}

	t.Setenv("TODOCLOUD_STATE_DIR", "")
	t.Setenv("XDG_STATE_HOME", "/tmp/xdg")
	if got, want := Path(), filepath.Join("/tmp/xdg", "todocloud", FileName); got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}
