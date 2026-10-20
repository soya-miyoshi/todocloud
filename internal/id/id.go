// Package id generates and matches task identifiers.
//
// Ids are ULIDs: 26 Crockford base32 characters whose leading bits are a
// millisecond timestamp. They are generated on this machine, which every
// provider needs — Firestore has no autoincrement and the SQL providers should
// not have to read back an inserted row — and they sort lexicographically by
// creation time, so one ORDER BY works everywhere. Users rarely type one: the
// CLI resolves the short numbers `tdo ls` prints, and accepts an unambiguous
// id prefix as well.
package id

import (
	"crypto/rand"
	"fmt"
	"strings"
	"sync"

	"github.com/oklog/ulid/v2"
)

// Length is the number of characters in a full id.
const Length = 26

// entropy is monotonic: within one millisecond it increments the previous
// value instead of drawing a fresh random one, so ids generated in a burst —
// `tdo import`, a script adding several tasks — keep the order they were
// created in. A ULID's timestamp is only millisecond-resolution, so plain
// random entropy would order a burst arbitrarily, and the whole point of
// sorting by id is that it matches creation order.
//
// It is guarded by a mutex because the generator is not safe for concurrent
// use, and nothing should have to think about that at the call site.
var entropy = struct {
	sync.Mutex
	source *ulid.MonotonicEntropy
}{source: ulid.Monotonic(rand.Reader, 0)}

// New returns a new id for a task created now.
func New() string {
	entropy.Lock()
	defer entropy.Unlock()
	return ulid.MustNew(ulid.Now(), entropy.source).String()
}

// Valid reports whether s is a syntactically complete id.
func Valid(s string) bool {
	_, err := ulid.ParseStrict(strings.ToUpper(s))
	return err == nil
}

// Normalize upper-cases an id or prefix, since base32 is case-insensitive and
// a user may paste a lower-cased copy.
func Normalize(s string) string {
	return strings.ToUpper(strings.TrimSpace(s))
}

// ValidPrefix reports whether s could be the start of an id. It rejects the
// characters Crockford base32 excludes, so a typo is reported as a bad
// reference rather than silently matching nothing.
func ValidPrefix(s string) bool {
	if s == "" || len(s) > Length {
		return false
	}
	for _, r := range Normalize(s) {
		if !strings.ContainsRune(alphabet, r) {
			return false
		}
	}
	return true
}

// alphabet is Crockford base32: no I, L, O or U.
const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// Short returns the leading n characters of an id, for display.
func Short(id string, n int) string {
	if n <= 0 || n >= len(id) {
		return id
	}
	return id[:n]
}

// ErrBadPrefix describes a reference that cannot be an id prefix.
func ErrBadPrefix(ref string) error {
	return fmt.Errorf("%q is neither a task number nor an id prefix", ref)
}
