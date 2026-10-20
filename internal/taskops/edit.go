package taskops

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/soya-miyoshi/todocloud/internal/recur"
	"github.com/soya-miyoshi/todocloud/internal/task"
)

// ErrInvalid marks a request this layer refused: a reserved field name, a
// priority out of range, a task that would not validate. Every front end
// needs that distinction — the CLI exits 2 rather than 1, and the server
// answers 400 rather than 500 — and only this layer knows which it was.
var ErrInvalid = errors.New("invalid request")

// invalidf builds an ErrInvalid with its own wording.
func invalidf(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalid, fmt.Sprintf(format, args...))
}

// Edit is a change to an existing item: the properties a caller named, and
// nothing else. A nil pointer means "leave it alone", which is the
// distinction `tdo edit --note ""` depends on — clearing a note and not
// touching it are different requests.
//
// The order the fields are applied in is part of the behaviour: the sugar
// first, then Set, then Unset, so the more explicit instruction wins when a
// key is named twice.
type Edit struct {
	Title            *string
	Note             *string
	EstimatedMinutes *int
	// Tags replaces the whole set, which is what "these are its tags" means;
	// Untag is the way to remove one of several.
	Tags  *[]string
	Untag []string
	// Priority is a required field with a flag of its own; Set and Unset are
	// what is left, and they are stored in the open map untouched.
	Priority *int
	Set      map[string]any
	Unset    []string
}

// Empty reports whether e changes nothing.
func (e Edit) Empty() bool {
	return e.Title == nil && e.Note == nil && e.EstimatedMinutes == nil &&
		e.Tags == nil && len(e.Untag) == 0 && e.Priority == nil &&
		len(e.Set) == 0 && len(e.Unset) == 0
}

func (e Edit) apply(t *task.Task) error {
	if e.Title != nil {
		t.Title = strings.TrimSpace(*e.Title)
	}
	if e.Note != nil {
		t.Note = *e.Note
	}
	if e.EstimatedMinutes != nil {
		t.EstimatedMinutes = *e.EstimatedMinutes
	}
	if e.Tags != nil {
		t.SetTags(NormalizeTags(*e.Tags))
	}
	if len(e.Untag) > 0 {
		remove := NormalizeTags(e.Untag)
		kept := make([]string, 0, len(t.Tags))
		for _, tag := range t.Tags {
			drop := false
			for _, unwanted := range remove {
				if strings.EqualFold(tag, unwanted) {
					drop = true
					break
				}
			}
			if !drop {
				kept = append(kept, tag)
			}
		}
		t.SetTags(kept)
	}
	return applyFields(t.Fields, e.Priority, e.Set, e.Unset)
}

// applyFields writes the priority, the user-defined fields and the removals
// onto f, refusing a reserved name: a key that shadowed a required field
// would be invisible in the flattened JSON of §3.2.
func applyFields(f task.Fields, priority *int, set map[string]any, unset []string) error {
	if priority != nil {
		if *priority < 0 || *priority > 3 {
			return invalidf("priority must be between 0 and 3, got %d", *priority)
		}
		f.Set(task.KeyPriority, *priority)
	}
	for _, key := range sortedKeys(set) {
		if task.Reserved(key) {
			return invalidf("field %q is reserved and cannot be set", key)
		}
		f.Set(key, set[key])
	}
	for _, key := range unset {
		key = strings.TrimSpace(key)
		if key == "" {
			return invalidf("a field to remove needs a name")
		}
		if task.Reserved(key) {
			return invalidf("field %q is reserved and cannot be unset", key)
		}
		f.Delete(key)
	}
	return nil
}

// sortedKeys gives the keys of a map in a fixed order, so that two fields
// set in one request are written in the same order every time and a failure
// on one of them is reproducible.
func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	for i := 1; i < len(keys); i++ {
		for j := i; j > 0 && keys[j] < keys[j-1]; j-- {
			keys[j], keys[j-1] = keys[j-1], keys[j]
		}
	}
	return keys
}

// NormalizeTags drops blanks and duplicates while keeping the order they
// were written in. Tags are compared case-insensitively, because that is how
// they are matched.
func NormalizeTags(tags []string) []string {
	out := make([]string, 0, len(tags))
	seen := make(map[string]bool, len(tags))
	for _, value := range tags {
		for _, tag := range strings.Split(value, ",") {
			tag = strings.TrimSpace(tag)
			if tag == "" {
				continue
			}
			key := strings.ToLower(tag)
			if seen[key] {
				continue
			}
			seen[key] = true
			out = append(out, tag)
		}
	}
	return out
}

// Draft is a new item before it has an id: everything a creating caller
// decides, with the tree position it goes into.
type Draft struct {
	Kind             task.Kind
	Title            string
	ParentID         string
	Flagged          bool
	Tags             []string
	Note             string
	DeferAt          *time.Time
	DueAt            *time.Time
	EstimatedMinutes int
	Repeat           *task.Repeat
	Priority         *int
	Set              map[string]any
}

// Build turns a draft into a validated task. It is the one place a new item
// is assembled, so `tdo add`, `tdo project` and the server all produce the
// same row for the same request.
func (d Draft) Build(taskID string, now time.Time) (*task.Task, error) {
	t := task.New(taskID, d.Kind, strings.TrimSpace(d.Title), now)
	t.ParentID = d.ParentID
	t.Flagged = d.Flagged
	t.Note = d.Note
	t.DeferAt = d.DeferAt
	t.DueAt = d.DueAt
	t.EstimatedMinutes = d.EstimatedMinutes
	if len(d.Tags) > 0 {
		t.SetTags(NormalizeTags(d.Tags))
	}
	if d.Repeat != nil {
		t.Repeat = d.Repeat
		// The first instance names the series, so a successor can be tied to
		// it without a second generator.
		recur.EnsureSeries(t)
	}
	if err := applyFields(t.Fields, d.Priority, d.Set, nil); err != nil {
		return nil, err
	}
	if err := t.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", ErrInvalid, err)
	}
	return t, nil
}

// ParseMinutes reads a duration in the spellings every front end accepts:
// 25m, 2h, 1h30m, or a bare number of minutes.
func ParseMinutes(raw string) (int, error) {
	s := strings.TrimSpace(strings.ToLower(raw))
	if s == "" {
		return 0, invalidf("expected a duration, for example 25m")
	}
	if n, err := strconv.Atoi(s); err == nil {
		if n < 0 {
			return 0, invalidf("a duration must not be negative, got %q", raw)
		}
		return n, nil
	}
	d, err := time.ParseDuration(s)
	if err != nil || d < 0 {
		return 0, invalidf("%q is not a duration; write it as 25m, 2h or 1h30m", raw)
	}
	return int(d / time.Minute), nil
}

// ParseRepeat reads `EVERY[:method]`.
//
// A repeat with no method named is a calendar schedule: the next instance
// follows the previous instance's dates, which is what someone writing
// "every Monday" means. The other two methods are asked for by name. The
// interval spelling may itself carry a colon ("1mo:last-friday"), so the
// method is recognised by name at the end rather than by position: anything
// that is not one of the three methods is part of the interval.
func ParseRepeat(raw string) (*task.Repeat, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return nil, invalidf("a repeat needs an interval, for example 1w or 1w:from_completion")
	}
	every := s
	method := task.RepeatFixed
	if i := strings.LastIndex(s, ":"); i >= 0 {
		if m := task.RepeatMethod(s[i+1:]); m.Valid() {
			every, method = s[:i], m
		}
	}
	if _, err := recur.ParseEvery(every); err != nil {
		return nil, fmt.Errorf("%w: %s", ErrInvalid, err)
	}
	return &task.Repeat{Method: method, Every: every}, nil
}
