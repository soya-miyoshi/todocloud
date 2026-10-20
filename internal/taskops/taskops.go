// Package taskops is the logic layer every front end shares.
//
// It holds the writes that are more than one store call — completing a
// repeating item, moving an item, tombstoning a subtree — and the listing
// pipeline that applies the filters no provider can push down. The command
// layer parses flags and renders output; `tdo serve` parses JSON and renders
// JSON; both reach the store only through this package, so the two cannot
// drift into disagreeing about what "done" means.
//
// Nothing here touches urfave/cli, the process streams or the exit codes. An
// operation returns the store's own sentinel errors (store.ErrBadParent,
// store.ErrNotFound, …) and the caller maps them onto whatever its front end
// reports: an exit code for the CLI, a status code for the server.
package taskops

import (
	"context"
	"fmt"
	"time"

	"github.com/soya-miyoshi/todocloud/internal/recur"
	"github.com/soya-miyoshi/todocloud/internal/store"
	"github.com/soya-miyoshi/todocloud/internal/task"
)

// Result is what a write changed. Tasks holds the items the caller named, in
// the order they were given; the other two fields are the rows an operation
// touched that nobody typed, and they are never silent — the CLI prints them
// on stderr and the server returns them in its payload.
type Result struct {
	// Tasks are the items the operation acted on, as they now stand.
	Tasks []*task.Task
	// Successors are the next instances created for repeating items (§3.4).
	Successors []*task.Task
	// AutoCompleted are the containers that closed because their last child
	// did (§3.3a).
	AutoCompleted []*task.Task
}

// IDGen supplies the id of a row the operation creates. It is a parameter
// rather than a call to id.New so that a test can pin the ids a repeat
// generates.
type IDGen func() string

// Complete completes each task, creating the successor of a repeating one
// unless noRepeat says otherwise.
func Complete(ctx context.Context, st store.Store, tasks []*task.Task, now time.Time, noRepeat bool, newID IDGen) (*Result, error) {
	res := &Result{}
	var auto completions
	for _, found := range tasks {
		t := found.Clone()
		var next *task.Task
		if noRepeat {
			// The one way to end a repeating item without a successor,
			// short of `tdo repeat --stop`.
			t.SetStatus(task.StatusDone, now)
		} else {
			// This is the only call that creates a row nobody typed, and it
			// is reached only from here (§3.4).
			var err error
			next, err = recur.Complete(t, now, newID())
			if err != nil {
				return nil, err
			}
		}
		// The successor goes in BEFORE the instance is completed, and the
		// order is load-bearing. Completing the instance may be the last
		// action of a complete-with-last container (PLAN.md §3.3a), and the
		// store closes that container as part of the same Update. Adding the
		// successor afterwards would file it under a container that is
		// already done; adding it first makes it the live sibling that
		// correctly prevents the auto-completion. It also fails more safely:
		// if Add fails, the instance is still open.
		if next != nil {
			if err := st.Add(ctx, next); err != nil {
				return nil, err
			}
			res.Successors = append(res.Successors, next)
		}
		if err := auto.collect(ctx, st, t, now); err != nil {
			return nil, err
		}
		if err := st.Update(ctx, t); err != nil {
			return nil, err
		}
		res.Tasks = append(res.Tasks, t)
	}
	res.AutoCompleted = auto.tasks
	return res, nil
}

// SetStatus moves each task to status. It is the body of `tdo undone`,
// `drop`, `hold` and `unhold`, which differ by one value only.
func SetStatus(ctx context.Context, st store.Store, tasks []*task.Task, status task.Status, now time.Time) (*Result, error) {
	return update(ctx, st, tasks, now, true, func(t *task.Task) error {
		t.SetStatus(status, now)
		return nil
	})
}

// SetFlagged flags or unflags each task.
func SetFlagged(ctx context.Context, st store.Store, tasks []*task.Task, flagged bool, now time.Time) (*Result, error) {
	return update(ctx, st, tasks, now, false, func(t *task.Task) error {
		t.Flagged = flagged
		return nil
	})
}

// DateField names which of the two dates a write sets.
type DateField string

const (
	// DeferDate is the date before which an item is not available.
	DeferDate DateField = "defer"
	// DueDate is the date an item is due.
	DueDate DateField = "due"
)

// SetDate writes one of the two dates on each task; a nil at clears it.
func SetDate(ctx context.Context, st store.Store, tasks []*task.Task, field DateField, at *time.Time, now time.Time) (*Result, error) {
	return update(ctx, st, tasks, now, false, func(t *task.Task) error {
		if field == DeferDate {
			t.DeferAt = at
		} else {
			t.DueAt = at
		}
		return nil
	})
}

// Apply writes an edit to each task. The edit is validated against a copy,
// so a rejected edit changes nothing.
func Apply(ctx context.Context, st store.Store, tasks []*task.Task, e Edit, now time.Time) (*Result, error) {
	return update(ctx, st, tasks, now, false, func(t *task.Task) error {
		return e.apply(t)
	})
}

// update clones each task, applies fn, predicts the containers the write
// closes when the change can close one, and stores it. Editing a copy is
// what keeps a validation failure from leaving a half-applied change behind.
func update(ctx context.Context, st store.Store, tasks []*task.Task, now time.Time, mayComplete bool, fn func(*task.Task) error) (*Result, error) {
	res := &Result{}
	var auto completions
	for _, found := range tasks {
		t := found.Clone()
		if err := fn(t); err != nil {
			return nil, err
		}
		t.UpdatedAt = now
		if err := t.Validate(); err != nil {
			return nil, fmt.Errorf("%w: %s", ErrInvalid, err)
		}
		if mayComplete {
			if err := auto.collect(ctx, st, t, now); err != nil {
				return nil, err
			}
		}
		if err := st.Update(ctx, t); err != nil {
			return nil, err
		}
		res.Tasks = append(res.Tasks, t)
	}
	res.AutoCompleted = auto.tasks
	return res, nil
}

// Create stores a new item. It is one store call, and it is here so that a
// caller never has to know that the tree rules live in Add.
func Create(ctx context.Context, st store.Store, t *task.Task) error {
	return st.Add(ctx, t)
}

// MoveTo reparents each task, keeping its position. An empty parentID means
// the top level, which for a task is the inbox.
func MoveTo(ctx context.Context, st store.Store, tasks []*task.Task, parentID string, now time.Time) (*Result, error) {
	res := &Result{}
	for _, t := range tasks {
		if err := st.Move(ctx, t.ID, parentID, t.Position, now); err != nil {
			return nil, err
		}
		after, err := st.Get(ctx, t.ID)
		if err != nil {
			return nil, err
		}
		res.Tasks = append(res.Tasks, after)
	}
	return res, nil
}

// Tombstone is the ordinary removal: the item stays in the store with a
// deleted_at stamp, so that a second device can learn about the deletion
// instead of silently resurrecting it.
//
// Removing a container takes its subtree with it. Leaving the children behind
// would make them orphans, which §3.3 refuses to call available — so they
// would vanish from every listing while still being there.
func Tombstone(ctx context.Context, st store.Store, tasks []*task.Task, now time.Time) (*Result, error) {
	res := &Result{}
	seen := make(map[string]bool, len(tasks))
	var auto completions
	for _, found := range tasks {
		subtree, err := st.Subtree(ctx, found.ID)
		if err != nil {
			return nil, err
		}
		for _, node := range subtree {
			if seen[node.ID] {
				continue
			}
			seen[node.ID] = true
			t := node.Clone()
			if t.DeletedAt == nil {
				deleted := now
				t.DeletedAt = &deleted
				t.UpdatedAt = now
				// Only the item the user named can complete something that
				// survives this command: everything else in the subtree is
				// being tombstoned alongside it, and its own ancestors are
				// inside the subtree. Predicting for every node would also
				// read the whole store once per node.
				if node.ID == found.ID {
					if err := auto.collect(ctx, st, t, now); err != nil {
						return nil, err
					}
				}
				if err := st.Update(ctx, t); err != nil {
					return nil, err
				}
			}
			res.Tasks = append(res.Tasks, t)
		}
	}
	res.AutoCompleted = auto.tasks
	return res, nil
}

// AvailabilityOf asks the store for §3.3 over these tasks. It is the one
// place a front end learns why something is blocked: the rules are computed
// in the store so that every provider and every command agree.
func AvailabilityOf(ctx context.Context, st store.Store, tasks []*task.Task, now time.Time) (map[string]store.Availability, error) {
	if len(tasks) == 0 {
		return map[string]store.Availability{}, nil
	}
	ids := make([]string, 0, len(tasks))
	for _, t := range tasks {
		ids = append(ids, t.ID)
	}
	return st.Availability(ctx, now, ids...)
}

// completions collects the containers that writing t will complete under
// PLAN.md §3.3a. It is called immediately before the write, because the rule
// reads the tree as it will be afterwards, and it uses the same shared
// function the providers do, so what is reported and what is written cannot
// drift apart.
//
// A container appears once however many of its children closed in the same
// operation: `tdo done a b` where a and b are the last two actions of one
// project completes that project once.
type completions struct {
	seen  map[string]bool
	tasks []*task.Task
}

func (c *completions) collect(ctx context.Context, st store.Store, t *task.Task, now time.Time) error {
	containers, err := store.PendingAutoCompletions(ctx, st, t, now)
	if err != nil {
		return err
	}
	if c.seen == nil {
		c.seen = map[string]bool{}
	}
	for _, container := range containers {
		if c.seen[container.ID] {
			continue
		}
		c.seen[container.ID] = true
		c.tasks = append(c.tasks, container)
	}
	return nil
}

// Placement says where Reorder puts the items it moves, relative to an
// anchor among its new siblings.
type Placement int

const (
	// Before puts the items immediately ahead of the anchor.
	Before Placement = iota
	// After puts them immediately behind it.
	After
)

// Reorder moves tasks so they sit immediately before or after anchor, among
// anchor's siblings.
//
// Order is not decoration in a sequential project: the position of a child
// *is* the order its actions become available (§3.3), so "do the scan last"
// was until now expressed by deleting the action and adding it again. The
// positions of the whole sibling group are rewritten in one pass, because
// they are a manual order with no gaps guaranteed — two siblings may share a
// position, and ties break by id, so inserting "between" them is only
// meaningful once they have been renumbered.
//
// Moving an item next to an anchor in another container moves it into that
// container too: that is what "put it after this one" means when the anchor
// lives somewhere else, and it keeps `tdo mv --after` from being a second,
// subtly different kind of move.
func Reorder(ctx context.Context, st store.Store, tasks []*task.Task, anchor *task.Task, where Placement, now time.Time) (*Result, error) {
	if len(tasks) == 0 {
		return nil, invalidf("expected at least one item to move")
	}
	moving := make(map[string]bool, len(tasks))
	for _, t := range tasks {
		if t.ID == anchor.ID {
			return nil, invalidf("%q cannot be placed relative to itself", anchor.Title)
		}
		moving[t.ID] = true
	}

	// The anchor's siblings in the order they are in now, which is the order
	// a listing printed and the user is reading.
	siblings, err := st.Children(ctx, anchor.ParentID)
	if err != nil {
		return nil, err
	}
	order := make([]*task.Task, 0, len(siblings)+len(tasks))
	for _, sibling := range siblings {
		if moving[sibling.ID] {
			// An item already in this group is being moved within it, so it
			// is dropped here and put back at its new place below.
			continue
		}
		if sibling.ID == anchor.ID && where == Before {
			order = append(order, tasks...)
		}
		order = append(order, sibling)
		if sibling.ID == anchor.ID && where == After {
			order = append(order, tasks...)
		}
	}

	res := &Result{}
	for position, t := range order {
		if !moving[t.ID] && t.Position == position && t.ParentID == anchor.ParentID {
			// Renumbering is a write per sibling, so the ones already in
			// place are left alone: a reorder in a long project must not
			// touch every row's updated_at.
			continue
		}
		if err := st.Move(ctx, t.ID, anchor.ParentID, position, now); err != nil {
			return nil, err
		}
	}
	// The items the caller named, in the order they were given, read back
	// even when none of them had to move.
	for _, t := range tasks {
		after, err := st.Get(ctx, t.ID)
		if err != nil {
			return nil, err
		}
		res.Tasks = append(res.Tasks, after)
	}
	return res, nil
}
