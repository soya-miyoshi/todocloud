package storetest

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"testing"

	"github.com/soya-miyoshi/todocloud/internal/store"
	"github.com/soya-miyoshi/todocloud/internal/store/schema"
)

// runVersionMarker checks the one number every command trusts.
//
// The recorded version decides whether a binary believes it understands the
// rows it is about to read, so the ways of writing it have to leave it
// telling the truth. The case that motivated this: Init is idempotent, so it
// meets stores that already have a schema — including one a newer tdo wrote.
// Stamping this binary's version over a higher one leaves the marker
// describing a schema that is not there, and from then on every version
// check passes while the two disagree. Nothing later can detect it.
func runVersionMarker(t *testing.T, h SQL) {
	t.Helper()
	ctx := context.Background()

	t.Run("a second Init does not change the recorded version", func(t *testing.T) {
		s := newInitialized(t, h, ctx)
		if err := s.Init(ctx); err != nil {
			t.Fatalf("Init must be idempotent, but a second call failed: %v", err)
		}
		requireVersion(t, h, s, schema.Version, "after a second Init")
	})

	t.Run("Migrate on a current store is a clean no-op", func(t *testing.T) {
		s := newInitialized(t, h, ctx)
		if err := s.Migrate(ctx); err != nil {
			t.Fatalf("Migrate on a current store must succeed and do nothing: %v", err)
		}
		requireVersion(t, h, s, schema.Version, "after Migrate on a current store")
	})

	// Both writers must refuse a store from the future rather than rewrite
	// its marker downwards.
	newer := schema.Version + 1
	for _, tc := range []struct {
		name string
		call func(store.Store) error
	}{
		{"Init", func(s store.Store) error { return s.Init(ctx) }},
		{"Migrate", func(s store.Store) error { return s.Migrate(ctx) }},
	} {
		t.Run(tc.name+" refuses a store written by a newer tdo", func(t *testing.T) {
			s := newInitialized(t, h, ctx)
			setVersion(t, h, s, newer)

			err := tc.call(s)
			if err == nil {
				t.Errorf("%s against a store at version %d must refuse; it reported success", tc.name, newer)
			} else {
				if !errors.Is(err, store.ErrSchemaMismatch) {
					t.Errorf("%s returned %v, which is not a store.ErrSchemaMismatch; that sentinel is what the command layer maps to exit 3", tc.name, err)
				}
				var ve *store.VersionError
				if errors.As(err, &ve) && ve.Found != newer {
					t.Errorf("%s reported the store at version %d, want %d", tc.name, ve.Found, newer)
				}
			}
			requireVersion(t, h, s, newer, "after "+tc.name+" refused")
		})
	}
}

// newInitialized returns a store with the current schema in it.
func newInitialized(t *testing.T, h SQL, ctx context.Context) store.Store {
	t.Helper()
	s := h.New(t)
	t.Cleanup(func() { _ = s.Close() })
	if err := s.Init(ctx); err != nil {
		t.Fatalf("Init on an empty store: %v", err)
	}
	return s
}

func setVersion(t *testing.T, h SQL, s store.Store, v int) {
	t.Helper()
	h.Exec(t, s, fmt.Sprintf(
		`INSERT INTO meta (key, value) VALUES (%s, '%d')
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		quote(schema.MetaKey), v))
}

func requireVersion(t *testing.T, h SQL, s store.Store, want int, when string) {
	t.Helper()
	rows := h.Query(t, s, fmt.Sprintf(`SELECT value FROM meta WHERE key = %s`, quote(schema.MetaKey)))
	if len(rows) != 1 || len(rows[0]) != 1 {
		t.Fatalf("%s: the meta table holds %d version row(s), want exactly 1", when, len(rows))
	}
	got, err := strconv.Atoi(rows[0][0])
	if err != nil {
		t.Fatalf("%s: the recorded version %q is not a number", when, rows[0][0])
	}
	if got != want {
		t.Errorf("%s: the recorded schema version is %d, want %d", when, got, want)
	}
}

// quote renders a SQL string literal. The only values it ever sees are this
// package's own constants, but doubling the quote keeps it honest.
func quote(s string) string {
	out := make([]byte, 0, len(s)+2)
	out = append(out, '\'')
	for i := 0; i < len(s); i++ {
		if s[i] == '\'' {
			out = append(out, '\'')
		}
		out = append(out, s[i])
	}
	return string(append(out, '\''))
}
