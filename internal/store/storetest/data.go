package storetest

import (
	"errors"
	"math"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/soya-miyoshi/todocloud/internal/id"
	"github.com/soya-miyoshi/todocloud/internal/store"
	"github.com/soya-miyoshi/todocloud/internal/task"
)

func testTombstones(t *testing.T, f *fixture) {
	kept := f.add(task.KindTask, "kept")
	removed := f.add(task.KindTask, "removed")

	stored := f.get(removed.ID)
	at := f.now
	stored.DeletedAt = &at
	f.update(stored)

	requireSet(t, "removal is a tombstone, and a tombstoned task is out of an ordinary listing (PLAN.md §3.7)",
		f.list(store.Filter{}), "kept")
	requireSet(t, "`--deleted` must show the tombstoned tasks and nothing else",
		f.list(store.Filter{OnlyDeleted: true}), "removed")
	requireSet(t, "a listing that includes deleted tasks must hold both",
		f.list(store.Filter{IncludeDeleted: true}), "kept", "removed")

	got := f.get(removed.ID)
	if !got.Deleted() {
		t.Fatal("Get must return a tombstoned task, tombstone and all: a tombstone is a state, not an absence")
	}

	requireNoError(t, "a tombstoned leaf may be purged", f.s.Purge(f.ctx, removed.ID))
	_, err := f.s.Get(f.ctx, removed.ID)
	requireIs(t, "a purged task is gone for good, so Get must report it as not found", err, store.ErrNotFound)
	_ = kept
}

func testTags(t *testing.T, f *fixture) {
	home := f.add(task.KindTask, "mow the lawn", func(t *task.Task) {
		t.SetTags([]string{"Home", "home", " errand ", ""})
	})
	both := f.add(task.KindTask, "call the plumber", func(t *task.Task) {
		t.SetTags([]string{"home", "phone"})
	})
	none := f.add(task.KindTask, "think")

	stored := f.get(home.ID)
	if !reflect.DeepEqual(stored.Tags, []string{"errand", "Home"}) {
		t.Fatalf("tags are a set compared case-insensitively, kept in the spelling first typed and sorted by name\n  stored tags are %v, expected [errand Home]", stored.Tags)
	}

	requireSet(t, "a tag filter is case-insensitive, because a tag is typed",
		f.list(store.Filter{Tags: []string{"HOME"}}), "mow the lawn", "call the plumber")
	requireSet(t, "several tags mean all of them unless the filter says any",
		f.list(store.Filter{Tags: []string{"home", "phone"}}), "call the plumber")
	requireSet(t, "`tags_any` means any one of them",
		f.list(store.Filter{Tags: []string{"errand", "phone"}, TagsAny: true}),
		"mow the lawn", "call the plumber")

	counts, err := f.s.Tags(f.ctx)
	requireNoError(t, "Tags must list the tags in use", err)
	want := map[string]int{"errand": 1, "Home": 2, "phone": 1}
	if len(counts) != len(want) {
		t.Fatalf("Tags must return one row per distinct tag with its count\n  got %v, expected %v", counts, want)
	}
	for _, c := range counts {
		if want[c.Name] != c.Count {
			t.Fatalf("Tags must count the live tasks carrying each tag\n  %q has count %d, expected %d", c.Name, c.Count, want[c.Name])
		}
	}

	// Setting the tags of a task replaces them: `tdo edit --tag` is
	// subtractive as well as additive.
	stored.SetTags([]string{"garden"})
	f.update(stored)
	requireSet(t, "updating a task replaces its tags rather than adding to them",
		f.list(store.Filter{Tags: []string{"home"}}), "call the plumber")
	if got := f.get(home.ID); !reflect.DeepEqual(got.Tags, []string{"garden"}) {
		t.Fatalf("the stored tags must be the ones last written\n  got %v, expected [garden]", got.Tags)
	}

	// A tombstoned task's tags leave the index: a tag whose only task is in
	// the bin is not a tag the user still files things under.
	deleted := f.get(both.ID)
	at := f.now
	deleted.DeletedAt = &at
	f.update(deleted)
	counts, err = f.s.Tags(f.ctx)
	requireNoError(t, "Tags must still work once something is tombstoned", err)
	for _, c := range counts {
		if strings.EqualFold(c.Name, "phone") {
			t.Fatalf("Tags must count live tasks only\n  %q is still listed although its only task is tombstoned", c.Name)
		}
	}
	_ = none
}

func testPerspectives(t *testing.T, f *fixture) {
	flagged := true
	p := &store.Perspective{
		Name: "Next",
		Filter: store.Filter{
			Kinds:        []task.Kind{task.KindTask},
			Statuses:     []task.Status{task.StatusActive},
			Availability: store.AvailabilityAvailable,
			Flagged:      &flagged,
			Tags:         []string{"home"},
			Order:        store.OrderDue,
			Limit:        10,
		},
		CreatedAt: f.now,
		UpdatedAt: f.now,
	}
	requireNoError(t, "SavePerspective must store a named filter", f.s.SavePerspective(f.ctx, p))

	got, err := f.s.Perspective(f.ctx, "next")
	requireNoError(t, "a perspective must be found by name, compared case-insensitively since it is typed", err)
	if got.Name != "Next" {
		t.Fatalf("a perspective must keep the spelling it was saved with\n  got %q, expected %q", got.Name, "Next")
	}
	if !reflect.DeepEqual(got.Filter, p.Filter) {
		t.Fatalf("a perspective is a saved filter and nothing more, so it must read back as the filter it was saved with (PLAN.md §3.6)\n  got  %+v\n  want %+v", got.Filter, p.Filter)
	}

	// Saving again under the same name replaces it rather than making a
	// second one.
	p.Filter.Limit = 20
	p.UpdatedAt = f.now.Add(time.Hour)
	requireNoError(t, "saving a perspective of the same name must replace it", f.s.SavePerspective(f.ctx, p))
	all, err := f.s.Perspectives(f.ctx)
	requireNoError(t, "Perspectives must list what is saved", err)
	if len(all) != 1 {
		t.Fatalf("saving the same name twice must leave one perspective, not two\n  there are %d", len(all))
	}
	if all[0].Filter.Limit != 20 {
		t.Fatalf("a replaced perspective must hold the new filter\n  its limit is %d, expected 20", all[0].Filter.Limit)
	}

	requireNoError(t, "a second perspective must be storable alongside the first",
		f.s.SavePerspective(f.ctx, &store.Perspective{Name: "Admin", CreatedAt: f.now, UpdatedAt: f.now}))
	all, err = f.s.Perspectives(f.ctx)
	requireNoError(t, "Perspectives must list all of them", err)
	if len(all) != 2 || all[0].Name != "Admin" {
		t.Fatalf("Perspectives must be sorted by name\n  got %v", perspectiveNames(all))
	}

	// Every field of a filter narrows a listing, so a field a provider
	// drops on the way to the database or back makes the saved query wider
	// than the one the user saved — and a wider listing is acted on rather
	// than reported. Both providers store the filter as one JSON document,
	// and this is what says they must keep all of it.
	whole := &store.Perspective{
		Name: "Everything set",
		Filter: store.Filter{
			Kinds:           []task.Kind{task.KindFolder, task.KindProject, task.KindTask},
			Statuses:        []task.Status{task.StatusActive, task.StatusOnHold, task.StatusDone, task.StatusDropped},
			Availability:    store.AvailabilityDeferred,
			Flagged:         &flagged,
			Scope:           store.Scope{ParentID: "01J3ZQK8V9XW5S6R7T8Y9Z0A1B", Children: true, Subtree: "01J3ZQK8V9XW5S6R7T8Y9Z0A1C", Inbox: true},
			Tags:            []string{"home", "errand"},
			TagsAny:         true,
			DeferBefore:     timeAt(f.now, time.Hour),
			DeferAfter:      timeAt(f.now, 2*time.Hour),
			DueBefore:       timeAt(f.now, 3*time.Hour),
			DueAfter:        timeAt(f.now, 4*time.Hour),
			HasDue:          &flagged,
			ReviewDueBefore: timeAt(f.now, 5*time.Hour),
			IncludeDeleted:  true,
			OnlyDeleted:     true,
			Order:           store.OrderDefer,
			Limit:           7,
		},
		CreatedAt: f.now,
		UpdatedAt: f.now,
	}
	requireNoError(t, "a filter using every field must be storable", f.s.SavePerspective(f.ctx, whole))
	back, err := f.s.Perspective(f.ctx, "everything set")
	requireNoError(t, "a perspective using every filter field must be readable", err)
	if !reflect.DeepEqual(back.Filter, whole.Filter) {
		t.Fatalf("every field of a saved filter must survive the store, or the perspective runs as a different and usually wider query (PLAN.md §3.6)\n  got  %+v\n  want %+v", back.Filter, whole.Filter)
	}
	requireNoError(t, "tidying up the all-fields perspective", f.s.DeletePerspective(f.ctx, "everything set"))

	requireNoError(t, "a perspective is a query, so deleting one is a real delete",
		f.s.DeletePerspective(f.ctx, "NEXT"))
	_, err = f.s.Perspective(f.ctx, "next")
	requireIs(t, "a deleted perspective must be reported as not found", err, store.ErrNotFound)
	requireIs(t, "deleting a perspective that is not there must be reported as not found",
		f.s.DeletePerspective(f.ctx, "nothing"), store.ErrNotFound)
}

func perspectiveNames(ps []*store.Perspective) []string {
	out := make([]string, 0, len(ps))
	for _, p := range ps {
		out = append(out, p.Name)
	}
	return out
}

func testRepetition(t *testing.T, f *fixture) {
	repeating := f.add(task.KindTask, "water the plants", func(t *task.Task) {
		t.Repeat = &task.Repeat{Method: task.RepeatFromCompletion, Every: "3d"}
		t.SeriesID = ""
		t.DueAt = timeAt(f.now, 24*time.Hour)
	})

	// The store persists the repeat and the series; generating the successor
	// is domain logic and happens above it (PLAN.md §3.4), so the store is
	// only asked to carry both unchanged.
	stored := f.get(repeating.ID)
	if stored.Repeat == nil || *stored.Repeat != (task.Repeat{Method: task.RepeatFromCompletion, Every: "3d"}) {
		t.Fatalf("a repeat must round-trip exactly, including a spelling this binary may not understand\n  got %+v", stored.Repeat)
	}

	stored.SeriesID = stored.ID
	f.update(stored)

	successor := task.New(id.New(), task.KindTask, "water the plants", f.now.Add(72*time.Hour))
	successor.Repeat = stored.Repeat.Clone()
	successor.SeriesID = stored.SeriesID
	f.mustAdd(successor)

	stored.SetStatus(task.StatusDone, f.now.Add(72*time.Hour))
	f.update(stored)

	done := f.get(repeating.ID)
	if done.Status != task.StatusDone || done.CompletedAt == nil {
		t.Fatalf("completing a task must store the status and the moment it happened\n  status is %q and completed_at is %v", done.Status, done.CompletedAt)
	}
	next := f.get(successor.ID)
	if next.SeriesID != done.SeriesID || next.SeriesID == "" {
		t.Fatalf("the instances of a repeat are tied together by series_id\n  the successor has %q and the completed instance has %q", next.SeriesID, done.SeriesID)
	}
	if next.ID == done.ID {
		t.Fatal("a successor is a new row with a fresh id, not an edit of the instance that was completed")
	}

	// Ending a series leaves its history: the repeat goes, the rows stay.
	next.Repeat = nil
	f.update(next)
	if got := f.get(successor.ID); got.Repeat != nil {
		t.Fatalf("`tdo repeat --stop` clears the repeat, so a nil repeat must be stored as no repeat\n  got %+v", got.Repeat)
	}
	if got := f.get(successor.ID); got.SeriesID == "" {
		t.Fatal("ending a series must leave its history: series_id stays on the instances that were part of it")
	}
}

func testReview(t *testing.T, f *fixture) {
	weekly := f.add(task.KindProject, "weekly project", func(t *task.Task) {
		t.ReviewInterval = &task.ReviewInterval{Every: "1w"}
		t.LastReviewedAt = timeAt(f.now, -8*24*time.Hour)
	})
	fresh := f.add(task.KindProject, "recently reviewed", func(t *task.Task) {
		t.ReviewInterval = &task.ReviewInterval{Every: "1w"}
		t.LastReviewedAt = timeAt(f.now, -24*time.Hour)
	})
	never := f.add(task.KindFolder, "never reviewed", func(t *task.Task) {
		t.ReviewInterval = &task.ReviewInterval{Every: "1mo"}
	})
	f.add(task.KindProject, "not on review")

	stored := f.get(weekly.ID)
	if stored.ReviewInterval == nil || stored.ReviewInterval.Every != "1w" {
		t.Fatalf("a review interval must round-trip\n  got %+v", stored.ReviewInterval)
	}

	soon := f.now.Add(time.Minute)
	requireSet(t, "`tdo review` lists what is due: next_review_at is last_reviewed_at plus the interval, and an item never reviewed is due now (PLAN.md §3.5)",
		f.list(store.Filter{ReviewDueBefore: &soon}), "weekly project", "never reviewed")

	// Marking one reviewed takes it out of the listing without touching the
	// interval, because next_review_at is derived and not stored.
	stored.LastReviewedAt = &f.now
	f.update(stored)
	requireSet(t, "an item marked reviewed drops out of the review listing until its interval comes round again",
		f.list(store.Filter{ReviewDueBefore: &soon}), "never reviewed")
	_ = fresh
	_ = never
}

func testSentinels(t *testing.T, f *fixture) {
	missing := id.New()

	_, err := f.s.Get(f.ctx, missing)
	requireIs(t, "Get on an unknown id must report ErrNotFound, which the command layer maps to exit 5", err, store.ErrNotFound)

	ghost := task.New(missing, task.KindTask, "ghost", f.now)
	requireIs(t, "Update on an unknown id must report ErrNotFound rather than quietly inserting a row",
		f.s.Update(f.ctx, ghost), store.ErrNotFound)
	requireIs(t, "Purge on an unknown id must report ErrNotFound", f.s.Purge(f.ctx, missing), store.ErrNotFound)
	_, err = f.s.Subtree(f.ctx, missing)
	requireIs(t, "Subtree on an unknown id must report ErrNotFound", err, store.ErrNotFound)
	_, err = f.s.PurgeSubtree(f.ctx, missing)
	requireIs(t, "PurgeSubtree on an unknown id must report ErrNotFound", err, store.ErrNotFound)
	requireIs(t, "Move of an unknown id must report ErrNotFound",
		f.s.Move(f.ctx, missing, "", 0, f.now), store.ErrNotFound)

	existing := f.add(task.KindTask, "existing")
	duplicate := task.New(existing.ID, task.KindTask, "duplicate", f.now)
	requireIs(t, "Add must refuse an id that is already stored rather than overwriting it, so that a generator bug cannot destroy data",
		f.s.Add(f.ctx, duplicate), store.ErrExists)
	if got := f.get(existing.ID); got.Title != "existing" {
		t.Fatalf("a refused duplicate must leave the stored task alone\n  its title is now %q", got.Title)
	}

	// Two ids sharing a prefix: one is a lookup, two is ambiguity.
	a := f.mustAdd(task.New("01J0000000000000000000000A", task.KindTask, "prefix a", f.now))
	b := f.mustAdd(task.New("01J0000000000000000000000B", task.KindTask, "prefix b", f.now))
	found, err := f.s.FindByPrefix(f.ctx, "01J0000000000000000000000A")
	requireNoError(t, "an id prefix that matches one task must resolve to it", err)
	if found.ID != a.ID {
		t.Fatalf("FindByPrefix must return the task whose id starts with the prefix\n  got %q", found.ID)
	}
	_, err = f.s.FindByPrefix(f.ctx, "01J0")
	requireIs(t, "an id prefix matching several tasks must report ErrAmbiguous, which the command layer maps to exit 6", err, store.ErrAmbiguous)
	_, err = f.s.FindByPrefix(f.ctx, "ZZZZZZ")
	requireIs(t, "an id prefix matching nothing must report ErrNotFound", err, store.ErrNotFound)
	_ = b

	// LIKE metacharacters are data, not syntax.
	_, err = f.s.FindByPrefix(f.ctx, "%")
	requireIs(t, "a prefix of LIKE metacharacters must match nothing: a prefix is data, never pattern syntax", err, store.ErrNotFound)
	_, err = f.s.FindByPrefix(f.ctx, "_1J0000000000000000000000A")
	requireIs(t, "an underscore in a prefix must not match an arbitrary character", err, store.ErrNotFound)

	// A container is not purged out from under its children.
	project := f.add(task.KindProject, "a project with contents")
	child := f.add(task.KindTask, "contents", under(project))
	requireIs(t, "purging a container that still holds items would orphan them, so it must be refused with ErrNotEmpty (PLAN.md §3.1)",
		f.s.Purge(f.ctx, project.ID), store.ErrNotEmpty)
	if _, err := f.s.Get(f.ctx, child.ID); err != nil {
		t.Fatalf("a refused purge must leave the subtree intact\n  the child is gone: %v", err)
	}
	n, err := f.s.PurgeSubtree(f.ctx, project.ID)
	requireNoError(t, "PurgeSubtree is how a container is really deleted", err)
	if n != 2 {
		t.Fatalf("PurgeSubtree must report how many rows went\n  it reported %d, expected 2", n)
	}
	if _, err := f.s.Get(f.ctx, child.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("PurgeSubtree must remove the children as well as the container\n  the child is still there: %v", err)
	}
}

func testIDNormalization(t *testing.T, f *fixture) {
	// Base32 is case-insensitive, so an id pasted in lower case addresses the
	// same task. Every id-addressed call must agree about that, or a row
	// written through one is unreachable through another.
	upper := id.New()
	lower := strings.ToLower(upper)

	created := task.New(lower, task.KindProject, "written in lower case", f.now)
	f.mustAdd(created)

	if got := f.get(upper); got.Title != "written in lower case" {
		t.Fatalf("Add must store the canonical spelling of an id, so Get with the upper-case form must find it")
	}
	if got := f.get(lower); got.ID != strings.ToUpper(upper) {
		t.Fatalf("Get must normalise the id it is given and return the canonical one\n  got %q", got.ID)
	}

	edited := task.New(lower, task.KindProject, "edited through the lower-case id", f.now)
	requireNoError(t, "Update must normalise the id the same way Add does, or an edit silently inserts nothing",
		f.s.Update(f.ctx, edited))
	if got := f.get(upper); got.Title != "edited through the lower-case id" {
		t.Fatalf("an Update addressed by a lower-case id must reach the stored row\n  the title is still %q", got.Title)
	}

	child := task.New(strings.ToLower(id.New()), task.KindTask, "child", f.now)
	child.ParentID = lower
	requireNoError(t, "a parent reference must be normalised too, or the edge points at nothing",
		f.s.Add(f.ctx, child))
	if got := f.get(child.ID); got.ParentID != strings.ToUpper(upper) {
		t.Fatalf("the stored parent edge must be the canonical id\n  got %q", got.ParentID)
	}

	requireNoError(t, "Move must accept an id in either case", f.s.Move(f.ctx, strings.ToUpper(child.ID), "", 0, f.now))
	requireNoError(t, "Purge must normalise the id it is given", f.s.Purge(f.ctx, strings.ToLower(child.ID)))
	if _, err := f.s.Get(f.ctx, child.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("a purge addressed by a lower-case id must remove the row\n  it is still there: %v", err)
	}
}

// hostileFields are values that have broken a store before: a key that looks
// like SQL, a value holding a quote or a NUL, numbers at the edge of int64.
func hostileFields() task.Fields {
	return task.Fields{
		"quote":        `it's "quoted" -- not a comment`,
		"semicolon":    `a; DROP TABLE tasks;--`,
		"nul":          "before\x00after",
		"unicode":      "日本語 ‮ rtl",
		"json":         map[string]any{"nested": []any{1, "two", true}},
		"max_int64":    math.MaxInt64,
		"min_int64":    math.MinInt64,
		"past_int64":   1e19,
		"whole_float":  float64(1 << 53),
		"empty":        "",
		"'; DELETE --": "a key that looks like SQL is a key, not syntax",
		"percent_like": "100%_done",
		"deep":         map[string]any{"a": map[string]any{"b": map[string]any{"c": 1}}},
		"long":         strings.Repeat("x", 4096),
	}
}

func testOpenFields(t *testing.T, f *fixture) {
	stored := f.add(task.KindTask, "hostile", func(t *task.Task) {
		t.Fields = hostileFields()
		t.Note = "a note with 'quotes' and a \x00 byte"
		t.EstimatedMinutes = 45
		t.Flagged = true
	})

	got := f.get(stored.ID)
	want := hostileFields()
	want.Normalize()
	for key, wantValue := range want {
		gotValue, ok := got.Fields[key]
		if !ok {
			t.Fatalf("a user-defined field must survive the round trip\n  %q is missing from the task that came back", key)
		}
		if !reflect.DeepEqual(gotValue, wantValue) {
			t.Fatalf("a user-defined value must come back as it went in, with the same Go type\n  %q is %#v, expected %#v", key, gotValue, wantValue)
		}
	}
	if got.Note != stored.Note {
		t.Fatalf("a note is stored as data, byte for byte\n  got %q, expected %q", got.Note, stored.Note)
	}
	if got.EstimatedMinutes != 45 || !got.Flagged {
		t.Fatalf("the required fields must round-trip\n  estimated_minutes is %d and flagged is %v", got.EstimatedMinutes, got.Flagged)
	}

	// A `--where` condition is evaluated on the client, over whatever came
	// back, and must see the same values.
	c := store.Condition{Match: map[string]string{"percent_like": "100%_done"}}
	if !c.Matches(got) {
		t.Fatal("a client-side condition must see the user-defined values exactly as they were stored")
	}
}

func testFilters(t *testing.T, f *fixture) {
	folder := f.add(task.KindFolder, "folder")
	project := f.add(task.KindProject, "project", under(folder))
	flagged := f.add(task.KindTask, "flagged", under(project), func(t *task.Task) { t.Flagged = true })
	dueSoon := f.add(task.KindTask, "due soon", under(project), func(t *task.Task) {
		t.DueAt = timeAt(f.now, time.Hour)
	})
	dueLater := f.add(task.KindTask, "due later", under(project), func(t *task.Task) {
		t.DueAt = timeAt(f.now, 72*time.Hour)
	})
	held := f.add(task.KindTask, "held", under(project), func(t *task.Task) { t.Status = task.StatusOnHold })
	elsewhere := f.add(task.KindTask, "elsewhere")

	requireSet(t, "a kind filter keeps only those kinds",
		f.list(store.Filter{Kinds: []task.Kind{task.KindFolder, task.KindProject}}), "folder", "project")
	requireSet(t, "a status filter keeps only those statuses",
		f.list(store.Filter{Statuses: []task.Status{task.StatusOnHold}}), "held")
	requireSet(t, "an empty status filter does not filter: it is the command layer that decides what `tdo ls` defaults to",
		f.list(store.Filter{Kinds: []task.Kind{task.KindTask}}),
		"flagged", "due soon", "due later", "held", "elsewhere")
	requireSet(t, "a flagged filter of true keeps the flagged items",
		f.list(store.Filter{Flagged: ptr(true)}), "flagged")

	cutoff := f.now.Add(24 * time.Hour)
	requireSet(t, "`--due-before` keeps the items with a due date strictly before the instant, and drops the ones with no due date at all",
		f.list(store.Filter{DueBefore: &cutoff}), "due soon")
	requireSet(t, "`--due-after` is its mirror",
		f.list(store.Filter{DueAfter: &cutoff}), "due later")
	requireSet(t, "a has-due filter of false keeps only the items with no deadline",
		f.list(store.Filter{Kinds: []task.Kind{task.KindTask}, HasDue: ptr(false)}),
		"flagged", "held", "elsewhere")

	requireSet(t, "a children scope is one level, not the whole subtree",
		f.list(store.Filter{Scope: store.Scope{Children: true, ParentID: folder.ID}}), "project")
	requireSet(t, "a subtree scope holds the container and everything beneath it",
		f.list(store.Filter{Scope: store.Scope{Subtree: folder.ID}}),
		"folder", "project", "flagged", "due soon", "due later", "held")

	limited := f.list(store.Filter{Limit: 2})
	if len(limited) != 2 {
		t.Fatalf("a limit caps the listing\n  it returned %d item(s), expected 2", len(limited))
	}
	full := f.list(store.Filter{})
	requireTitles(t, "a limit takes the first n of the listing the filter would have returned, in the same order",
		limited, titles(full)[:2]...)
	_ = elsewhere
	_ = flagged
	_ = dueSoon
	_ = dueLater
	_ = held
}
