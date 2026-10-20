package storetest

import (
	"testing"
	"time"

	"github.com/soya-miyoshi/todocloud/internal/store"
	"github.com/soya-miyoshi/todocloud/internal/task"
)

// withLastChild marks a container as "complete with last action" — the
// completed_by_children field of PLAN.md §3.2.
func withLastChild(t *task.Task) { t.CompletedByChildren = true }

// closeIt returns a mutator that closes a stored task at when, the way
// `tdo done` and `tdo drop` do.
func (f *fixture) close(t *task.Task, status task.Status, when time.Time) {
	f.t.Helper()
	stored := f.get(t.ID)
	stored.SetStatus(status, when)
	f.update(stored)
}

// requireStatus fails naming the rule, not just the values.
func (f *fixture) requireStatus(rule, taskID string, want task.Status) {
	f.t.Helper()
	if got := f.get(taskID).Status; got != want {
		f.t.Fatalf("%s\n  %s is %q, expected %q", rule, taskID, got, want)
	}
}

// testCompletedByChildren is the "complete with last action" rule: when the
// last child of a container whose completed_by_children is set is finished,
// the container is finished too. It is shared domain logic
// (store.AutoComplete), so both providers must behave identically.
func testCompletedByChildren(t *testing.T, f *fixture) {
	later := f.now.Add(time.Hour)

	t.Run("the last child completing completes its container", func(t *testing.T) {
		f := f.with(t)
		project := f.add(task.KindProject, "tidy the garage", withLastChild)
		first := f.add(task.KindTask, "empty the shelves", under(project), at(1))
		second := f.add(task.KindTask, "sweep", under(project), at(2))

		f.close(first, task.StatusDone, later)
		f.requireStatus("a container whose completed_by_children is set must not complete while a child is still open", project.ID, task.StatusActive)

		f.close(second, task.StatusDone, later)
		f.requireStatus("completing the last child of a completed_by_children container must complete the container", project.ID, task.StatusDone)

		done := f.get(project.ID)
		if done.CompletedAt == nil || !done.CompletedAt.Equal(later.UTC()) {
			t.Fatalf("a container completed by its last child must record when it happened, which is the moment of that completion\n  completed_at is %v, expected %v", done.CompletedAt, later.UTC())
		}
	})

	t.Run("a container without the flag is never completed by its children", func(t *testing.T) {
		f := f.with(t)
		project := f.add(task.KindProject, "ordinary project")
		only := f.add(task.KindTask, "the only action", under(project))

		f.close(only, task.StatusDone, later)
		f.requireStatus("completed_by_children is opt-in: a container without it stays open when its last child is done", project.ID, task.StatusActive)
	})

	t.Run("a dropped child counts as finished, exactly as the sequential rule treats it", func(t *testing.T) {
		f := f.with(t)
		project := f.add(task.KindProject, "half abandoned", withLastChild)
		kept := f.add(task.KindTask, "the one I did", under(project), at(1))
		abandoned := f.add(task.KindTask, "the one I decided against", under(project), at(2))

		f.close(kept, task.StatusDone, later)
		f.close(abandoned, task.StatusDropped, later)
		f.requireStatus("dropping a child finishes it as surely as doing it, so the last child dropped must complete the container (PLAN.md §3.3 rule 4 skips dropped siblings for the same reason)", project.ID, task.StatusDone)
	})

	t.Run("a tombstoned child is skipped rather than waited for", func(t *testing.T) {
		f := f.with(t)
		project := f.add(task.KindProject, "with a deleted action", withLastChild)
		live := f.add(task.KindTask, "the live action", under(project), at(1))
		removed := f.add(task.KindTask, "the removed action", under(project), at(2))

		stored := f.get(removed.ID)
		stored.DeletedAt = &later
		f.update(stored)
		f.requireStatus("a tombstone is not a completion: removing an open child must not by itself complete the container", project.ID, task.StatusActive)

		f.close(live, task.StatusDone, later)
		f.requireStatus("a tombstoned child must be skipped, not waited for, so that a tombstone cannot stall a container forever (PLAN.md §3.3 rule 4 skips deleted siblings)", project.ID, task.StatusDone)
	})

	t.Run("a container left with no children at all is not completed", func(t *testing.T) {
		f := f.with(t)
		project := f.add(task.KindProject, "emptied, not finished", withLastChild)
		only := f.add(task.KindTask, "the only action", under(project))

		stored := f.get(only.ID)
		stored.DeletedAt = &later
		f.update(stored)
		f.requireStatus("completing nothing is not completing something: a container with no live children left must stay open", project.ID, task.StatusActive)
	})

	t.Run("the rule walks up through every container that asks for it", func(t *testing.T) {
		f := f.with(t)
		folder := f.add(task.KindFolder, "a folder that asks too", withLastChild)
		project := f.add(task.KindProject, "the outcome", under(folder), withLastChild)
		outer := f.add(task.KindTask, "the outer group", under(project), withLastChild)
		inner := f.add(task.KindTask, "the inner group", under(outer), withLastChild)
		leaf := f.add(task.KindTask, "the only action", under(inner))

		f.close(leaf, task.StatusDone, later)
		for _, container := range []*task.Task{inner, outer, project} {
			f.requireStatus("the rule cascades: a container that completes may itself be the last child of its parent, so the whole chain above the last action must complete", container.ID, task.StatusDone)
		}
		f.requireStatus("a folder is organisation and is never completed (PLAN.md §3.1), whatever completed_by_children says", folder.ID, task.StatusActive)
	})

	t.Run("the cascade stops at a container that still has an open child", func(t *testing.T) {
		f := f.with(t)
		outer := f.add(task.KindProject, "the outcome", withLastChild)
		group := f.add(task.KindTask, "the group", under(outer), withLastChild, at(1))
		sibling := f.add(task.KindTask, "the unrelated action", under(outer), at(2))
		leaf := f.add(task.KindTask, "the action in the group", under(group))

		f.close(leaf, task.StatusDone, later)
		f.requireStatus("the group's last child completed, so the group completes", group.ID, task.StatusDone)
		f.requireStatus("the cascade must stop at the first container that still has an open child", outer.ID, task.StatusActive)

		f.close(sibling, task.StatusDone, later)
		f.requireStatus("a container that is itself a container counts as an ordinary child: once both are closed the parent completes", outer.ID, task.StatusDone)
	})

	t.Run("a repeating container is left for an explicit done", func(t *testing.T) {
		f := f.with(t)
		folder := f.add(task.KindFolder, "routines")
		weekly := f.add(task.KindProject, "the weekly review", under(folder), withLastChild, func(t *task.Task) {
			t.Repeat = &task.Repeat{Method: task.RepeatFromCompletion, Every: "1w"}
			t.SeriesID = "series"
		})
		step := f.add(task.KindTask, "the only step", under(weekly))

		before := len(f.list(store.Filter{IncludeDeleted: true}))
		f.close(step, task.StatusDone, later)
		f.requireStatus("a repeating container must not be auto-completed: PLAN.md §3.4 says an instance is created only as the direct result of an explicit `tdo done`, and completing the container here would either kill the series or manufacture a row", weekly.ID, task.StatusActive)
		if after := len(f.list(store.Filter{IncludeDeleted: true})); after != before {
			t.Fatalf("this rule never creates a row (PLAN.md §3.4)\n  the store held %d task(s) and now holds %d", before, after)
		}
	})

	t.Run("an auto-completed container never generates a successor", func(t *testing.T) {
		f := f.with(t)
		project := f.add(task.KindProject, "no rows from here", withLastChild)
		only := f.add(task.KindTask, "the repeating action", under(project), func(t *task.Task) {
			t.Repeat = &task.Repeat{Method: task.RepeatFixed, Every: "1d"}
		})

		before := len(f.list(store.Filter{IncludeDeleted: true}))
		f.close(only, task.StatusDone, later)
		f.requireStatus("a repeating child is an ordinary child: closing it completes its container", project.ID, task.StatusDone)
		if after := len(f.list(store.Filter{IncludeDeleted: true})); after != before {
			t.Fatalf("nothing but an explicit `tdo done` generates a row (PLAN.md §3.4), and the store generates none at all\n  the store held %d task(s) and now holds %d", before, after)
		}
	})

	t.Run("reopening a child does not reopen the container", func(t *testing.T) {
		f := f.with(t)
		project := f.add(task.KindProject, "reopened", withLastChild)
		only := f.add(task.KindTask, "the only action", under(project))

		f.close(only, task.StatusDone, later)
		f.requireStatus("the last child completing completes the container", project.ID, task.StatusDone)

		stored := f.get(only.ID)
		stored.SetStatus(task.StatusActive, later.Add(time.Hour))
		f.update(stored)
		f.requireStatus("the rule only ever closes: nothing records whether a container was completed by the rule or by the user, so `tdo undone` on a child must not reopen the container — the user reopens it themselves", project.ID, task.StatusDone)
	})

	t.Run("a container that is already closed is left exactly as it is", func(t *testing.T) {
		f := f.with(t)
		dropped := f.add(task.KindProject, "abandoned outcome", withLastChild, func(t *task.Task) {
			t.Status = task.StatusDropped
			t.DroppedAt = &f.now
		})
		leftover := f.add(task.KindTask, "an action nobody removed", under(dropped))

		f.close(leftover, task.StatusDone, later)
		f.requireStatus("a container that is already done or dropped is not revisited: the rule must not turn a dropped outcome into a completed one", dropped.ID, task.StatusDropped)
	})

	t.Run("a container on hold is completed when its work is", func(t *testing.T) {
		f := f.with(t)
		project := f.add(task.KindProject, "paused outcome", withLastChild, func(t *task.Task) {
			t.Status = task.StatusOnHold
		})
		only := f.add(task.KindTask, "the only action", under(project))

		f.close(only, task.StatusDone, later)
		f.requireStatus("the work a held container held is finished, and leaving it on hold would keep a container nobody can act on in the tree forever", project.ID, task.StatusDone)
	})
}
