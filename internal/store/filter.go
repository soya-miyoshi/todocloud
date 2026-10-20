package store

import (
	"strings"

	"github.com/soya-miyoshi/todocloud/internal/recur"
	"github.com/soya-miyoshi/todocloud/internal/task"
)

// MatchesStatic reports whether t satisfies the part of f that can be decided
// from the row alone. A provider is free to express exactly this much in its
// query language — that is why it is separated out — and storetest checks
// that doing so gives the same answer as evaluating it here.
func (f Filter) MatchesStatic(t *task.Task) bool {
	switch {
	case f.OnlyDeleted && !t.Deleted():
		return false
	case !f.OnlyDeleted && !f.IncludeDeleted && t.Deleted():
		return false
	}
	if len(f.Kinds) > 0 && !containsKind(f.Kinds, t.Kind) {
		return false
	}
	if len(f.Statuses) > 0 && !containsStatus(f.Statuses, t.Status) {
		return false
	}
	if f.Flagged != nil && *f.Flagged != t.Flagged {
		return false
	}
	if f.Scope.Inbox && !t.Inbox() {
		return false
	}
	if f.Scope.Children && t.ParentID != f.Scope.ParentID {
		return false
	}
	if !matchTags(f, t) {
		return false
	}
	at := f.At()
	if f.DeferBefore != nil && (t.DeferAt == nil || !t.DeferAt.Before(*f.DeferBefore)) {
		return false
	}
	if f.DeferAfter != nil && (t.DeferAt == nil || !t.DeferAt.After(*f.DeferAfter)) {
		return false
	}
	if f.HasDue != nil && *f.HasDue != (t.DueAt != nil) {
		return false
	}
	if f.DueBefore != nil && (t.DueAt == nil || !t.DueAt.Before(*f.DueBefore)) {
		return false
	}
	if f.DueAfter != nil && (t.DueAt == nil || !t.DueAt.After(*f.DueAfter)) {
		return false
	}
	if f.ReviewDueBefore != nil {
		next, ok := recur.NextReviewAt(t, at)
		if !ok || !next.Before(*f.ReviewDueBefore) {
			return false
		}
	}
	return true
}

// Matches reports whether t satisfies the whole of f. tr may be nil when the
// filter needs no tree, which Filter.NeedsTree reports.
func (f Filter) Matches(t *task.Task, tr *Tree) bool {
	if !f.MatchesStatic(t) {
		return false
	}
	if tr == nil {
		return true
	}
	if f.Scope.Subtree != "" && !tr.HasDescendant(f.Scope.Subtree, t.ID) {
		return false
	}
	if f.Availability == AvailabilityAny {
		return true
	}
	a := tr.Availability(t.ID, f.At())
	switch f.Availability {
	case AvailabilityAvailable:
		return a.Available
	case AvailabilityBlocked:
		return !a.Available
	case AvailabilityDeferred:
		return !a.Available && a.Rule.Deferral()
	}
	return true
}

// NeedsTree reports whether answering f requires the whole tree rather than
// one row at a time. A provider uses it to decide whether it can stream a
// query straight back.
func (f Filter) NeedsTree() bool {
	return f.Availability != AvailabilityAny ||
		f.Scope.Subtree != "" ||
		f.Order == OrderPosition || f.Order == ""
}

func containsKind(kinds []task.Kind, k task.Kind) bool {
	for _, want := range kinds {
		if want == k {
			return true
		}
	}
	return false
}

func containsStatus(statuses []task.Status, s task.Status) bool {
	for _, want := range statuses {
		if want == s {
			return true
		}
	}
	return false
}

// matchTags requires every listed tag by default and any one of them when
// TagsAny is set. Comparison is case-insensitive, because a tag is typed.
func matchTags(f Filter, t *task.Task) bool {
	if len(f.Tags) == 0 {
		return true
	}
	for _, want := range f.Tags {
		have := t.HasTag(strings.TrimSpace(want))
		if f.TagsAny && have {
			return true
		}
		if !f.TagsAny && !have {
			return false
		}
	}
	return !f.TagsAny
}
