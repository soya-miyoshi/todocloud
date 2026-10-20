package shortref

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"sync"
	"testing"
)

// TestPathPrecedence pins the whole search order, including the home-relative
// default and the degraded case where there is no home directory at all. The
// default matters because it is the only branch a real user takes.
func TestPathPrecedence(t *testing.T) {
	t.Run("state dir wins over XDG", func(t *testing.T) {
		t.Setenv("TODOCLOUD_STATE_DIR", "/tmp/state-dir")
		t.Setenv("XDG_STATE_HOME", "/tmp/xdg")
		if got, want := Path(), filepath.Join("/tmp/state-dir", FileName); got != want {
			t.Fatalf("got %q, want %q", got, want)
		}
	})

	t.Run("home relative default", func(t *testing.T) {
		home := t.TempDir()
		t.Setenv("TODOCLOUD_STATE_DIR", "")
		t.Setenv("XDG_STATE_HOME", "")
		t.Setenv("HOME", home)
		// os.UserHomeDir reads USERPROFILE on windows and HOME elsewhere, so
		// both are pointed at the same directory and the subtest asks the
		// same question on every platform.
		t.Setenv("USERPROFILE", home)
		want := filepath.Join(home, ".local", "state", "todocloud", FileName)
		if got := Path(); got != want {
			t.Fatalf("got %q, want %q", got, want)
		}
	})

	t.Run("no home directory at all", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("the home directory is not read from HOME on windows")
		}
		t.Setenv("TODOCLOUD_STATE_DIR", "")
		t.Setenv("XDG_STATE_HOME", "")
		t.Setenv("HOME", "")
		// Without a home directory the path stays relative, which keeps a
		// Save failure local and harmless instead of writing somewhere odd.
		if got, want := Path(), filepath.Join(".todocloud", FileName); got != want {
			t.Fatalf("got %q, want %q", got, want)
		}
	})
}

// TestSaveReplacesAFileWithLooseModes records what actually happens to a cache
// file that already exists with group- and world-readable modes: the write
// goes through, and the replacement file carries the owner-only mode, because
// Save renames a fresh temporary file over it rather than writing in place.
func TestSaveReplacesAFileWithLooseModes(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix permission bits are not meaningful on windows")
	}
	dir := t.TempDir()
	t.Setenv("TODOCLOUD_STATE_DIR", dir)

	if err := os.WriteFile(Path(), []byte(`{"key":"old","ids":["01OLD"]}`), 0o666); err != nil {
		t.Fatal(err)
	}
	if err := Save("sqlite: /tmp/new.db", []string{"01NEW"}); err != nil {
		t.Fatalf("Save over a loose-mode file: %v", err)
	}

	info, err := os.Stat(Path())
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("file mode %o after replacing a 0666 file, want 600", perm)
	}
	if got, ok := Lookup("sqlite: /tmp/new.db", 1); !ok || got != "01NEW" {
		t.Fatalf("Lookup after the rewrite returned %q, %v", got, ok)
	}
	if _, ok := Lookup("old", 1); ok {
		t.Fatal("the replaced listing is still resolving")
	}
}

// TestSaveReportsADirectoryInTheWayWithoutPanicking covers the one case where
// Save cannot do its job. The caller is allowed to ignore the error, so the
// only requirement is that it is an error and not a panic.
func TestSaveReportsADirectoryInTheWayWithoutPanicking(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("TODOCLOUD_STATE_DIR", dir)

	// A directory where the cache file belongs, with something inside it so
	// that no platform can rename over it.
	if err := os.Mkdir(Path(), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(Path(), "occupied"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := Save("key", []string{"01AAA"}); err == nil {
		t.Fatal("Save reported success although the path is a non-empty directory")
	}
	// And the caller that ignores that error must still get a plain miss.
	if _, ok := Lookup("key", 1); ok {
		t.Fatal("Lookup resolved against a directory")
	}
}

// TestSaveOfAnEmptyListing covers the nil slice: it is a legitimate listing
// of nothing, not an error, and it must clear whatever was cached before.
func TestSaveOfAnEmptyListing(t *testing.T) {
	t.Setenv("TODOCLOUD_STATE_DIR", t.TempDir())
	if err := Save("key", []string{"01AAA"}); err != nil {
		t.Fatal(err)
	}
	if err := Save("key", nil); err != nil {
		t.Fatalf("Save of a nil listing: %v", err)
	}
	if _, ok := Lookup("key", 1); ok {
		t.Fatal("a number resolved against an empty listing")
	}
	data, err := os.ReadFile(Path())
	if err != nil {
		t.Fatal(err)
	}
	if got, want := string(data), "{\"key\":\"key\",\"ids\":[]}\n"; got != want {
		t.Fatalf("on-disk form %q, want %q", got, want)
	}
}

// TestSaveReportsAnUnusableStateDirectory covers the two failures that happen
// before any byte is written: the directory cannot be created, and it cannot
// be written to. Neither may panic.
func TestSaveReportsAnUnusableStateDirectory(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("directory permissions behave differently on windows")
	}
	t.Run("a file where the directory belongs", func(t *testing.T) {
		dir := t.TempDir()
		blocker := filepath.Join(dir, "state")
		if err := os.WriteFile(blocker, []byte("not a directory"), 0o600); err != nil {
			t.Fatal(err)
		}
		t.Setenv("TODOCLOUD_STATE_DIR", blocker)
		if err := Save("key", []string{"01AAA"}); err == nil {
			t.Fatal("Save reported success although the state directory is a file")
		}
	})

	t.Run("an unwritable directory", func(t *testing.T) {
		if os.Geteuid() == 0 {
			t.Skip("root writes to a read-only directory regardless of its mode")
		}
		dir := t.TempDir()
		state := filepath.Join(dir, "state")
		if err := os.Mkdir(state, 0o500); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Chmod(state, 0o700) })
		t.Setenv("TODOCLOUD_STATE_DIR", state)
		if err := Save("key", []string{"01AAA"}); err == nil {
			t.Fatal("Save reported success although the state directory is read-only")
		}
	})
}

// TestLookupNeverFailsOnHostileInput extends the existing corruption table
// with the cases that come from the filesystem rather than the file's bytes.
func TestLookupNeverFailsOnHostileInput(t *testing.T) {
	t.Run("truncated json", func(t *testing.T) {
		t.Setenv("TODOCLOUD_STATE_DIR", t.TempDir())
		body := `{"key":"k","ids":["01AAA","01BB`
		if err := os.WriteFile(Path(), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, ok := Lookup("k", 1); ok {
			t.Fatal("a truncated listing resolved")
		}
	})

	t.Run("empty file", func(t *testing.T) {
		t.Setenv("TODOCLOUD_STATE_DIR", t.TempDir())
		if err := os.WriteFile(Path(), nil, 0o600); err != nil {
			t.Fatal(err)
		}
		if _, ok := Lookup("k", 1); ok {
			t.Fatal("an empty file resolved")
		}
	})

	t.Run("directory in place of the file", func(t *testing.T) {
		t.Setenv("TODOCLOUD_STATE_DIR", t.TempDir())
		if err := os.Mkdir(Path(), 0o700); err != nil {
			t.Fatal(err)
		}
		if _, ok := Lookup("k", 1); ok {
			t.Fatal("a directory resolved")
		}
	})

	t.Run("unreadable file", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("a file cannot be made unreadable to its owner on windows")
		}
		if os.Geteuid() == 0 {
			t.Skip("root reads a 0000 file regardless of its mode")
		}
		t.Setenv("TODOCLOUD_STATE_DIR", t.TempDir())
		if err := os.WriteFile(Path(), []byte(`{"key":"k","ids":["01AAA"]}`), 0o000); err != nil {
			t.Fatal(err)
		}
		if _, ok := Lookup("k", 1); ok {
			t.Fatal("an unreadable file resolved")
		}
	})

	t.Run("a very long listing", func(t *testing.T) {
		t.Setenv("TODOCLOUD_STATE_DIR", t.TempDir())
		const count = 100_000
		ids := make([]string, count)
		for i := range ids {
			ids[i] = "01" + strconv.Itoa(i)
		}
		if err := Save("big", ids); err != nil {
			t.Fatalf("Save of %d ids: %v", count, err)
		}
		if got, ok := Lookup("big", count); !ok || got != ids[count-1] {
			t.Fatalf("the last of %d ids returned %q, %v", count, got, ok)
		}
		if _, ok := Lookup("big", count+1); ok {
			t.Fatal("a number past the end of a long listing resolved")
		}
	})
}

// TestConcurrentSaveAndLookup runs the cache the way two shells sharing a
// state directory would. Save writes a temporary file and renames it over the
// target, so a reader must see one whole listing or none — never a half-written
// one. Run with -race this also covers the unsynchronized package state.
func TestConcurrentSaveAndLookup(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("TODOCLOUD_STATE_DIR", dir)

	const rounds = 200
	keys := []string{"sqlite: /tmp/one.db", "sqlite: /tmp/two.db"}

	var wg sync.WaitGroup
	for w, key := range keys {
		wg.Add(1)
		go func(w int, key string) {
			defer wg.Done()
			for i := 0; i < rounds; i++ {
				ids := []string{fmt.Sprintf("01WRITER%dITEM%d", w, i), "01SECOND"}
				// An error is allowed — two writers may collide — but it must
				// never be a panic and never a partial file.
				_ = Save(key, ids)
			}
		}(w, key)
	}

	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < rounds*2; i++ {
			for _, key := range keys {
				// Either a hit or a miss is correct; only a panic is not.
				_, _ = Lookup(key, 1)
			}
		}
	}()
	wg.Wait()

	// Whatever is on disk at the end must parse: either nothing, or one
	// complete listing from one of the writers.
	data, err := os.ReadFile(Path())
	if err != nil {
		if os.IsNotExist(err) {
			return
		}
		t.Fatalf("reading the cache after concurrent writes: %v", err)
	}
	var l struct {
		Key string   `json:"key"`
		IDs []string `json:"ids"`
	}
	if err := json.Unmarshal(data, &l); err != nil {
		t.Fatalf("the cache left behind does not parse: %q: %v", data, err)
	}
	if l.Key != keys[0] && l.Key != keys[1] {
		t.Fatalf("the cache names a store no writer used: %q", l.Key)
	}
	if len(l.IDs) != 2 || l.IDs[1] != "01SECOND" {
		t.Fatalf("the cache holds a partial listing: %q", data)
	}

	// No temporary file may be left behind by a completed Save.
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if e.Name() != FileName {
			t.Fatalf("Save left %q behind in the state directory", e.Name())
		}
	}
}
