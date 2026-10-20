package store

import (
	"context"
	"time"

	"github.com/soya-miyoshi/todocloud/internal/task"
)

// This file holds the "complete with last action" rule of PLAN.md §3.2's
// completed_by_children field, OmniFocus's rule of the same name: when the
// last child of such a container is finished, the container is finished too.
//
// It lives beside availability.go and for the same reason: it is a rule about
// the tree, not about one provider's SQL, so it is written once as a pure
// function over a Tree and every provider calls it. A provider that computed
// it itself could drift, and storetest holds both of them to this definition.
//
// The decisions the rule makes, and why:
//
//   - What counts as "last". A child is still open when it is not deleted and
//     its status is not done or dropped. Dropped and tombstoned children are
//     skipped, exactly as §3.3's sequential rule skips them when it picks the
//     next sibling — deciding against an action finishes it as surely as doing
//     it does, and a tombstone must not stall a container forever any more
//     than it may stall a sequence. A child that is itself a container is an
//     ordinary child: it is open until its own status closes, which is what
//     makes the cascade below meaningful rather than circular.
//
//   - A container with no live children at all is never auto-completed.
//     Completing nothing is not completing something: an empty project with
//     the flag set would otherwise complete the moment it was created, and
//     emptying a container by tombstoning its children would read as having
//     done the work. The rule needs at least one child that was finished.
//
//   - A folder is never auto-completed. §3.1 says a folder is organisation and
//     is never completed, and task.Validate refuses a done folder outright.
//
//   - A container that already carries a repeat is not auto-completed, and the
//     cascade stops there. §3.4 is a hard rule: a new instance is created only
//     as the direct result of an explicit `tdo done`. Completing a repeating
//     container here would either silently kill its series — the successor
//     that the explicit path would have created never appears — or make the
//     store manufacture a row while someone was only finishing a child.
//     Neither is acceptable, so the container is left for the user to finish
//     with `tdo done`, which does roll the series over and says so.
//
//   - A container that is already done or dropped is left alone, and so is a
//     tombstoned one. A container that is on hold is completed: the work it
//     held is finished, and leaving it on hold would keep a container nobody
//     can act on in the tree forever.
//
//   - The rule only ever closes things. Reopening a child with `tdo undone`
//     does not reopen the container; see TriggersAutoCompletion.

// TriggersAutoCompletion reports whether a write of t can set the rule off.
// Only a write that closes or tombstones an item can make its parent's last
// child the last one, so a provider can skip reading the tree for every other
// write.
//
// Reopening is deliberately not a trigger, and this is the one asymmetry in
// the rule. Nothing records whether a container was completed by this rule or
// by the user, so an automatic reopen would have to guess, and guessing wrong
// resurrects a project the user finished on purpose. Closing is monotone and
// terminates; reopening would have to walk up undoing decisions it cannot
// distinguish from the user's. `tdo undone <container>` is one command, and it
// is the user saying which of the two they meant.
func TriggersAutoCompletion(t *task.Task) bool {
	return t != nil && (t.Deleted() || t.Status.Closed())
}

// AutoComplete returns the containers above changedID that the rule completes,
// nearest ancestor first, as clones with their status and timestamps already
// set. The tree must be the state after the write that closed changedID.
//
// The walk is upward and cascading: a container that completes may itself be
// the last open child of its own parent. It terminates because Tree.Ancestors
// is finite and refuses to revisit an id, so a parent edge cycle introduced
// outside this package stops the walk instead of looping it.
//
// Nothing here creates a row. The result is a set of existing containers to
// update, which is what keeps §3.4's guarantee — that only an explicit
// `tdo done` ever generates an instance — true of this rule as well.
func AutoComplete(tr *Tree, changedID string, now time.Time) []*task.Task {
	at := now.UTC()
	var out []*task.Task
	// closed carries the decision down the walk: a container this pass has
	// just completed counts as closed when its own parent is considered.
	closed := make(map[string]bool)
	for _, ancestor := range tr.Ancestors(changedID) {
		if !tr.completesWithLastChild(ancestor, closed) {
			// The first ancestor that does not complete ends the cascade:
			// everything above it still has an open child, namely this one.
			break
		}
		done := ancestor.Clone()
		done.SetStatus(task.StatusDone, at)
		out = append(out, done)
		closed[ancestor.ID] = true
	}
	return out
}

// completesWithLastChild answers the rule for one container. closed names the
// ids this pass has already decided to complete.
func (tr *Tree) completesWithLastChild(container *task.Task, closed map[string]bool) bool {
	switch {
	case !container.CompletedByChildren:
		return false
	case container.Kind == task.KindFolder:
		return false
	case container.Deleted() || container.Status.Closed():
		return false
	case container.Repeat != nil:
		return false
	}
	live := 0
	for _, child := range tr.children[container.ID] {
		if child.Deleted() {
			continue
		}
		live++
		if !child.Status.Closed() && !closed[child.ID] {
			return false
		}
	}
	return live > 0
}

// All returns every task the tree holds, in no particular order. It is how a
// provider with no transaction projects the state a write is about to produce:
// rebuild a tree from these with the written row swapped in, and the shared
// rules can be asked about the result before it is sent.
func (tr *Tree) All() []*task.Task {
	out := make([]*task.Task, 0, len(tr.byID))
	for _, t := range tr.byID {
		out = append(out, t)
	}
	return out
}

// WithUpdated returns a tree holding the same tasks with t in place of the one
// of the same id, which is the state a pending update would leave behind.
func (tr *Tree) WithUpdated(t *task.Task) *Tree {
	all := tr.All()
	replaced := false
	for i, have := range all {
		if have.ID == t.ID {
			all[i] = t
			replaced = true
			break
		}
	}
	if !replaced {
		all = append(all, t)
	}
	return NewTree(all)
}

// PendingAutoCompletions reports the containers that writing t would complete
// under the rule of PLAN.md §3.3a, without writing anything.
//
// It exists so the command layer can tell the user what a write did, rather
// than only that it succeeded: a project quietly disappearing from `tdo ls`
// because its last action closed is exactly the kind of thing a tool must say
// out loud. It answers from the same Tree and the same AutoComplete the
// providers use, so the prediction and the write agree by construction rather
// than by two pieces of code being kept in step.
//
// The answer is a snapshot like any other read, so a concurrent writer can
// still make it stale between the prediction and the write. That is the same
// window every read-then-write in this tool has, and the consequence here is
// a line of output, not a wrong row.
func PendingAutoCompletions(ctx context.Context, s Store, t *task.Task, now time.Time) ([]*task.Task, error) {
	if !TriggersAutoCompletion(t) {
		return nil, nil
	}
	all, err := s.List(ctx, Filter{IncludeDeleted: true})
	if err != nil {
		return nil, err
	}
	return AutoComplete(NewTree(all).WithUpdated(t), t.ID, now), nil
}
