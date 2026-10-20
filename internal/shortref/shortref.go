// Package shortref remembers the ids of the last listing, so that the short
// numbers `tdo ls` prints can be typed at the next command.
//
// Typing a 26-character ULID is not a user interface, and an id prefix still
// means reading one off the screen. So `tdo ls` numbers its rows and the
// numbers are resolved here, out of a small file in the user's state
// directory. The file records which store the listing came from, because a
// number that means "pay the invoice" on one provider must never resolve to
// something else on another.
//
// Nothing in this package is allowed to be fatal. A missing, truncated or
// unreadable cache is an ordinary cache miss: the caller falls back to an id
// prefix or reports a clear not-found error.
package shortref

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// FileName is the name of the cache file inside the state directory.
const FileName = "lastlist.json"

// listing is the on-disk form.
type listing struct {
	// Key identifies the store the ids came from.
	Key string `json:"key"`
	// IDs are the task ids in the order they were printed; the short number
	// of an id is its index plus one.
	IDs []string `json:"ids"`
}

// Path returns the file the cache is kept in. It honours TODOCLOUD_STATE_DIR
// first, so a test (or a user with several profiles) can redirect it, then
// XDG_STATE_HOME, and finally the XDG default.
func Path() string {
	if dir := os.Getenv("TODOCLOUD_STATE_DIR"); dir != "" {
		return filepath.Join(dir, FileName)
	}
	if dir := os.Getenv("XDG_STATE_HOME"); dir != "" {
		return filepath.Join(dir, "todocloud", FileName)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		// Without a home directory there is nowhere sensible to put the
		// cache; the relative path keeps Save's error local and harmless.
		return filepath.Join(".todocloud", FileName)
	}
	return filepath.Join(home, ".local", "state", "todocloud", FileName)
}

// Save records ids as the listing produced by the store named key. The file is
// written with mode 0600 in the user's own state directory; it holds task ids,
// never a credential.
func Save(key string, ids []string) error {
	if ids == nil {
		ids = []string{}
	}
	data, err := json.Marshal(listing{Key: key, IDs: ids})
	if err != nil {
		return err
	}

	path := Path()
	if dir := filepath.Dir(path); dir != "" {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return err
		}
	}
	// Write through a temporary file so an interrupted write cannot leave a
	// half-written listing behind.
	tmp, err := os.CreateTemp(filepath.Dir(path), FileName+".*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(append(data, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// Lookup returns the id the store named key printed as number n. It reports
// false for a number out of range, for a listing from a different store, and
// for every kind of unreadable or corrupt file.
func Lookup(key string, n int) (string, bool) {
	if n < 1 {
		return "", false
	}
	data, err := os.ReadFile(Path())
	if err != nil {
		return "", false
	}
	var l listing
	if err := json.Unmarshal(data, &l); err != nil {
		return "", false
	}
	if l.Key != key || n > len(l.IDs) {
		return "", false
	}
	id := l.IDs[n-1]
	if id == "" {
		return "", false
	}
	return id, true
}
