package store

import (
	"encoding/json"
	"fmt"
	"sort"
	"time"

	"github.com/soya-miyoshi/todocloud/internal/task"
)

// Rule names the reason an item cannot be worked on. It is part of the --json
// shape: `tdo ls --json` carries available and, when that is false, blocked_by
// naming the rule and the item responsible, so that a caller never has to
// recompute this and an agent can say *why* nothing is actionable.
type Rule string

const (
	// RuleNone is the zero value: nothing is blocking.
	RuleNone Rule = ""
	// RuleNotActionable is a folder. A folder organises; it is never
	// something to do, whatever its status.
	RuleNotActionable Rule = "not_actionable"
	// RuleDeleted is a tombstoned item.
	RuleDeleted Rule = "deleted"
	// RuleStatus is an item that is not active: on hold, done or dropped.
	RuleStatus Rule = "status"
	// RuleDeferred is an item whose own defer date is still in the future.
	RuleDeferred Rule = "deferred"
	// RuleSequential is an item whose parent is sequential and which is not
	// the first of that parent's children still open. BlockedBy names the
	// sibling that is next instead.
	RuleSequential Rule = "sequential"
	// RuleMissingParent is an item whose parent_id names nothing. It cannot
	// happen through this interface, but a database edited by hand or a
	// half-finished sync can produce it, and an orphan is not available:
	// treating it as available would surface items from a subtree the user
	// thinks is on hold.
	RuleMissingParent Rule = "missing_parent"
	// The ancestor rules are the rules above applied to something further up
	// the tree. BlockedBy names that ancestor — the nearest offending one,
	// which is the one the user would act on.
	RuleAncestorDeleted    Rule = "ancestor_deleted"
	RuleAncestorStatus     Rule = "ancestor_status"
	RuleAncestorDeferred   Rule = "ancestor_deferred"
	RuleAncestorSequential Rule = "ancestor_sequential"
)

// Deferral reports whether the rule is a defer date rather than a hold, a
// completion or an ordering. `tdo ls --deferred` asks what is waiting for a
// date, which is a different question from what is stuck.
func (r Rule) Deferral() bool {
	return r == RuleDeferred || r == RuleAncestorDeferred
}

// Availability is the answer §3.3 gives for one item.
type Availability struct {
	// Available is true when every rule passes.
	Available bool
	// Rule is the first rule that failed, RuleNone when none did.
	Rule Rule
	// BlockedBy is the id of the item responsible: the item itself for its
	// own status or defer date, the ancestor for an ancestor rule, the
	// sibling that is next for a sequential one.
	BlockedBy string
}

// MarshalJSON writes the documented shape: a bare true, or false alongside a
// blocked_by object naming the rule and the item.
func (a Availability) MarshalJSON() ([]byte, error) {
	if a.Available {
		return []byte("true"), nil
	}
	return json.Marshal(map[string]any{
		"available": false,
		"rule":      string(a.Rule),
		"task_id":   a.BlockedBy,
	})
}

// available is the answer for an item nothing is blocking.
var available = Availability{Available: true}

func blocked(r Rule, by string) Availability {
	return Availability{Rule: r, BlockedBy: by}
}

// Tree is a whole task list held in memory, indexed for the tree and
// availability questions. It is how §3.1 and §3.3 are computed in one place:
// a provider builds one from the rows it has and asks, rather than writing
// the rules into SQL a second time.
//
// A Tree is a snapshot. It does not see writes made after it was built.
type Tree struct {
	byID     map[string]*task.Task
	children map[string][]*task.Task
}

// NewTree indexes tasks. Tombstoned tasks belong in it: they still occupy a
// place in the tree, and leaving them out would silently promote their
// children to roots.
func NewTree(tasks []*task.Task) *Tree {
	tr := &Tree{
		byID:     make(map[string]*task.Task, len(tasks)),
		children: make(map[string][]*task.Task),
	}
	for _, t := range tasks {
		tr.byID[t.ID] = t
	}
	for _, t := range tasks {
		tr.children[t.ParentID] = append(tr.children[t.ParentID], t)
	}
	for parent := range tr.children {
		sortSiblings(tr.children[parent])
	}
	return tr
}

// sortSiblings is tree order: manual position first, then id, which is
// creation order. Every listing and the sequential rule agree on it, so "the
// next action" means the same thing in a listing as in a block reason.
func sortSiblings(ts []*task.Task) {
	sort.SliceStable(ts, func(i, j int) bool {
		if ts[i].Position != ts[j].Position {
			return ts[i].Position < ts[j].Position
		}
		return ts[i].ID < ts[j].ID
	})
}

// Len reports how many tasks the tree holds.
func (tr *Tree) Len() int { return len(tr.byID) }

// Get returns the task with this id.
func (tr *Tree) Get(id string) (*task.Task, bool) {
	t, ok := tr.byID[id]
	return t, ok
}

// Children returns the direct children of parentID in tree order. An empty
// parentID returns the top level.
func (tr *Tree) Children(parentID string) []*task.Task {
	return append([]*task.Task(nil), tr.children[parentID]...)
}

// Ancestors returns the chain above id, nearest first. It stops at a parent
// that is not in the tree, so a cycle introduced outside this package cannot
// make it loop.
func (tr *Tree) Ancestors(id string) []*task.Task {
	var out []*task.Task
	seen := map[string]bool{id: true}
	t, ok := tr.byID[id]
	for ok && t.ParentID != "" && !seen[t.ParentID] {
		seen[t.ParentID] = true
		t, ok = tr.byID[t.ParentID]
		if !ok {
			break
		}
		out = append(out, t)
	}
	return out
}

// Subtree returns id and everything beneath it, in pre-order: a container is
// followed by its children in tree order. It is what a recursive delete acts
// on, so the order is the order a caller would print.
func (tr *Tree) Subtree(id string) []*task.Task {
	root, ok := tr.byID[id]
	if !ok {
		return nil
	}
	var out []*task.Task
	seen := make(map[string]bool)
	var walk func(t *task.Task)
	walk = func(t *task.Task) {
		if seen[t.ID] {
			return
		}
		seen[t.ID] = true
		out = append(out, t)
		for _, c := range tr.children[t.ID] {
			walk(c)
		}
	}
	walk(root)
	return out
}

// HasDescendant reports whether candidate is id itself or sits beneath it. It
// is the cycle check: moving id under one of its own descendants would cut
// that branch loose from the root.
func (tr *Tree) HasDescendant(id, candidate string) bool {
	if id == candidate {
		return true
	}
	for _, t := range tr.Subtree(id) {
		if t.ID == candidate {
			return true
		}
	}
	return false
}

// Availability answers §3.3 for one id. An unknown id is reported as a
// missing parent rather than as available, because the alternative is
// claiming an item nobody can see is ready to do.
//
// The rules are checked in order of how specific they are, so the reason a
// caller is handed is the one closest to the item: its own state first, then
// its place among its siblings, then the nearest ancestor that is in the way.
func (tr *Tree) Availability(id string, now time.Time) Availability {
	t, ok := tr.byID[id]
	if !ok {
		return blocked(RuleMissingParent, id)
	}
	at := now.UTC()

	if t.Deleted() {
		return blocked(RuleDeleted, t.ID)
	}
	if !t.Actionable() {
		return blocked(RuleNotActionable, t.ID)
	}
	if t.Status != task.StatusActive {
		return blocked(RuleStatus, t.ID)
	}
	if deferredAt(t, at) {
		return blocked(RuleDeferred, t.ID)
	}
	if next, ok := tr.blockingSibling(t); ok {
		return blocked(RuleSequential, next)
	}

	// Ancestors, nearest first. Each one is checked with the same rules;
	// a folder among them is not a block, because organising a project into
	// a folder must not make its actions disappear.
	for _, a := range tr.Ancestors(t.ID) {
		switch {
		case a.Deleted():
			return blocked(RuleAncestorDeleted, a.ID)
		case a.Status != task.StatusActive:
			return blocked(RuleAncestorStatus, a.ID)
		case deferredAt(a, at):
			return blocked(RuleAncestorDeferred, a.ID)
		}
		if _, ok := tr.blockingSibling(a); ok {
			// §3.3 rule 4 speaks of the item's own parent, but the rule is
			// transitive in practice: the second action group of a
			// sequential project has not come up yet, so neither has
			// anything inside it. Reporting the ancestor is what lets a
			// caller explain the hold.
			return blocked(RuleAncestorSequential, a.ID)
		}
	}

	// An item whose parent_id names nothing is an orphan; Ancestors stops
	// silently at one, so it is checked here rather than in the loop.
	if t.ParentID != "" {
		if _, ok := tr.byID[t.ParentID]; !ok {
			return blocked(RuleMissingParent, t.ParentID)
		}
	}
	return available
}

// deferredAt reports whether t is held back by its own defer date. The
// comparison is strict: a defer date exactly now has arrived.
func deferredAt(t *task.Task, now time.Time) bool {
	return t.DeferAt != nil && t.DeferAt.After(now)
}

// blockingSibling reports the child that is next in a sequential parent when
// t is not it. Closed and tombstoned siblings are skipped: a sequential list
// moves on as its items are finished or dropped, and a deleted item must not
// stop the list forever.
func (tr *Tree) blockingSibling(t *task.Task) (string, bool) {
	if t.ParentID == "" {
		return "", false
	}
	parent, ok := tr.byID[t.ParentID]
	if !ok || !parent.Sequential {
		return "", false
	}
	for _, c := range tr.children[parent.ID] {
		if c.Deleted() || c.Status.Closed() {
			continue
		}
		if c.ID == t.ID {
			return "", false
		}
		return c.ID, true
	}
	return "", false
}

// AvailabilityOf answers §3.3 for several ids at once over one tree. It is
// the shape the Store method returns.
func (tr *Tree) AvailabilityOf(now time.Time, ids ...string) map[string]Availability {
	out := make(map[string]Availability, len(ids))
	for _, id := range ids {
		if _, ok := tr.byID[id]; !ok {
			continue
		}
		out[id] = tr.Availability(id, now)
	}
	return out
}

// Path returns the ids from the root down to id, id last. It is what a
// listing sorted in tree order compares.
func (tr *Tree) Path(id string) []string {
	ancestors := tr.Ancestors(id)
	out := make([]string, 0, len(ancestors)+1)
	for i := len(ancestors) - 1; i >= 0; i-- {
		out = append(out, ancestors[i].ID)
	}
	return append(out, id)
}

// CheckParent enforces the containment table of §3.1 for a child of kind
// child placed under parent, which is nil for the top level. Every provider
// calls it rather than writing the table out again.
func CheckParent(child task.Kind, parent *task.Task) error {
	if parent == nil {
		// A folder, a project or a loose task may all sit at the top level;
		// for a task that is the inbox.
		return nil
	}
	if !parent.Kind.CanContain(child) {
		return parentError(child, parent)
	}
	return nil
}

// parentError explains a refused placement in the terms the user typed it in,
// and wraps ErrBadParent so the command layer can still map it to exit 2.
func parentError(child task.Kind, parent *task.Task) error {
	return fmt.Errorf("a %s cannot go inside a %s (%s): %w", child, parent.Kind, parent.ID, ErrBadParent)
}

// CycleError explains a refused move. The two ids are the item and the parent
// it was being moved under, which is the whole of what went wrong.
func CycleError(id, parentID string) error {
	if id == parentID {
		return fmt.Errorf("%s cannot be its own parent: %w", id, ErrCycle)
	}
	return fmt.Errorf("%s is inside %s, so it cannot also contain it: %w", parentID, id, ErrCycle)
}

// SortKey returns the tree-order key of a task: one component per level from
// the root down, each one the sibling's position followed by its id. Comparing
// two keys component by component puts a container before its children and
// siblings in the order the user arranged them.
//
// The position is rendered zero-padded and offset past zero so that a
// negative position — which a user can set, and which means "before
// everything" — still compares as text in numeric order.
func (tr *Tree) SortKey(t *task.Task) []string {
	path := tr.Path(t.ID)
	out := make([]string, 0, len(path))
	for _, step := range path {
		node, ok := tr.byID[step]
		if !ok {
			out = append(out, step)
			continue
		}
		out = append(out, fmt.Sprintf("%020d|%s", int64(node.Position)+positionOffset, node.ID))
	}
	return out
}

// positionOffset keeps the padded position non-negative. It is half of what
// an int64 can hold, so no position a user could set reaches past it.
const positionOffset = int64(1) << 62
