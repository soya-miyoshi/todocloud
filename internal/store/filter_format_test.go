package store

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/soya-miyoshi/todocloud/internal/task"
)

// everyFieldSet is a Filter with every field carrying a non-zero value, so
// that nothing can be omitted from the golden document below by accident.
func everyFieldSet() Filter {
	yes := true
	at := func(s string) *time.Time {
		v, err := time.Parse(time.RFC3339, s)
		if err != nil {
			panic(err)
		}
		return &v
	}
	return Filter{
		Kinds:           []task.Kind{task.KindFolder, task.KindProject, task.KindTask},
		Statuses:        []task.Status{task.StatusActive, task.StatusOnHold, task.StatusDone, task.StatusDropped},
		Availability:    AvailabilityAvailable,
		Flagged:         &yes,
		Scope:           Scope{ParentID: "01J3", Children: true, Subtree: "01J4", Inbox: true},
		Tags:            []string{"home", "errand"},
		TagsAny:         true,
		DeferBefore:     at("2026-01-01T00:00:00Z"),
		DeferAfter:      at("2026-01-02T00:00:00Z"),
		DueBefore:       at("2026-01-03T00:00:00Z"),
		DueAfter:        at("2026-01-04T00:00:00Z"),
		HasDue:          &yes,
		ReviewDueBefore: at("2026-01-05T00:00:00Z"),
		IncludeDeleted:  true,
		OnlyDeleted:     true,
		Order:           OrderDue,
		Limit:           25,
		// Now is deliberately left out: it is tagged "-" because it is a
		// clock reading, not part of what was saved.
	}
}

// storedFilterGolden is the on-disk shape of a perspective's filter. It is a
// literal and not a recomputation on purpose: a test that re-derives the
// format cannot notice the format changing.
const storedFilterGolden = `{"kinds":["folder","project","task"],` +
	`"statuses":["active","on_hold","done","dropped"],` +
	`"availability":"available","flagged":true,` +
	`"scope":{"parent_id":"01J3","children":true,"subtree":"01J4","inbox":true},` +
	`"tags":["home","errand"],"tags_any":true,` +
	`"defer_before":"2026-01-01T00:00:00Z","defer_after":"2026-01-02T00:00:00Z",` +
	`"due_before":"2026-01-03T00:00:00Z","due_after":"2026-01-04T00:00:00Z",` +
	`"has_due":true,"review_due_before":"2026-01-05T00:00:00Z",` +
	`"include_deleted":true,"only_deleted":true,"order":"due","limit":25}`

// A Filter is the on-disk format of a saved perspective: SavePerspective
// stores json.Marshal of it, and `tdo export` copies those bytes into a
// backup. Nothing else pinned that shape, so a renamed field or an edited
// json tag changed the meaning of every perspective already stored, with no
// error anywhere — and because every field here narrows a listing, the
// result of getting it wrong is a query that silently matches more than the
// user saved.
func TestTheStoredFilterFormatIsFixed(t *testing.T) {
	encoded, err := json.Marshal(everyFieldSet())
	if err != nil {
		t.Fatalf("marshalling a filter must not fail: %v", err)
	}
	if string(encoded) != storedFilterGolden {
		t.Errorf("the on-disk format of a saved perspective changed, so every perspective a user has already saved now means something else; this needs a migration of the stored rows, not a new golden string (PLAN.md §3.6)\n  got  %s\n  want %s",
			encoded, storedFilterGolden)
	}

	// The golden document above can only catch a field it contains. A field
	// added with omitempty and left unset would slip past it, so the count
	// is checked too: add a field, update everyFieldSet, and read the
	// paragraph on Filter before changing either.
	const fields = 18
	if n := reflect.TypeOf(Filter{}).NumField(); n != fields {
		t.Errorf("Filter has %d fields and the golden format describes %d; a field was added, renamed or removed, and the stored format moved with it",
			n, fields)
	}
}

// Whatever the format is, it has to survive the trip it is written for.
func TestAStoredFilterRoundTripsUnchanged(t *testing.T) {
	want := everyFieldSet()
	encoded, err := json.Marshal(want)
	if err != nil {
		t.Fatalf("marshalling a filter must not fail: %v", err)
	}
	var got Filter
	if err := json.Unmarshal(encoded, &got); err != nil {
		t.Fatalf("a filter this binary wrote must read back: %v", err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("a perspective must run as the query it was saved as, but it did not survive the round trip\n  got  %+v\n  want %+v", got, want)
	}
}

// A key this binary does not know is refused rather than dropped. Every
// field of a Filter narrows a listing, so dropping one turns a saved query
// into a wider one: "flagged, not deferred" comes back as "everything", and
// the user acts on that list believing it is theirs. An error is visible;
// a wider answer is not.
func TestAnUnknownKeyInAStoredFilterIsRefusedRatherThanWidened(t *testing.T) {
	stored := `{"flagged":true,"excludes_waiting":true}`

	var f Filter
	err := json.Unmarshal([]byte(stored), &f)
	if err == nil {
		t.Fatalf("a stored filter carrying a key this binary does not understand must be refused, not silently run as the wider query %+v", f)
	}
	for _, want := range []string{"excludes_waiting", "widen"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the error must say what it found and why it matters; %q does not mention %q", err, want)
		}
	}

	// The refusal is about unknown keys only: a filter with a key left out
	// is a filter that did not use it, which is ordinary.
	var sparse Filter
	if err := json.Unmarshal([]byte(`{"flagged":true}`), &sparse); err != nil {
		t.Fatalf("a filter that uses only some of the keys must still read: %v", err)
	}
	if sparse.Flagged == nil || !*sparse.Flagged {
		t.Errorf("the keys that are there must still be read: %+v", sparse)
	}
}
