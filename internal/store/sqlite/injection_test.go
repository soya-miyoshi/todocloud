package sqlite

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/soya-miyoshi/todocloud/internal/store"
	"github.com/soya-miyoshi/todocloud/internal/task"
)

// Everything this layer writes comes from a user file or a command line, and
// all of it goes through placeholders. These tests drive the values that would
// break a store that built SQL by concatenation, and the LIKE metacharacters
// that the one hand-written pattern in this package has to escape.

// assertNoDriverLeak fails when an error quotes SQL or the driver at the user.
func assertNoDriverLeak(t *testing.T, err error) {
	t.Helper()
	if err == nil {
		return
	}
	msg := err.Error()
	for _, leak := range []string{"SQL logic error", "syntax error", "SQLITE_", "modernc.org", "near \""} {
		if strings.Contains(msg, leak) {
			t.Errorf("the error leaks the driver: %q", msg)
		}
	}
}

// hostileFieldValues are the field values that must be stored verbatim.
func hostileFieldValues() task.Fields {
	return task.Fields{
		`key "with" a quote`:      "value",
		`key\with\backslash`:      `value\with\backslash`,
		"key\nwith\na\nline":      "value\nwith\na\nline",
		"key%with_wildcards":      "100%_done",
		"'; DROP TABLE tasks":     `'; DROP TABLE tasks; --`,
		"nul\x00key":              "nul\x00value",
		"tab\tkey":                "tab\tvalue",
		strings.Repeat("k", 1000): "a thousand-character key",
	}
}

func TestFieldKeysAndValuesAreStoredVerbatim(t *testing.T) {
	s := openStore(t)
	ctx := context.Background()

	fields := hostileFieldValues()
	if err := s.Add(ctx, newTask(idA, `title '; DROP TABLE tasks; --`, fields.Clone())); err != nil {
		t.Fatalf("Add: %v", err)
	}

	got, err := s.Get(ctx, idA)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Title != `title '; DROP TABLE tasks; --` {
		t.Errorf("title: %q", got.Title)
	}
	if !reflect.DeepEqual(map[string]any(got.Fields), map[string]any(fields)) {
		t.Errorf("fields did not round trip:\n got %#v\nwant %#v", got.Fields, fields)
	}

	// The table is still there and still holds exactly the one task.
	all, err := s.List(ctx, store.Filter{IncludeDeleted: true})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(all) != 1 {
		t.Fatalf("the store holds %d task(s), want 1", len(all))
	}
}

func TestLargeAndDeeplyNestedFieldValues(t *testing.T) {
	s := openStore(t)
	ctx := context.Background()

	// A megabyte in one value.
	big := strings.Repeat("A", 1<<20)
	// Sixty-four levels of nesting.
	var nested any = "bottom"
	for i := 0; i < 64; i++ {
		nested = map[string]any{"level": nested}
	}
	fields := task.Fields{"big": big, "nested": nested, "list": []any{1, 2, 3}}

	if err := s.Add(ctx, newTask(idA, "large fields", fields.Clone())); err != nil {
		t.Fatalf("Add: %v", err)
	}
	got, err := s.Get(ctx, idA)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if v, _ := got.Fields.String("big"); len(v) != len(big) {
		t.Errorf("the large value came back %d bytes long, want %d", len(v), len(big))
	}
	depth := 0
	for cur := got.Fields["nested"]; ; depth++ {
		m, ok := cur.(map[string]any)
		if !ok {
			break
		}
		cur = m["level"]
	}
	if depth != 64 {
		t.Errorf("the nested value came back %d level(s) deep, want 64", depth)
	}
}

// FindByPrefix builds the only LIKE pattern in the package. A prefix holding
// %, _ or \ must match literally, so a prefix that is all wildcards matches
// nothing rather than everything.
func TestFindByPrefixEscapesLikeMetacharacters(t *testing.T) {
	s := openStore(t)
	ctx := context.Background()

	for _, taskID := range []string{idA, idB, idC} {
		if err := s.Add(ctx, newTask(taskID, "task "+taskID, nil)); err != nil {
			t.Fatalf("Add %s: %v", taskID, err)
		}
	}

	for _, prefix := range []string{"%", "_", `\`, "%%", "01J3%", "01J3_", `01J3\`, "0%A", "_1J3"} {
		got, err := s.FindByPrefix(ctx, prefix)
		if err == nil {
			t.Errorf("FindByPrefix(%q) matched %s; the wildcard was not escaped", prefix, got.ID)
			continue
		}
		if !errors.Is(err, store.ErrNotFound) {
			t.Errorf("FindByPrefix(%q): %v, want not-found", prefix, err)
		}
		assertNoDriverLeak(t, err)
	}

	// An ordinary prefix still works, and an ambiguous one is still ambiguous.
	if found, err := s.FindByPrefix(ctx, "01J3A"); err != nil || found.ID != idA {
		t.Errorf("FindByPrefix(\"01J3A\") = %v, %v", found, err)
	}
	if err := s.Add(ctx, newTask(idB2, "another", nil)); err != nil {
		t.Fatalf("Add: %v", err)
	}
	if _, err := s.FindByPrefix(ctx, "01J3B"); !errors.Is(err, store.ErrAmbiguous) {
		t.Errorf("FindByPrefix(\"01J3B\") = %v, want ambiguous", err)
	}
}

// An escaped prefix must not match an id that only a wildcard reading of it
// would reach. These ids exist purely so that a broken escape has something to
// match.
func TestFindByPrefixDoesNotMatchThroughAWildcard(t *testing.T) {
	s := openStore(t)
	ctx := context.Background()
	for _, taskID := range []string{idA, idB, idC} {
		if err := s.Add(ctx, newTask(taskID, "task", nil)); err != nil {
			t.Fatalf("Add: %v", err)
		}
	}
	// "01J3%BCDEFGHJKMNPQRSTVWXYZ" is idB's shape with a literal % where the
	// discriminating character is: as a LIKE pattern it would match every id,
	// as a literal prefix it matches none.
	for _, prefix := range []string{
		"01J3%BCDEFGHJKMNPQRSTVWXYZ",
		"01J3_BCDEFGHJKMNPQRSTVWXYZ",
		"01J3%",
		"%1J3ABCDEFGHJKMNPQRSTVWXYZ",
	} {
		if _, err := s.FindByPrefix(ctx, prefix); !errors.Is(err, store.ErrNotFound) {
			t.Errorf("FindByPrefix(%q) = %v, want not-found", prefix, err)
		}
	}
}

// Get, Update and Purge take an id straight from the caller. A quote, a
// wildcard or a NUL in it is a value, never SQL: the row is simply not there.
func TestGetUpdateAndPurgeWithAHostileID(t *testing.T) {
	s := openStore(t)
	ctx := context.Background()
	if err := s.Add(ctx, newTask(idA, "the real task", nil)); err != nil {
		t.Fatalf("Add: %v", err)
	}

	for _, taskID := range []string{
		`' OR '1'='1`,
		`'; DROP TABLE tasks; --`,
		`" OR 1=1 --`,
		"%",
		"nul\x00id",
		strings.Repeat("Z", 4096),
	} {
		if _, err := s.Get(ctx, taskID); !errors.Is(err, store.ErrNotFound) {
			t.Errorf("Get(%q) = %v, want not-found", taskID, err)
			assertNoDriverLeak(t, err)
		}
		if err := s.Update(ctx, newTask(taskID, "forged", nil)); !errors.Is(err, store.ErrNotFound) {
			t.Errorf("Update(%q) = %v, want not-found", taskID, err)
			assertNoDriverLeak(t, err)
		}
		if err := s.Purge(ctx, taskID); !errors.Is(err, store.ErrNotFound) {
			t.Errorf("Purge(%q) = %v, want not-found", taskID, err)
			assertNoDriverLeak(t, err)
		}
	}

	// The real task is untouched by all of that.
	got, err := s.Get(ctx, idA)
	if err != nil {
		t.Fatalf("Get after the hostile ids: %v", err)
	}
	if got.Title != "the real task" {
		t.Errorf("title: %q", got.Title)
	}
	all, err := s.List(ctx, store.Filter{IncludeDeleted: true})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(all) != 1 {
		t.Errorf("the store holds %d task(s), want 1", len(all))
	}
}

// Base32 is case-insensitive, so a ULID written in lower case is the same id
// written differently. Add normalizes it the way every lookup does, which is
// what keeps a row addressable by its own id, and a duplicate is reported as
// store.ErrExists rather than as the driver's constraint message.
func TestAddNormalizesTheIDTheSameWayLookupsDo(t *testing.T) {
	s := openStore(t)
	ctx := context.Background()
	lower := strings.ToLower(idA)

	if err := s.Add(ctx, newTask(lower, "stored under a lower-cased id", nil)); err != nil {
		t.Fatalf("Add: %v", err)
	}

	// Found by the id as written, by its canonical form, and by a prefix.
	for _, ref := range []string{lower, idA} {
		got, err := s.Get(ctx, ref)
		if err != nil {
			t.Fatalf("Get(%q) = %v, want the stored task", ref, err)
		}
		if got.ID != idA {
			t.Errorf("Get(%q) returned id %q, want the canonical %q", ref, got.ID, idA)
		}
	}
	if found, err := s.FindByPrefix(ctx, idA[:8]); err != nil || found.ID != idA {
		t.Errorf("FindByPrefix(%q) = %v, %v; want the canonical row", idA[:8], found, err)
	}

	// A duplicate is the sentinel, and the driver's message never reaches it:
	// `tdo import` turns this into a skip.
	err := s.Add(ctx, newTask(lower, "again", nil))
	if !errors.Is(err, store.ErrExists) {
		t.Fatalf("Add of a duplicate id = %v, want store.ErrExists", err)
	}
	if strings.Contains(strings.ToUpper(err.Error()), "UNIQUE CONSTRAINT") {
		t.Errorf("the driver's constraint message reached the caller: %v", err)
	}

	// Update addresses it by either spelling too. A row stored canonically
	// that could not be updated by the spelling it was added under would be
	// readable and uncompletable at the same time.
	updated := newTask(lower, "edited through the lower-cased id", nil)
	if err := s.Update(ctx, updated); err != nil {
		t.Fatalf("Update(%q) = %v", lower, err)
	}
	if got, err := s.Get(ctx, idA); err != nil || got.Title != "edited through the lower-cased id" {
		t.Errorf("Get after the update = %v, %v", got, err)
	}

	// Purge addresses it by either spelling.
	if err := s.Purge(ctx, lower); err != nil {
		t.Errorf("Purge(%q) = %v", lower, err)
	}
}
