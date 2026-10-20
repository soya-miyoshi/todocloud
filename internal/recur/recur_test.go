package recur

import (
	"errors"
	"testing"
	"time"

	"github.com/soya-miyoshi/todocloud/internal/task"
)

func at(s string) time.Time {
	v, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return v.UTC()
}

func TestParseEveryReadsTheSpellingsPlanDocuments(t *testing.T) {
	for _, in := range []string{"3d", "2w", "1mo", "1y", "1mo:last-friday", "2y:first-monday"} {
		e, err := ParseEvery(in)
		if err != nil {
			t.Errorf("ParseEvery(%q) must succeed: %v", in, err)
			continue
		}
		if e.String() != in {
			t.Errorf("an interval must render back as it was written: %q became %q", in, e.String())
		}
	}
}

func TestParseEveryRefusesWhatItCannotMean(t *testing.T) {
	for _, in := range []string{"", "d", "0w", "-1d", "1", "1week", "1w:last-friday", "1mo:last-caturday", "1mo:friday"} {
		if _, err := ParseEvery(in); err == nil {
			t.Errorf("ParseEvery(%q) must fail: an interval that cannot be meant must be reported, not guessed at", in)
		}
	}
}

func TestIntervalArithmeticClampsRatherThanOverflowing(t *testing.T) {
	tests := []struct {
		every string
		from  string
		want  string
	}{
		{"3d", "2026-01-01T09:00:00Z", "2026-01-04T09:00:00Z"},
		{"2w", "2026-01-01T09:00:00Z", "2026-01-15T09:00:00Z"},
		{"1mo", "2026-01-15T09:00:00Z", "2026-02-15T09:00:00Z"},
		// One month after 31 January is the end of February, not 3 March: a
		// monthly chore set on the 31st must not drift into the next month.
		{"1mo", "2026-01-31T09:00:00Z", "2026-02-28T09:00:00Z"},
		{"1y", "2024-02-29T09:00:00Z", "2025-02-28T09:00:00Z"},
		{"1mo:last-friday", "2026-01-05T09:00:00Z", "2026-02-27T09:00:00Z"},
		{"1mo:first-monday", "2026-01-05T09:00:00Z", "2026-02-02T09:00:00Z"},
		// A fifth weekday the month does not have falls back to the last one.
		{"1mo:fifth-monday", "2026-01-05T09:00:00Z", "2026-02-23T09:00:00Z"},
	}
	for _, tc := range tests {
		e, err := ParseEvery(tc.every)
		if err != nil {
			t.Fatalf("ParseEvery(%q): %v", tc.every, err)
		}
		if got := e.Next(at(tc.from)); !got.Equal(at(tc.want)) {
			t.Errorf("%s after %s = %s, want %s", tc.every, tc.from, got.Format(time.RFC3339), tc.want)
		}
	}
}

func repeating(method task.RepeatMethod, every string) *task.Task {
	t := task.New("01J3ZQK8V9XW5S6R7T8Y9Z0A1B", task.KindTask, "water the plants", at("2026-01-01T09:00:00Z"))
	t.Repeat = &task.Repeat{Method: method, Every: every}
	return t
}

// The three methods differ only in what the next instance's dates are
// computed from, which is the whole of PLAN.md §3.4.
func TestTheThreeMethodsDifferOnlyInWhatTheDatesComeFrom(t *testing.T) {
	completed := at("2026-01-10T18:00:00Z")

	fixed := repeating(task.RepeatFixed, "3d")
	fixed.DeferAt = ptr(at("2026-01-01T09:00:00Z"))
	fixed.DueAt = ptr(at("2026-01-02T09:00:00Z"))
	next, err := Successor(fixed, completed, "01J3SUCCESSOR00000000000A")
	if err != nil {
		t.Fatalf("Successor: %v", err)
	}
	if !next.DeferAt.Equal(at("2026-01-04T09:00:00Z")) || !next.DueAt.Equal(at("2026-01-05T09:00:00Z")) {
		t.Errorf("fixed advances from the previous instance's own dates, so a late completion falls behind\n  got defer %s due %s", next.DeferAt, next.DueAt)
	}

	fromCompletion := repeating(task.RepeatFromCompletion, "3d")
	fromCompletion.DeferAt = ptr(at("2026-01-01T09:00:00Z"))
	fromCompletion.DueAt = ptr(at("2026-01-02T09:00:00Z"))
	next, err = Successor(fromCompletion, completed, "01J3SUCCESSOR00000000000B")
	if err != nil {
		t.Fatalf("Successor: %v", err)
	}
	if !next.DueAt.Equal(at("2026-01-13T18:00:00Z")) {
		t.Errorf("from_completion advances the deadline from the moment of completion, got %s", next.DueAt)
	}
	if !next.DeferAt.Equal(at("2026-01-12T18:00:00Z")) {
		t.Errorf("from_completion keeps the gap the user left between deferring and the deadline, got %s", next.DeferAt)
	}

	deferAnother := repeating(task.RepeatDeferAnother, "3d")
	deferAnother.DeferAt = ptr(at("2026-01-01T09:00:00Z"))
	deferAnother.DueAt = ptr(at("2026-01-02T09:00:00Z"))
	next, err = Successor(deferAnother, completed, "01J3SUCCESSOR00000000000C")
	if err != nil {
		t.Fatalf("Successor: %v", err)
	}
	if !next.DeferAt.Equal(at("2026-01-13T18:00:00Z")) {
		t.Errorf("defer_another moves the defer date from completion, got %s", next.DeferAt)
	}
	if !next.DueAt.Equal(at("2026-01-02T09:00:00Z")) {
		t.Errorf("defer_another leaves the deadline where it was: a real date does not move because the work was touched, got %s", next.DueAt)
	}
}

func TestASuccessorIsAFreshInstanceOfTheSameSeries(t *testing.T) {
	original := repeating(task.RepeatFromCompletion, "1w")
	original.SetTags([]string{"home"})
	original.Fields = task.Fields{"owner": "sam"}
	original.Flagged = true
	original.ParentID = "01J3PARENT0000000000000000"
	original.Position = 4

	completed := at("2026-01-10T18:00:00Z")
	next, err := Complete(original, completed, "01J3SUCCESSOR00000000000A")
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if original.Status != task.StatusDone || original.CompletedAt == nil {
		t.Error("Complete must close the instance it was given")
	}
	if original.SeriesID != original.ID {
		t.Errorf("the first instance names the series, so series_id must be minted from its own id, got %q", original.SeriesID)
	}
	if next.SeriesID != original.SeriesID {
		t.Errorf("the successor must carry the same series_id, got %q", next.SeriesID)
	}
	if next.ID == original.ID {
		t.Error("the successor is a new row with a fresh id")
	}
	if next.Status != task.StatusActive || next.CompletedAt != nil {
		t.Errorf("the successor starts active and uncompleted: %+v", next)
	}
	if next.ParentID != original.ParentID || next.Position != original.Position ||
		!next.Flagged || !next.HasTag("home") || next.Fields["owner"] != "sam" {
		t.Errorf("the successor carries the same fields as the instance it follows: %+v", next)
	}
	if !next.CreatedAt.Equal(completed) {
		t.Errorf("the successor is created at the moment the previous one was completed, got %s", next.CreatedAt)
	}
}

func TestCompletingATaskThatDoesNotRepeatMakesNothing(t *testing.T) {
	plain := task.New("01J3", task.KindTask, "once", at("2026-01-01T09:00:00Z"))
	next, err := Complete(plain, at("2026-01-02T09:00:00Z"), "01J3NEW")
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if next != nil {
		t.Error("a task that does not repeat has no successor; nothing may be manufactured")
	}
	if !plain.Done() {
		t.Error("the task must still be completed")
	}
	if _, err := Successor(plain, at("2026-01-02T09:00:00Z"), "01J3NEW"); !errors.Is(err, ErrNoRepeat) {
		t.Errorf("Successor on a task that does not repeat must report ErrNoRepeat, got %v", err)
	}
}

func TestARepeatWithNoDatesSimplyComesBack(t *testing.T) {
	checklist := repeating(task.RepeatFromCompletion, "1d")
	next, err := Successor(checklist, at("2026-01-10T18:00:00Z"), "01J3NEW")
	if err != nil {
		t.Fatalf("Successor: %v", err)
	}
	if next.DeferAt != nil || next.DueAt != nil {
		t.Errorf("a repeating item with no dates keeps having none: it is simply available again, got defer %v due %v",
			next.DeferAt, next.DueAt)
	}
}

func TestNextReviewIsDerivedAndNeverStale(t *testing.T) {
	now := at("2026-06-01T12:00:00Z")
	project := task.New("01J3", task.KindProject, "a project", now)

	if _, ok := NextReviewAt(project, now); ok {
		t.Error("an item with no review interval is never due for review")
	}

	project.ReviewInterval = &task.ReviewInterval{Every: "1w"}
	got, ok := NextReviewAt(project, now)
	if !ok || !got.Equal(now) {
		t.Errorf("an item never reviewed is due now, which is the honest answer: got %v", got)
	}

	MarkReviewed(project, now)
	got, _ = NextReviewAt(project, now)
	if !got.Equal(at("2026-06-08T12:00:00Z")) {
		t.Errorf("next_review_at is last_reviewed_at plus the interval, got %s", got)
	}

	// An interval this binary cannot read must surface the item rather than
	// hide it, which is how the user finds out about it.
	project.ReviewInterval = &task.ReviewInterval{Every: "every so often"}
	got, ok = NextReviewAt(project, now)
	if !ok || !got.Equal(now) {
		t.Errorf("an unreadable interval must make the item due now rather than invisible: got %v, ok %v", got, ok)
	}
}

func ptr(v time.Time) *time.Time { return &v }
