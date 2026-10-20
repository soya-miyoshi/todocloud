// Package storetest is the provider conformance suite.
//
// It is the executable half of the store contract: everything PLAN.md §3 says
// a provider must do, written as assertions a provider either passes or does
// not. SQLite passes it, and so must every provider added later, which is the
// only way "availability is computed in one place" stays true once there is
// more than one place.
//
// A provider's own package calls it with a factory for an empty store:
//
//	func TestConformance(t *testing.T) {
//		storetest.Run(t, func(t *testing.T) store.Store { ... })
//	}
//
// A failure here names the rule that was broken, not just the values that
// differed, because the reader is someone porting a provider who needs to
// know which paragraph of the spec they are arguing with.
package storetest

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/soya-miyoshi/todocloud/internal/id"
	"github.com/soya-miyoshi/todocloud/internal/store"
	"github.com/soya-miyoshi/todocloud/internal/task"
)

// Factory returns a fresh, empty store. It is called once per subtest, and
// the suite closes what it is given.
type Factory func(t *testing.T) store.Store

// Run exercises the whole Store contract.
func Run(t *testing.T, newStore Factory) {
	t.Helper()
	suites := []struct {
		name string
		run  func(t *testing.T, f *fixture)
	}{
		{"a fresh store is empty and initialized", testFreshStore},
		{"the tree accepts only the containments PLAN 3.1 allows", testContainment},
		{"the tree refuses a move that would put an item inside itself", testCycles},
		{"a task with no parent is in the inbox", testInbox},
		{"availability follows the truth table of PLAN 3.3", testAvailability},
		{"a listing is in the order the filter asks for", testOrdering},
		{"Children, Subtree and Availability answer on their own terms", testDirectAccessors},
		{"removal is a tombstone and purging is the only real delete", testTombstones},
		{"tags round trip and filter as a set", testTags},
		{"a tag carries a status, and an inactive one holds its tasks back", testTagStatus},
		{"perspectives are saved filters and nothing else", testPerspectives},
		{"a repeating task keeps its repeat and its series", testRepetition},
		{"the last child of a completed_by_children container completes it", testCompletedByChildren},
		{"a review interval drives the review listing", testReview},
		{"every sentinel is returned where the contract says it is", testSentinels},
		{"every id-addressed call accepts an id in any case", testIDNormalization},
		{"user-defined fields survive the round trip unchanged", testOpenFields},
		{"filters narrow a listing the way they are documented to", testFilters},
	}
	for _, suite := range suites {
		t.Run(suite.name, func(t *testing.T) {
			f := newFixture(t, newStore)
			suite.run(t, f)
		})
	}
}

// fixture is one store and the small amount of ceremony every subtest needs.
type fixture struct {
	t   *testing.T
	s   store.Store
	ctx context.Context
	// now is fixed so that a truth table is a truth table and not a race
	// with the clock.
	now time.Time
}

func newFixture(t *testing.T, newStore Factory) *fixture {
	t.Helper()
	s := newStore(t)
	t.Cleanup(func() {
		if err := s.Close(); err != nil {
			t.Errorf("closing the store failed: %v", err)
		}
	})
	ctx := context.Background()
	if err := s.Init(ctx); err != nil {
		t.Fatalf("Init must be idempotent and must work on an empty store, but it failed: %v", err)
	}
	return &fixture{
		t:   t,
		s:   s,
		ctx: ctx,
		now: time.Date(2026, 6, 1, 12, 0, 0, 0, time.UTC),
	}
}

// with returns the same fixture reporting against t. A sub-suite that splits
// into t.Run cases needs it: a helper that failed against the parent's *T
// would report "a subtest called FailNow on a parent test" instead of the
// rule it was checking.
func (f *fixture) with(t *testing.T) *fixture {
	c := *f
	c.t = t
	return &c
}

// add stores a new node and returns it as the store accepted it.
func (f *fixture) add(kind task.Kind, title string, mutate ...func(*task.Task)) *task.Task {
	f.t.Helper()
	t := task.New(id.New(), kind, title, f.now)
	for _, m := range mutate {
		m(t)
	}
	if err := f.s.Add(f.ctx, t); err != nil {
		f.t.Fatalf("Add(%s %q) must succeed for a well-formed task, but failed: %v", kind, title, err)
	}
	return t
}

// mustAdd is add for a task the caller built itself.
func (f *fixture) mustAdd(t *task.Task) *task.Task {
	f.t.Helper()
	if err := f.s.Add(f.ctx, t); err != nil {
		f.t.Fatalf("Add(%s) must succeed for a well-formed task, but failed: %v", t.ID, err)
	}
	return t
}

func (f *fixture) get(taskID string) *task.Task {
	f.t.Helper()
	got, err := f.s.Get(f.ctx, taskID)
	if err != nil {
		f.t.Fatalf("Get(%s) must return a task that was just stored, but failed: %v", taskID, err)
	}
	return got
}

func (f *fixture) update(t *task.Task) {
	f.t.Helper()
	if err := f.s.Update(f.ctx, t); err != nil {
		f.t.Fatalf("Update(%s) must succeed for a well-formed task, but failed: %v", t.ID, err)
	}
}

func (f *fixture) list(filter store.Filter) []*task.Task {
	f.t.Helper()
	if filter.Now.IsZero() {
		filter.Now = f.now
	}
	got, err := f.s.List(f.ctx, filter)
	if err != nil {
		f.t.Fatalf("List must succeed for a valid filter, but failed: %v", err)
	}
	return got
}

// availability asks §3.3 about these ids at the fixture's fixed instant.
func (f *fixture) availability(ids ...string) map[string]store.Availability {
	f.t.Helper()
	got, err := f.s.Availability(f.ctx, f.now, ids...)
	if err != nil {
		f.t.Fatalf("Availability must succeed for stored ids, but failed: %v", err)
	}
	return got
}

// requireAvailable states the rule and the answer it expects, so a failure
// reads as the rule that was broken.
func requireAvailable(t *testing.T, f *fixture, rule, taskID string, want bool) {
	t.Helper()
	a := f.availability(taskID)[taskID]
	if a.Available != want {
		t.Fatalf("%s\n  available=%v (rule %q), expected available=%v", rule, a.Available, a.Rule, want)
	}
}

// parent returns a mutator placing a node under another.
func under(parent *task.Task) func(*task.Task) {
	return func(t *task.Task) { t.ParentID = parent.ID }
}

func at(position int) func(*task.Task) {
	return func(t *task.Task) { t.Position = position }
}

func titles(ts []*task.Task) []string {
	out := make([]string, 0, len(ts))
	for _, t := range ts {
		out = append(out, t.Title)
	}
	return out
}

func ids(ts []*task.Task) []string {
	out := make([]string, 0, len(ts))
	for _, t := range ts {
		out = append(out, t.ID)
	}
	return out
}

// requireTitles fails with the rule, not just the diff.
func requireTitles(t *testing.T, rule string, got []*task.Task, want ...string) {
	t.Helper()
	have := titles(got)
	if len(have) != len(want) {
		t.Fatalf("%s\n  listing has %d item(s) %v, expected %d: %v", rule, len(have), have, len(want), want)
	}
	for i := range want {
		if have[i] != want[i] {
			t.Fatalf("%s\n  listing is %v, expected %v", rule, have, want)
		}
	}
}

// requireSet is requireTitles where the order is not part of the rule.
func requireSet(t *testing.T, rule string, got []*task.Task, want ...string) {
	t.Helper()
	have := map[string]bool{}
	for _, title := range titles(got) {
		have[title] = true
	}
	if len(have) != len(want) {
		t.Fatalf("%s\n  listing holds %v, expected exactly %v", rule, titles(got), want)
	}
	for _, w := range want {
		if !have[w] {
			t.Fatalf("%s\n  listing holds %v, expected it to contain %q", rule, titles(got), w)
		}
	}
}

func requireIs(t *testing.T, rule string, err, want error) {
	t.Helper()
	if !errors.Is(err, want) {
		t.Fatalf("%s\n  expected an error wrapping %v, got %v", rule, want, err)
	}
}

func requireNoError(t *testing.T, rule string, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("%s\n  but it failed: %v", rule, err)
	}
}

func ptr[T any](v T) *T { return &v }

func timeAt(base time.Time, d time.Duration) *time.Time {
	at := base.Add(d).UTC()
	return &at
}

func describe(a store.Availability) string {
	if a.Available {
		return "available"
	}
	return fmt.Sprintf("blocked by rule %q on %s", a.Rule, a.BlockedBy)
}
