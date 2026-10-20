// Package task defines the data model shared by every provider.
//
// A task has a set of required fields, which are real columns on SQL
// providers and real document fields on Firestore, plus Fields: an open map of
// user-defined values that the CLI carries through untouched. Required fields
// are typed; everything else is JSON. That split is what lets one schema serve
// users who want a plain checklist and users who want a dozen attributes per
// task, without a migration for every new attribute.
//
// The model is the GTD one described in PLAN.md §3: folders, projects and
// actions are one shape with a kind, containment is a single parent edge, and
// four statuses replace the boolean "done" so that "not now" and "decided
// against" are distinguishable from "finished".
package task

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

// Reserved keys are the required fields plus the keys the JSON representation
// derives. A user-defined field may not use one of these names, because the
// JSON output flattens Fields alongside them and a collision would make the
// required field unreadable.
const (
	KeyID                  = "id"
	KeyKind                = "kind"
	KeyTitle               = "title"
	KeyParentID            = "parent_id"
	KeyPosition            = "position"
	KeyStatus              = "status"
	KeyFlagged             = "flagged"
	KeySequential          = "sequential"
	KeyCompletedByChildren = "completed_by_children"
	KeyDeferAt             = "defer_at"
	KeyDueAt               = "due_at"
	KeyEstimatedMinutes    = "estimated_minutes"
	KeyNote                = "note"
	KeyRepeat              = "repeat"
	KeySeriesID            = "series_id"
	KeyReviewInterval      = "review_interval"
	KeyLastReviewedAt      = "last_reviewed_at"
	KeyCreatedAt           = "created_at"
	KeyUpdatedAt           = "updated_at"
	KeyCompletedAt         = "completed_at"
	KeyDroppedAt           = "dropped_at"
	KeyDeletedAt           = "deleted_at"
	KeyTags                = "tags"
)

// Derived keys are not stored. They are computed on the way out, and they are
// reserved for the same reason the stored ones are: a user-defined field of
// the same name would be shadowed by the computed value in --json, which is
// a silent loss rather than an error.
const (
	// KeyDone is status == StatusDone, kept so the common case stays one key.
	KeyDone = "done"
	// KeyAvailable and KeyBlockedBy are written by `tdo ls --json`; see
	// store.Availability.
	KeyAvailable  = "available"
	KeyBlockedBy  = "blocked_by"
	KeyNextReview = "next_review_at"
)

// Well-known keys live in Fields but have dedicated flags and a documented
// place in the JSON output, so they are always present in it. Priority is not
// part of the GTD model — OmniFocus has flagged, not a priority number — but
// `tdo add --priority` predates it and users have it in their fingers, so it
// survives as an ordinary open field with a guaranteed key.
const KeyPriority = "priority"

var reserved = map[string]bool{
	KeyID:                  true,
	KeyKind:                true,
	KeyTitle:               true,
	KeyParentID:            true,
	KeyPosition:            true,
	KeyStatus:              true,
	KeyFlagged:             true,
	KeySequential:          true,
	KeyCompletedByChildren: true,
	KeyDeferAt:             true,
	KeyDueAt:               true,
	KeyEstimatedMinutes:    true,
	KeyNote:                true,
	KeyRepeat:              true,
	KeySeriesID:            true,
	KeyReviewInterval:      true,
	KeyLastReviewedAt:      true,
	KeyCreatedAt:           true,
	KeyUpdatedAt:           true,
	KeyCompletedAt:         true,
	KeyDroppedAt:           true,
	KeyDeletedAt:           true,
	KeyTags:                true,
	KeyDone:                true,
	KeyAvailable:           true,
	KeyBlockedBy:           true,
	KeyNextReview:          true,
}

// Reserved reports whether key is a required or derived field name and
// therefore not available as a user-defined field.
func Reserved(key string) bool { return reserved[key] }

// ReservedKeys returns the reserved names, sorted.
func ReservedKeys() []string {
	keys := make([]string, 0, len(reserved))
	for k := range reserved {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// Kind is what a node of the tree is. Folders, projects and actions are the
// same shape; the kind is what decides where a node may sit and whether it is
// actionable.
type Kind string

const (
	// KindFolder organises. It may contain folders and projects, is never
	// actionable, and is never completed.
	KindFolder Kind = "folder"
	// KindProject is an outcome. It contains tasks and is completable.
	KindProject Kind = "project"
	// KindTask is an action. It may contain tasks, which makes it an action
	// group, and a task with no parent is in the inbox.
	KindTask Kind = "task"
)

// Valid reports whether k is one of the three kinds.
func (k Kind) Valid() bool {
	switch k {
	case KindFolder, KindProject, KindTask:
		return true
	}
	return false
}

func (k Kind) String() string { return string(k) }

// Kinds returns the three kinds in the order the tree nests them.
func Kinds() []Kind { return []Kind{KindFolder, KindProject, KindTask} }

// CanContain reports whether a node of kind k may be the parent of a node of
// kind child. It is the table in PLAN.md §3.1, and the store enforces it:
// a broken tree is worse than a rejected command.
func (k Kind) CanContain(child Kind) bool {
	switch k {
	case KindFolder:
		return child == KindFolder || child == KindProject
	case KindProject:
		return child == KindTask
	case KindTask:
		return child == KindTask
	}
	return false
}

// Status is where an item stands. Four states are needed because GTD
// distinguishes "not now" from "never, but remember I decided that", and both
// from "finished".
type Status string

const (
	// StatusActive is the ordinary state.
	StatusActive Status = "active"
	// StatusOnHold is paused: it and everything under it drop out of every
	// list until it is active again. That is the whole point of a hold.
	StatusOnHold Status = "on_hold"
	// StatusDone is finished.
	StatusDone Status = "done"
	// StatusDropped is abandoned on purpose, and kept so the decision is not
	// made again.
	StatusDropped Status = "dropped"
)

// Valid reports whether s is one of the four statuses.
func (s Status) Valid() bool {
	switch s {
	case StatusActive, StatusOnHold, StatusDone, StatusDropped:
		return true
	}
	return false
}

func (s Status) String() string { return string(s) }

// Closed reports whether the status means the item needs no more attention.
// A sequential container skips over its closed children when deciding which
// child is next.
func (s Status) Closed() bool { return s == StatusDone || s == StatusDropped }

// Statuses returns the four statuses.
func Statuses() []Status {
	return []Status{StatusActive, StatusOnHold, StatusDone, StatusDropped}
}

// RepeatMethod is what the next instance's dates are computed from. The three
// are OmniFocus's three; see PLAN.md §3.4.
type RepeatMethod string

const (
	// RepeatFixed advances from the previous instance's own dates, so a
	// schedule kept this way can fall behind.
	RepeatFixed RepeatMethod = "fixed"
	// RepeatFromCompletion advances from the moment of completion.
	RepeatFromCompletion RepeatMethod = "from_completion"
	// RepeatDeferAnother advances from the moment of completion and moves
	// only defer_at, leaving the due date where it was.
	RepeatDeferAnother RepeatMethod = "defer_another"
)

// Valid reports whether m is one of the three methods.
func (m RepeatMethod) Valid() bool {
	switch m {
	case RepeatFixed, RepeatFromCompletion, RepeatDeferAnother:
		return true
	}
	return false
}

func (m RepeatMethod) String() string { return string(m) }

// Repeat describes a repeating item. Every is a duration-with-calendar
// spelling ("3d", "2w", "1mo", "1y", "1mo:last-friday"); internal/recur parses
// it and computes the successor. This package keeps the value as written so
// that a spelling a newer binary understands survives an older one's round
// trip untouched.
type Repeat struct {
	Method RepeatMethod `json:"method"`
	Every  string       `json:"every"`
}

// Clone returns a copy, or nil for nil.
func (r *Repeat) Clone() *Repeat {
	if r == nil {
		return nil
	}
	c := *r
	return &c
}

// Equal reports whether two repeats describe the same schedule.
func (r *Repeat) Equal(other *Repeat) bool {
	if r == nil || other == nil {
		return r == other
	}
	return *r == *other
}

// ReviewInterval is how often a folder or project should be looked at.
// next_review_at is derived from last_reviewed_at plus Every rather than
// stored, so it cannot drift out of sync with either.
type ReviewInterval struct {
	Every string `json:"every"`
}

// Clone returns a copy, or nil for nil.
func (r *ReviewInterval) Clone() *ReviewInterval {
	if r == nil {
		return nil
	}
	c := *r
	return &c
}

// Equal reports whether two intervals are the same.
func (r *ReviewInterval) Equal(other *ReviewInterval) bool {
	if r == nil || other == nil {
		return r == other
	}
	return *r == *other
}

// Task is one node of the tree: a folder, a project or an action.
type Task struct {
	ID    string
	Kind  Kind
	Title string
	// ParentID is empty at the top level, which for a task means the inbox.
	// The inbox is not a container; it is the absence of one, so nothing has
	// to create it and it cannot be deleted.
	ParentID string
	// Position orders siblings manually. Ties break by id, which is creation
	// order, so an unset position still gives a stable listing.
	Position int

	Status              Status
	Flagged             bool
	Sequential          bool
	CompletedByChildren bool

	DeferAt          *time.Time
	DueAt            *time.Time
	EstimatedMinutes int
	Note             string

	Repeat   *Repeat
	SeriesID string

	ReviewInterval *ReviewInterval
	LastReviewedAt *time.Time

	CreatedAt   time.Time
	UpdatedAt   time.Time
	CompletedAt *time.Time
	DroppedAt   *time.Time
	DeletedAt   *time.Time

	// Tags are many-to-many and stored relationally, not in Fields, because
	// `tdo ls --tag home` must be a join and not a scan. They are carried on
	// the task so that nothing above the store has to assemble them.
	Tags []string

	// Fields holds every user-defined value. It is never nil on a task
	// returned by a store.
	Fields Fields
}

// New returns a task with the defaults every new node starts from. The caller
// supplies the id and the clock, because both belong to it: ids are generated
// where the task is created and tests need a fixed now.
func New(taskID string, kind Kind, title string, now time.Time) *Task {
	at := now.UTC()
	return &Task{
		ID:        taskID,
		Kind:      kind,
		Title:     title,
		Status:    StatusActive,
		CreatedAt: at,
		UpdatedAt: at,
		Fields:    Fields{},
	}
}

// Deleted reports whether the task carries a tombstone.
func (t *Task) Deleted() bool { return t.DeletedAt != nil }

// Done reports whether the task is finished. It is the derived convenience
// the JSON output carries as "done".
func (t *Task) Done() bool { return t.Status == StatusDone }

// Inbox reports whether the task is a loose action: a task with no parent.
// A folder or a project at the top level is not in the inbox; it is the top
// level.
func (t *Task) Inbox() bool { return t.Kind == KindTask && t.ParentID == "" }

// Actionable reports whether this kind of node can ever be worked on. A
// folder organises and is never actionable, whatever its status.
func (t *Task) Actionable() bool { return t.Kind != KindFolder }

// Clone returns a deep copy, so a caller can edit a task without affecting the
// value a store still holds.
func (t *Task) Clone() *Task {
	if t == nil {
		return nil
	}
	c := *t
	c.DeferAt = cloneTime(t.DeferAt)
	c.DueAt = cloneTime(t.DueAt)
	c.LastReviewedAt = cloneTime(t.LastReviewedAt)
	c.CompletedAt = cloneTime(t.CompletedAt)
	c.DroppedAt = cloneTime(t.DroppedAt)
	c.DeletedAt = cloneTime(t.DeletedAt)
	c.Repeat = t.Repeat.Clone()
	c.ReviewInterval = t.ReviewInterval.Clone()
	c.Tags = append([]string(nil), t.Tags...)
	c.Fields = t.Fields.Clone()
	return &c
}

func cloneTime(v *time.Time) *time.Time {
	if v == nil {
		return nil
	}
	c := *v
	return &c
}

// ErrEmptyTitle is returned by Validate when the title is blank.
var ErrEmptyTitle = errors.New("title must not be empty")

// Validate checks the invariants every provider relies on. It is about the
// node alone; rules that need the parent — which kinds may contain which, and
// cycles — belong to the store, which is the only thing that can see the tree.
func (t *Task) Validate() error {
	if strings.TrimSpace(t.Title) == "" {
		return ErrEmptyTitle
	}
	if t.ID == "" {
		return errors.New("id must not be empty")
	}
	if !t.Kind.Valid() {
		return fmt.Errorf("kind %q is not one of folder, project or task", t.Kind)
	}
	if !t.Status.Valid() {
		return fmt.Errorf("status %q is not one of active, on_hold, done or dropped", t.Status)
	}
	if t.Kind == KindFolder && t.Status == StatusDone {
		return errors.New("a folder is never completed; drop it or delete it instead")
	}
	if t.ParentID == t.ID {
		return fmt.Errorf("%s cannot be its own parent", t.ID)
	}
	if t.CreatedAt.IsZero() || t.UpdatedAt.IsZero() {
		return errors.New("created_at and updated_at must be set")
	}
	if t.EstimatedMinutes < 0 {
		return fmt.Errorf("estimated_minutes must not be negative, got %d", t.EstimatedMinutes)
	}
	if t.Repeat != nil {
		if !t.Repeat.Method.Valid() {
			return fmt.Errorf("repeat method %q is not one of fixed, from_completion or defer_another", t.Repeat.Method)
		}
		if strings.TrimSpace(t.Repeat.Every) == "" {
			return errors.New("a repeat must say how often: set every, for example 1w")
		}
	}
	if t.ReviewInterval != nil {
		if strings.TrimSpace(t.ReviewInterval.Every) == "" {
			return errors.New("a review interval must say how often: set every, for example 1w")
		}
		if t.Kind == KindTask {
			return errors.New("a review interval belongs on a folder or a project, not on a task")
		}
	}
	for _, tag := range t.Tags {
		if strings.TrimSpace(tag) == "" {
			return errors.New("a tag must not be empty")
		}
	}
	for key := range t.Fields {
		if Reserved(key) {
			return fmt.Errorf("field %q is reserved; it cannot be set as a user-defined field", key)
		}
		if key == "" {
			return errors.New("a user-defined field name must not be empty")
		}
	}
	if p, ok := t.Fields.Int(KeyPriority); ok && (p < 0 || p > 3) {
		return fmt.Errorf("priority must be between 0 and 3, got %d", p)
	}
	return nil
}

// SetStatus moves the task to status and keeps the three timestamps that
// record how it got there consistent with it. Setting the status a task
// already has changes nothing, so a repeated `tdo done` does not move
// completed_at.
func (t *Task) SetStatus(s Status, now time.Time) {
	if s == t.Status {
		return
	}
	at := now.UTC()
	t.Status = s
	switch s {
	case StatusDone:
		t.CompletedAt = &at
		t.DroppedAt = nil
	case StatusDropped:
		t.DroppedAt = &at
		t.CompletedAt = nil
	default:
		t.CompletedAt = nil
		t.DroppedAt = nil
	}
	t.UpdatedAt = at
}

// SetTags replaces the tag set, trimming blanks and removing duplicates
// case-insensitively while keeping the spelling the user typed first. Tags are
// compared case-insensitively everywhere, so storing both "Home" and "home"
// would make one of them unreachable.
func (t *Task) SetTags(tags []string) {
	seen := make(map[string]bool, len(tags))
	out := make([]string, 0, len(tags))
	for _, tag := range tags {
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
	sort.SliceStable(out, func(i, j int) bool {
		return strings.ToLower(out[i]) < strings.ToLower(out[j])
	})
	t.Tags = out
}

// HasTag reports whether the task carries tag, compared case-insensitively.
func (t *Task) HasTag(tag string) bool {
	for _, have := range t.Tags {
		if strings.EqualFold(have, tag) {
			return true
		}
	}
	return false
}

// MarshalJSON renders the documented shape: the required fields, then the
// derived "done", then every user-defined field flattened alongside them.
func (t *Task) MarshalJSON() ([]byte, error) {
	out := map[string]any{
		KeyID:                  t.ID,
		KeyKind:                string(t.Kind),
		KeyTitle:               t.Title,
		KeyParentID:            optionalString(t.ParentID),
		KeyPosition:            t.Position,
		KeyStatus:              string(t.Status),
		KeyFlagged:             t.Flagged,
		KeySequential:          t.Sequential,
		KeyCompletedByChildren: t.CompletedByChildren,
		KeyDeferAt:             optionalTime(t.DeferAt),
		KeyDueAt:               optionalTime(t.DueAt),
		KeyEstimatedMinutes:    t.EstimatedMinutes,
		KeyNote:                optionalString(t.Note),
		KeyRepeat:              optionalRepeat(t.Repeat),
		KeySeriesID:            optionalString(t.SeriesID),
		KeyReviewInterval:      optionalReview(t.ReviewInterval),
		KeyLastReviewedAt:      optionalTime(t.LastReviewedAt),
		KeyCreatedAt:           FormatTime(t.CreatedAt),
		KeyUpdatedAt:           FormatTime(t.UpdatedAt),
		KeyCompletedAt:         optionalTime(t.CompletedAt),
		KeyDroppedAt:           optionalTime(t.DroppedAt),
		KeyDeletedAt:           optionalTime(t.DeletedAt),
		KeyTags:                tagsOrEmpty(t.Tags),
		// done is derived, not stored. It is here so the common question —
		// is this finished? — stays one key for a caller that does not care
		// about the other three statuses.
		KeyDone: t.Done(),
	}

	for k, v := range t.Fields {
		if Reserved(k) {
			continue
		}
		out[k] = v
	}
	// Keep the documented open key present even when the user never set it.
	if _, ok := out[KeyPriority]; !ok {
		out[KeyPriority] = 0
	}
	return json.Marshal(out)
}

// UnmarshalJSON reads the shape MarshalJSON writes, putting every unreserved
// key back into Fields. It is what makes `tdo export | tdo import` lossless,
// including for fields this version of the binary knows nothing about.
//
// The derived keys are read and discarded: they are computed, and accepting
// one as a user-defined field would make the next export disagree with the
// import that produced it.
func (t *Task) UnmarshalJSON(data []byte) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	decodeValue := func(b []byte, into *any) error {
		dec := json.NewDecoder(bytes.NewReader(b))
		// UseNumber keeps an integer out of float64 until Fields.Normalize
		// decides its Go type, so a user-defined number round-trips exactly.
		dec.UseNumber()
		return dec.Decode(into)
	}

	*t = Task{Fields: Fields{}}
	for key, value := range raw {
		var err error
		switch key {
		case KeyID:
			err = json.Unmarshal(value, &t.ID)
		case KeyKind:
			err = unmarshalString(value, (*string)(&t.Kind))
		case KeyTitle:
			err = json.Unmarshal(value, &t.Title)
		case KeyParentID:
			err = unmarshalOptionalString(value, &t.ParentID)
		case KeyPosition:
			err = json.Unmarshal(value, &t.Position)
		case KeyStatus:
			err = unmarshalString(value, (*string)(&t.Status))
		case KeyFlagged:
			err = json.Unmarshal(value, &t.Flagged)
		case KeySequential:
			err = json.Unmarshal(value, &t.Sequential)
		case KeyCompletedByChildren:
			err = json.Unmarshal(value, &t.CompletedByChildren)
		case KeyDeferAt:
			t.DeferAt, err = unmarshalOptionalTime(value)
		case KeyDueAt:
			t.DueAt, err = unmarshalOptionalTime(value)
		case KeyEstimatedMinutes:
			err = json.Unmarshal(value, &t.EstimatedMinutes)
		case KeyNote:
			err = unmarshalOptionalString(value, &t.Note)
		case KeyRepeat:
			t.Repeat, err = unmarshalRepeat(value)
		case KeySeriesID:
			err = unmarshalOptionalString(value, &t.SeriesID)
		case KeyReviewInterval:
			t.ReviewInterval, err = unmarshalReview(value)
		case KeyLastReviewedAt:
			t.LastReviewedAt, err = unmarshalOptionalTime(value)
		case KeyCreatedAt:
			t.CreatedAt, err = unmarshalTime(value)
		case KeyUpdatedAt:
			t.UpdatedAt, err = unmarshalTime(value)
		case KeyCompletedAt:
			t.CompletedAt, err = unmarshalOptionalTime(value)
		case KeyDroppedAt:
			t.DroppedAt, err = unmarshalOptionalTime(value)
		case KeyDeletedAt:
			t.DeletedAt, err = unmarshalOptionalTime(value)
		case KeyTags:
			var tags []string
			if err = json.Unmarshal(value, &tags); err == nil {
				t.SetTags(tags)
			}
		case KeyDone, KeyAvailable, KeyBlockedBy, KeyNextReview:
			// Derived; recomputed on the way out.
		default:
			var v any
			if err = decodeValue(value, &v); err == nil && v != nil {
				t.Fields[key] = v
			}
		}
		if err != nil {
			return fmt.Errorf("field %q: %w", key, err)
		}
	}
	// A document that predates a key, or one a human wrote by hand, should
	// still land on a usable task rather than on an invalid one.
	if t.Kind == "" {
		t.Kind = KindTask
	}
	if t.Status == "" {
		t.Status = StatusActive
	}
	t.Fields.Normalize()
	return nil
}

func optionalString(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func optionalTime(v *time.Time) any {
	if v == nil {
		return nil
	}
	return FormatTime(*v)
}

func optionalRepeat(r *Repeat) any {
	if r == nil {
		return nil
	}
	return r
}

func optionalReview(r *ReviewInterval) any {
	if r == nil {
		return nil
	}
	return r
}

func tagsOrEmpty(tags []string) []string {
	if tags == nil {
		return []string{}
	}
	return tags
}

func unmarshalString(data []byte, into *string) error {
	if string(data) == "null" {
		*into = ""
		return nil
	}
	return json.Unmarshal(data, into)
}

func unmarshalOptionalString(data []byte, into *string) error {
	return unmarshalString(data, into)
}

func unmarshalTime(data []byte) (time.Time, error) {
	var s string
	if err := json.Unmarshal(data, &s); err != nil {
		return time.Time{}, err
	}
	return ParseTime(s)
}

func unmarshalOptionalTime(data []byte) (*time.Time, error) {
	if string(data) == "null" {
		return nil, nil
	}
	v, err := unmarshalTime(data)
	if err != nil {
		return nil, err
	}
	return &v, nil
}

func unmarshalRepeat(data []byte) (*Repeat, error) {
	if string(data) == "null" {
		return nil, nil
	}
	var r Repeat
	if err := json.Unmarshal(data, &r); err != nil {
		return nil, err
	}
	return &r, nil
}

func unmarshalReview(data []byte) (*ReviewInterval, error) {
	if string(data) == "null" {
		return nil, nil
	}
	var r ReviewInterval
	if err := json.Unmarshal(data, &r); err != nil {
		return nil, err
	}
	return &r, nil
}
