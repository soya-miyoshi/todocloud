// Package recur turns a completed repeating item into its successor.
//
// It is domain logic with no I/O: it reads a task and returns a new one, and
// the command layer is what writes either of them. That is deliberate. PLAN.md
// §3.4 makes it a safety property that a new instance appears only as the
// direct result of an explicit `tdo done` — nothing is generated in the
// background, on a timer, or during a read, because a tool an agent drives
// must not manufacture rows while it is being read. A package that cannot
// reach a store cannot break that rule by accident.
package recur

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/soya-miyoshi/todocloud/internal/task"
)

// ErrNoRepeat is returned when a task that does not repeat is asked for its
// successor. The caller — `tdo done` — treats it as "nothing more to do".
var ErrNoRepeat = errors.New("task does not repeat")

// Unit is the calendar unit of an interval.
type Unit string

const (
	UnitDay   Unit = "d"
	UnitWeek  Unit = "w"
	UnitMonth Unit = "mo"
	UnitYear  Unit = "y"
)

// Every is a parsed interval: a count of a calendar unit, optionally snapped
// to a weekday within the period it lands in ("1mo:last-friday").
type Every struct {
	N    int
	Unit Unit
	// Ordinal is 1..5 for first..fifth and -1 for last; 0 means no snap.
	Ordinal int
	Weekday time.Weekday
}

// Snapped reports whether the interval names a weekday.
func (e Every) Snapped() bool { return e.Ordinal != 0 }

// String renders the interval back in the spelling it was parsed from, so a
// round trip through the store changes nothing.
func (e Every) String() string {
	s := strconv.Itoa(e.N) + string(e.Unit)
	if !e.Snapped() {
		return s
	}
	return s + ":" + ordinalNames[e.Ordinal] + "-" + strings.ToLower(e.Weekday.String())
}

var ordinalNames = map[int]string{1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth", -1: "last"}

var ordinals = map[string]int{
	"first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5, "last": -1,
}

var weekdays = map[string]time.Weekday{
	"sunday": time.Sunday, "monday": time.Monday, "tuesday": time.Tuesday,
	"wednesday": time.Wednesday, "thursday": time.Thursday,
	"friday": time.Friday, "saturday": time.Saturday,
}

// ParseEvery reads the duration-with-calendar spelling of §3.4: "3d", "2w",
// "1mo", "1y", and "1mo:last-friday" for the calendar cases.
//
// The error messages name what was expected, because this string is typed by
// a user at a terminal and the spelling is the whole interface.
func ParseEvery(s string) (Every, error) {
	raw := strings.TrimSpace(strings.ToLower(s))
	if raw == "" {
		return Every{}, errors.New("an interval must say how often, for example 1w or 1mo:last-friday")
	}
	period, snap, hasSnap := strings.Cut(raw, ":")

	digits := 0
	for digits < len(period) && period[digits] >= '0' && period[digits] <= '9' {
		digits++
	}
	if digits == 0 {
		return Every{}, fmt.Errorf("interval %q must start with a number, for example 1w", s)
	}
	n, err := strconv.Atoi(period[:digits])
	if err != nil || n <= 0 {
		return Every{}, fmt.Errorf("interval %q must repeat at least once, for example 1w", s)
	}
	unit := Unit(period[digits:])
	switch unit {
	case UnitDay, UnitWeek, UnitMonth, UnitYear:
	default:
		return Every{}, fmt.Errorf("interval %q uses unit %q; expected d, w, mo or y", s, period[digits:])
	}

	e := Every{N: n, Unit: unit}
	if !hasSnap {
		return e, nil
	}
	name, day, ok := strings.Cut(snap, "-")
	ordinal, okOrdinal := ordinals[name]
	weekday, okWeekday := weekdays[day]
	if !ok || !okOrdinal || !okWeekday {
		return Every{}, fmt.Errorf("interval %q: expected a calendar day like last-friday or first-monday", s)
	}
	if unit != UnitMonth && unit != UnitYear {
		// A weekday within a week or a day is either a no-op or a
		// contradiction; refusing it is clearer than guessing which.
		return Every{}, fmt.Errorf("interval %q: a calendar day only makes sense with mo or y, not %s", s, unit)
	}
	e.Ordinal = ordinal
	e.Weekday = weekday
	return e, nil
}

// Next returns the instant one interval after from, in UTC.
//
// Month and year arithmetic clamps rather than overflowing: one month after
// 31 January is 28 or 29 February, not 2 or 3 March, because a monthly chore
// set on the 31st should not drift into the following month. Go's AddDate
// normalises instead, so the clamp is done here.
func (e Every) Next(from time.Time) time.Time {
	at := from.UTC()
	var out time.Time
	switch e.Unit {
	case UnitDay:
		out = at.AddDate(0, 0, e.N)
	case UnitWeek:
		out = at.AddDate(0, 0, 7*e.N)
	case UnitMonth:
		out = addMonths(at, e.N)
	case UnitYear:
		out = addMonths(at, 12*e.N)
	default:
		out = at
	}
	if e.Snapped() {
		out = snapWeekday(out, e.Ordinal, e.Weekday)
	}
	return out
}

// addMonths advances by whole months, clamping the day to the last day of the
// target month.
func addMonths(at time.Time, months int) time.Time {
	year, month, day := at.Date()
	total := int(month) - 1 + months
	year += total / 12
	total %= 12
	if total < 0 {
		total += 12
		year--
	}
	target := time.Month(total + 1)
	if last := daysIn(year, target); day > last {
		day = last
	}
	h, m, s := at.Clock()
	return time.Date(year, target, day, h, m, s, at.Nanosecond(), time.UTC)
}

func daysIn(year int, month time.Month) int {
	return time.Date(year, month+1, 0, 0, 0, 0, 0, time.UTC).Day()
}

// snapWeekday moves at to the nth given weekday of its own month, keeping the
// time of day. A fifth weekday that the month does not have falls back to the
// last one, which is what a user who wrote "fifth-monday" meant by it.
func snapWeekday(at time.Time, ordinal int, weekday time.Weekday) time.Time {
	year, month, _ := at.Date()
	h, m, s := at.Clock()
	first := time.Date(year, month, 1, h, m, s, at.Nanosecond(), time.UTC)
	offset := (int(weekday) - int(first.Weekday()) + 7) % 7
	day := 1 + offset

	last := daysIn(year, month)
	if ordinal < 0 {
		for day+7 <= last {
			day += 7
		}
	} else {
		day += 7 * (ordinal - 1)
		for day > last {
			day -= 7
		}
	}
	return time.Date(year, month, day, h, m, s, at.Nanosecond(), time.UTC)
}

// EnsureSeries gives a repeating task a series id if it has none, minting it
// from its own id: the first instance names the series, so no second
// generator is needed and the series is readable in an export. It reports
// whether it changed anything.
func EnsureSeries(t *task.Task) bool {
	if t.Repeat == nil || t.SeriesID != "" {
		return false
	}
	t.SeriesID = t.ID
	return true
}

// Successor returns the next instance of a repeating task, with the id the
// caller minted for it. It does not touch t; Complete is the entry point that
// also closes the current instance.
//
// The three methods differ only in what the dates are computed from (§3.4).
// A repeating task with no dates at all keeps having none: the successor is
// simply available again, which is what a repeating checklist item is.
func Successor(t *task.Task, completedAt time.Time, newID string) (*task.Task, error) {
	if t.Repeat == nil {
		return nil, fmt.Errorf("%s: %w", t.ID, ErrNoRepeat)
	}
	if newID == "" {
		return nil, errors.New("a successor needs an id")
	}
	every, err := ParseEvery(t.Repeat.Every)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", t.ID, err)
	}
	at := completedAt.UTC()

	next := t.Clone()
	next.ID = newID
	next.Status = task.StatusActive
	next.CompletedAt = nil
	next.DroppedAt = nil
	next.DeletedAt = nil
	next.LastReviewedAt = nil
	next.CreatedAt = at
	next.UpdatedAt = at
	next.SeriesID = t.SeriesID
	if next.SeriesID == "" {
		next.SeriesID = t.ID
	}

	switch t.Repeat.Method {
	case task.RepeatFixed:
		// From the previous instance's own dates, so a schedule kept this
		// way is a calendar and can fall behind when it is done late.
		next.DeferAt = shift(every, t.DeferAt)
		next.DueAt = shift(every, t.DueAt)
	case task.RepeatFromCompletion:
		// From the moment of completion: "every 3 days after I actually do
		// it". The gap the user left between deferring and the deadline is
		// part of the shape of the task, so it is carried over.
		if t.DueAt != nil {
			due := every.Next(at)
			next.DueAt = &due
			if t.DeferAt != nil {
				lead := t.DueAt.Sub(*t.DeferAt)
				defer_ := due.Add(-lead)
				next.DeferAt = &defer_
			}
		} else if t.DeferAt != nil {
			d := every.Next(at)
			next.DeferAt = &d
		}
	case task.RepeatDeferAnother:
		// Only the defer date moves, and it moves from completion: put this
		// out of sight for another interval. A deadline, if there is one,
		// is a real date and does not move because the work was touched.
		d := every.Next(at)
		next.DeferAt = &d
		next.DueAt = cloneTime(t.DueAt)
	default:
		return nil, fmt.Errorf("%s: repeat method %q is not one of fixed, from_completion or defer_another", t.ID, t.Repeat.Method)
	}
	return next, nil
}

// Complete marks t done and returns its successor, or nil when t does not
// repeat. It is the one call `tdo done` makes, so that minting the series id
// onto the current instance cannot be forgotten: the caller writes t back and
// adds the successor, both or neither.
//
// `tdo done --no-repeat` simply does not call this.
func Complete(t *task.Task, now time.Time, newID string) (*task.Task, error) {
	at := now.UTC()
	if t.Repeat == nil {
		t.SetStatus(task.StatusDone, at)
		return nil, nil
	}
	EnsureSeries(t)
	next, err := Successor(t, at, newID)
	if err != nil {
		return nil, err
	}
	t.SetStatus(task.StatusDone, at)
	return next, nil
}

// NextReviewAt derives when a folder or project is next due to be looked at:
// last_reviewed_at plus the interval (§3.5). It is derived rather than stored
// so it cannot drift out of sync with either half.
//
// An item with a review interval that has never been reviewed is due now,
// which is the honest answer: nobody has looked at it.
func NextReviewAt(t *task.Task, now time.Time) (time.Time, bool) {
	if t.ReviewInterval == nil {
		return time.Time{}, false
	}
	every, err := ParseEvery(t.ReviewInterval.Every)
	if err != nil {
		// An interval this binary cannot read must not hide the item from
		// `tdo review`; surfacing it is how the user finds out.
		return now.UTC(), true
	}
	if t.LastReviewedAt == nil {
		return now.UTC(), true
	}
	return every.Next(*t.LastReviewedAt), true
}

// MarkReviewed records that the item was looked at now. The caller writes it
// back; next_review_at follows from it.
func MarkReviewed(t *task.Task, now time.Time) {
	at := now.UTC()
	t.LastReviewedAt = &at
	t.UpdatedAt = at
}

func shift(e Every, at *time.Time) *time.Time {
	if at == nil {
		return nil
	}
	next := e.Next(*at)
	return &next
}

func cloneTime(at *time.Time) *time.Time {
	if at == nil {
		return nil
	}
	c := *at
	return &c
}
