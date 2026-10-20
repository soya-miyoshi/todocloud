package storetest

import (
	"testing"
	"time"

	"github.com/soya-miyoshi/todocloud/internal/id"
	"github.com/soya-miyoshi/todocloud/internal/store"
	"github.com/soya-miyoshi/todocloud/internal/task"
)

func testFreshStore(t *testing.T, f *fixture) {
	if got := f.list(store.Filter{}); len(got) != 0 {
		t.Fatalf("a store that was just created must hold nothing\n  it holds %v", titles(got))
	}
	version, err := f.s.SchemaVersion(f.ctx)
	requireNoError(t, "SchemaVersion must report a version once Init has run", err)
	if version < 1 {
		t.Fatalf("SchemaVersion must be at least 1 after Init, got %d", version)
	}
	requireNoError(t, "Init must be idempotent, so a second call must succeed", f.s.Init(f.ctx))
	requireNoError(t, "Ping must succeed on an initialized store", f.s.Ping(f.ctx))
	requireNoError(t, "Migrate on a store at the current version must do nothing and succeed",
		f.s.Migrate(f.ctx))
	if f.s.Describe() == "" {
		t.Fatal("Describe must say where the tasks are, credential-free, and must not be empty")
	}
}

// testContainment walks the whole table of PLAN.md §3.1: a folder holds
// folders and projects, a project holds tasks, a task holds tasks, and
// anything at the top level is allowed.
func testContainment(t *testing.T, f *fixture) {
	parents := map[task.Kind]*task.Task{
		task.KindFolder:  f.add(task.KindFolder, "folder"),
		task.KindProject: nil,
		task.KindTask:    nil,
	}
	parents[task.KindProject] = f.add(task.KindProject, "project", under(parents[task.KindFolder]))
	parents[task.KindTask] = f.add(task.KindTask, "action", under(parents[task.KindProject]))

	cases := []struct {
		parent task.Kind
		child  task.Kind
		allow  bool
	}{
		{task.KindFolder, task.KindFolder, true},
		{task.KindFolder, task.KindProject, true},
		{task.KindFolder, task.KindTask, false},
		{task.KindProject, task.KindFolder, false},
		{task.KindProject, task.KindProject, false},
		{task.KindProject, task.KindTask, true},
		{task.KindTask, task.KindFolder, false},
		{task.KindTask, task.KindProject, false},
		{task.KindTask, task.KindTask, true},
	}
	for _, c := range cases {
		child := task.New(id.New(), c.child, string(c.child)+" in "+string(c.parent), f.now)
		child.ParentID = parents[c.parent].ID
		err := f.s.Add(f.ctx, child)
		switch {
		case c.allow && err != nil:
			t.Fatalf("PLAN.md §3.1 allows a %s inside a %s, so Add must accept it\n  it failed: %v",
				c.child, c.parent, err)
		case !c.allow && err == nil:
			t.Fatalf("PLAN.md §3.1 does not allow a %s inside a %s, so Add must refuse it with ErrBadParent\n  it was accepted",
				c.child, c.parent)
		case !c.allow:
			requireIs(t, "an illegal containment must be reported as ErrBadParent, which the command layer maps to exit 2", err, store.ErrBadParent)
		}
	}

	for _, kind := range task.Kinds() {
		top := task.New(id.New(), kind, "top-level "+string(kind), f.now)
		requireNoError(t, "any kind may sit at the top level, so Add must accept a "+string(kind)+" with no parent",
			f.s.Add(f.ctx, top))
	}

	// The same table governs a move, not only a creation.
	action := parents[task.KindTask]
	err := f.s.Move(f.ctx, action.ID, parents[task.KindFolder].ID, 0, f.now)
	requireIs(t, "Move must enforce the containment table too: a task cannot be moved directly into a folder", err, store.ErrBadParent)

	// And an unknown parent is a missing reference, not a bad one.
	orphan := task.New(id.New(), task.KindTask, "orphan", f.now)
	orphan.ParentID = id.New()
	requireIs(t, "Add must refuse a parent that does not exist, since the alternative is an item no listing can reach",
		f.s.Add(f.ctx, orphan), store.ErrNotFound)
}

func testCycles(t *testing.T, f *fixture) {
	root := f.add(task.KindFolder, "root")
	mid := f.add(task.KindFolder, "mid", under(root))
	leaf := f.add(task.KindFolder, "leaf", under(mid))

	requireIs(t, "an item made its own parent is a cycle and must be refused (PLAN.md §3.1)",
		f.s.Move(f.ctx, root.ID, root.ID, 0, f.now), store.ErrCycle)
	requireIs(t, "moving an item under its own child is a cycle and must be refused",
		f.s.Move(f.ctx, root.ID, mid.ID, 0, f.now), store.ErrCycle)
	requireIs(t, "moving an item under a deeper descendant is a cycle and must be refused",
		f.s.Move(f.ctx, root.ID, leaf.ID, 0, f.now), store.ErrCycle)

	// Update is a reparenting operation too, so it is held to the same rule.
	stored := f.get(root.ID)
	stored.ParentID = leaf.ID
	requireIs(t, "Update must refuse a parent change that creates a cycle, exactly as Move does",
		f.s.Update(f.ctx, stored), store.ErrCycle)

	// The refused moves must have changed nothing.
	if got := f.get(root.ID); got.ParentID != "" {
		t.Fatalf("a refused move must leave the tree untouched\n  root now has parent %q", got.ParentID)
	}

	// A legal move still works, and moves the whole subtree with it.
	sibling := f.add(task.KindFolder, "sibling")
	requireNoError(t, "moving a subtree under an unrelated folder is legal and must succeed",
		f.s.Move(f.ctx, mid.ID, sibling.ID, 3, f.now))
	moved := f.get(mid.ID)
	if moved.ParentID != sibling.ID || moved.Position != 3 {
		t.Fatalf("Move must set both the parent and the position\n  parent is %q (expected %q) and position is %d (expected 3)",
			moved.ParentID, sibling.ID, moved.Position)
	}
	sub, err := f.s.Subtree(f.ctx, sibling.ID)
	requireNoError(t, "Subtree must return the container and everything beneath it", err)
	requireTitles(t, "a move carries the whole subtree: Subtree must return the container, then its children in tree order",
		sub, "sibling", "mid", "leaf")
}

func testInbox(t *testing.T, f *fixture) {
	loose := f.add(task.KindTask, "loose action")
	project := f.add(task.KindProject, "a project")
	filed := f.add(task.KindTask, "filed action", under(project))
	f.add(task.KindFolder, "a folder")

	requireSet(t, "the inbox is the absence of a parent: it holds tasks with no parent and nothing else (PLAN.md §3.1)",
		f.list(store.Filter{Scope: store.Scope{Inbox: true}}), "loose action")

	requireSet(t, "a top-level listing is every root, which is not the same thing as the inbox",
		f.list(store.Filter{Scope: store.Scope{Children: true}}),
		"loose action", "a project", "a folder")

	// Filing a loose task empties the inbox without anything being created
	// or deleted: the inbox is not a container.
	requireNoError(t, "filing an inbox task under a project must succeed",
		f.s.Move(f.ctx, loose.ID, project.ID, 0, f.now))
	if got := f.list(store.Filter{Scope: store.Scope{Inbox: true}}); len(got) != 0 {
		t.Fatalf("a filed task must leave the inbox\n  the inbox still holds %v", titles(got))
	}
	children, err := f.s.Children(f.ctx, project.ID)
	requireNoError(t, "Children must list the direct children of a container", err)
	requireSet(t, "the filed task must now be a child of the project it was moved into",
		children, "loose action", "filed action")
	_ = filed
}

// testAvailability is the truth table of PLAN.md §3.3, including the
// interactions: the rule reported must be the most specific one, and an
// ancestor's state must reach every item beneath it.
func testAvailability(t *testing.T, f *fixture) {
	past := timeAt(f.now, -time.Hour)
	future := timeAt(f.now, time.Hour)

	parallel := f.add(task.KindProject, "parallel project")
	onHold := f.add(task.KindProject, "project on hold", func(t *task.Task) { t.Status = task.StatusOnHold })
	deferredProject := f.add(task.KindProject, "deferred project", func(t *task.Task) { t.DeferAt = future })
	heldFolder := f.add(task.KindFolder, "folder on hold", func(t *task.Task) { t.Status = task.StatusOnHold })
	inHeldFolder := f.add(task.KindProject, "project in a held folder", under(heldFolder))
	liveFolder := f.add(task.KindFolder, "live folder")
	inLiveFolder := f.add(task.KindProject, "project in a live folder", under(liveFolder))

	plain := f.add(task.KindTask, "plain", under(parallel))
	held := f.add(task.KindTask, "held", under(parallel), func(t *task.Task) { t.Status = task.StatusOnHold })
	done := f.add(task.KindTask, "done", under(parallel), func(t *task.Task) { t.Status = task.StatusDone })
	dropped := f.add(task.KindTask, "dropped", under(parallel), func(t *task.Task) { t.Status = task.StatusDropped })
	deferredPast := f.add(task.KindTask, "deferred to the past", under(parallel), func(t *task.Task) { t.DeferAt = past })
	deferredNow := f.add(task.KindTask, "deferred to exactly now", under(parallel), func(t *task.Task) {
		at := f.now
		t.DeferAt = &at
	})
	deferredFuture := f.add(task.KindTask, "deferred to the future", under(parallel), func(t *task.Task) { t.DeferAt = future })

	underHold := f.add(task.KindTask, "under a held project", under(onHold))
	underDeferred := f.add(task.KindTask, "under a deferred project", under(deferredProject))
	underHeldFolder := f.add(task.KindTask, "under a held folder", under(inHeldFolder))
	underLiveFolder := f.add(task.KindTask, "under a live folder", under(inLiveFolder))

	// A deferred child of a sequential project that is itself on hold: three
	// rules apply at once and the most specific one must win.
	seqHold := f.add(task.KindProject, "sequential project on hold", func(t *task.Task) {
		t.Sequential = true
		t.Status = task.StatusOnHold
	})
	seqHoldFirst := f.add(task.KindTask, "first under a held sequential project", under(seqHold), at(1))
	seqHoldDeferred := f.add(task.KindTask, "deferred second under a held sequential project",
		under(seqHold), at(2), func(t *task.Task) { t.DeferAt = future })

	seq := f.add(task.KindProject, "sequential project", func(t *task.Task) { t.Sequential = true })
	seqDone := f.add(task.KindTask, "sequential first, done", under(seq), at(1), func(t *task.Task) { t.Status = task.StatusDone })
	seqDropped := f.add(task.KindTask, "sequential second, dropped", under(seq), at(2), func(t *task.Task) { t.Status = task.StatusDropped })
	seqDeleted := f.add(task.KindTask, "sequential third, deleted", under(seq), at(3), func(t *task.Task) {
		at := f.now
		t.DeletedAt = &at
	})
	seqNext := f.add(task.KindTask, "sequential fourth, the next action", under(seq), at(4))
	seqWaiting := f.add(task.KindTask, "sequential fifth, waiting its turn", under(seq), at(5))

	// Nesting: the second action group of a sequential project has not come
	// up yet, so nothing inside it has either. It needs a sequential project
	// of its own, because within one parent only one child can be next.
	seqGroups := f.add(task.KindProject, "sequential project of groups", func(t *task.Task) { t.Sequential = true })
	groupFirst := f.add(task.KindTask, "first action group", under(seqGroups), at(1))
	inGroupFirst := f.add(task.KindTask, "inside the first group", under(groupFirst))
	groupSecond := f.add(task.KindTask, "second action group", under(seqGroups), at(2))
	inGroupSecond := f.add(task.KindTask, "inside the second group", under(groupSecond))

	tombstoned := f.add(task.KindTask, "tombstoned", under(parallel), func(t *task.Task) {
		at := f.now
		t.DeletedAt = &at
	})

	cases := []struct {
		item *task.Task
		rule store.Rule
		by   *task.Task
		why  string
	}{
		{plain, store.RuleNone, nil, "an active task with no defer date under an active parallel project is available"},
		{held, store.RuleStatus, held, "rule 1: a task that is not active is not available"},
		{done, store.RuleStatus, done, "rule 1: a completed task is not available"},
		{dropped, store.RuleStatus, dropped, "rule 1: a dropped task is not available"},
		{deferredPast, store.RuleNone, nil, "rule 2: a defer date in the past has arrived"},
		{deferredNow, store.RuleNone, nil, "rule 2: a defer date of exactly now has arrived; the comparison is strict"},
		{deferredFuture, store.RuleDeferred, deferredFuture, "rule 2: a defer date in the future blocks the item itself"},
		{parallel, store.RuleNone, nil, "a project is actionable, so an active project with no defer date is available"},
		{liveFolder, store.RuleNotActionable, liveFolder, "a folder organises and is never actionable, whatever its status"},
		{tombstoned, store.RuleDeleted, tombstoned, "a tombstoned item is never available"},
		{underHold, store.RuleAncestorStatus, onHold, "rule 3: putting a project on hold empties it from every list"},
		{underDeferred, store.RuleAncestorDeferred, deferredProject, "rule 3: an ancestor's future defer date blocks everything beneath it"},
		{underHeldFolder, store.RuleAncestorStatus, heldFolder, "rule 3: a held folder blocks the projects filed in it, and their actions"},
		{underLiveFolder, store.RuleNone, nil, "rule 3: an active folder blocks nothing; filing a project must not hide its actions"},
		{seqHoldFirst, store.RuleAncestorStatus, seqHold, "rule 3 before rule 4: the first child of a sequential project on hold is blocked by the hold"},
		{seqHoldDeferred, store.RuleDeferred, seqHoldDeferred, "the item's own state is the most specific reason: its own defer date is reported, not its ancestor's hold"},
		{seqNext, store.RuleNone, nil, "rule 4: a sequential parent skips children that are done, dropped or deleted, so the first still-open one is available"},
		{seqWaiting, store.RuleSequential, seqNext, "rule 4: a later child of a sequential parent is blocked by the child that is next"},
		{inGroupFirst, store.RuleNone, nil, "rule 4 nests: the first action group of a sequential project has come up, so its contents have too"},
		{inGroupSecond, store.RuleAncestorSequential, groupSecond, "rule 4 nests: a later action group has not come up, so nothing inside it has either"},
	}

	allIDs := ids([]*task.Task{
		plain, held, done, dropped, deferredPast, deferredNow, deferredFuture, parallel,
		liveFolder, tombstoned, underHold, underDeferred, underHeldFolder, underLiveFolder,
		seqHoldFirst, seqHoldDeferred, seqNext, seqWaiting, inGroupFirst, inGroupSecond,
		seqDone, seqDropped, seqDeleted, groupFirst,
	})
	got, err := f.s.Availability(f.ctx, f.now, allIDs...)
	requireNoError(t, "Availability must answer for every id it is given", err)

	for _, c := range cases {
		a, ok := got[c.item.ID]
		if !ok {
			t.Fatalf("Availability must return an answer for %q, which exists", c.item.Title)
		}
		wantAvailable := c.rule == store.RuleNone
		if a.Available != wantAvailable {
			t.Errorf("%s\n  %q is %s, expected %s",
				c.why, c.item.Title, describe(a), map[bool]string{true: "available", false: "blocked"}[wantAvailable])
			continue
		}
		if wantAvailable {
			continue
		}
		if a.Rule != c.rule {
			t.Errorf("%s\n  %q is %s, expected rule %q", c.why, c.item.Title, describe(a), c.rule)
		}
		if c.by != nil && a.BlockedBy != c.by.ID {
			t.Errorf("%s\n  blocked_by must name the item responsible: %q is %s, expected it to name %q",
				c.why, c.item.Title, describe(a), c.by.Title)
		}
	}

	// The availability filter must agree with the computation, item for
	// item: a provider that pushes part of it into its query language has
	// to arrive at the same set.
	listed := f.list(store.Filter{Availability: store.AvailabilityAvailable})
	inListing := map[string]bool{}
	for _, item := range listed {
		inListing[item.ID] = true
	}
	for _, c := range cases {
		want := c.rule == store.RuleNone
		if inListing[c.item.ID] != want {
			t.Errorf("a listing filtered to available items must hold exactly the items Availability calls available\n  %q is %sin the listing, and Availability says %s",
				c.item.Title, map[bool]string{true: "", false: "not "}[inListing[c.item.ID]],
				describe(got[c.item.ID]))
		}
	}

	blockedList := f.list(store.Filter{Availability: store.AvailabilityBlocked, IncludeDeleted: true})
	for _, item := range blockedList {
		if got[item.ID].Available {
			t.Errorf("a listing filtered to blocked items must hold nothing that is available\n  %q is in it and is available", item.Title)
		}
	}

	deferredList := f.list(store.Filter{Availability: store.AvailabilityDeferred})
	requireSet(t, "`--deferred` asks what is waiting for a date, which is narrower than what is blocked: only the defer rules count",
		deferredList, "deferred project", "deferred to the future", "under a deferred project",
		"deferred second under a held sequential project")
}

func testOrdering(t *testing.T, f *fixture) {
	project := f.add(task.KindProject, "project", at(0))
	third := f.add(task.KindTask, "third", under(project), at(30))
	first := f.add(task.KindTask, "first", under(project), at(10))
	second := f.add(task.KindTask, "second", under(project), at(20))
	other := f.add(task.KindProject, "zzz later project", at(5))

	requireTitles(t, "the default order is tree order: a container, then its children by position, with ties broken by id",
		f.list(store.Filter{}), "project", "first", "second", "third", "zzz later project")

	requireTitles(t, "`--sort created` is id order, which is creation order (PLAN.md §3.7)",
		f.list(store.Filter{Order: store.OrderCreated}),
		"project", "third", "first", "second", "zzz later project")

	// Touching one task must move it to the end of an updated-order listing.
	later := f.now.Add(time.Hour)
	stored := f.get(first.ID)
	stored.UpdatedAt = later
	f.update(stored)
	updated := f.list(store.Filter{Order: store.OrderUpdated})
	if updated[len(updated)-1].ID != first.ID {
		t.Fatalf("`--sort updated` must put the most recently updated task last\n  the listing ends with %q, expected %q",
			updated[len(updated)-1].Title, first.Title)
	}

	// Due order: soonest first, and the ones with no date last, because a
	// listing by deadline is about the items that have one.
	withDue := f.get(second.ID)
	withDue.DueAt = timeAt(f.now, 48*time.Hour)
	f.update(withDue)
	sooner := f.get(third.ID)
	sooner.DueAt = timeAt(f.now, 24*time.Hour)
	f.update(sooner)

	byDue := f.list(store.Filter{Order: store.OrderDue})
	if byDue[0].ID != third.ID || byDue[1].ID != second.ID {
		t.Fatalf("`--sort due` must put the soonest deadline first\n  the listing starts %v", titles(byDue)[:2])
	}
	for _, item := range byDue[2:] {
		if item.DueAt != nil {
			t.Fatalf("`--sort due` must put the items with no due date last\n  the listing is %v", titles(byDue))
		}
	}

	// Position ties break by id, which is creation order.
	tieA := f.add(task.KindTask, "tie a", under(project), at(99))
	tieB := f.add(task.KindTask, "tie b", under(project), at(99))
	listed := f.list(store.Filter{Scope: store.Scope{Children: true, ParentID: project.ID}})
	order := ids(listed)
	posA, posB := indexOf(order, tieA.ID), indexOf(order, tieB.ID)
	if posA > posB {
		t.Fatalf("two siblings with the same position must be ordered by id, which is creation order\n  %q came after %q",
			tieA.Title, tieB.Title)
	}
	_ = other
}

func indexOf(xs []string, want string) int {
	for i, x := range xs {
		if x == want {
			return i
		}
	}
	return -1
}

// Children, Subtree and Availability are reachable from the command layer
// directly, but the rest of this suite only ever reaches them through List.
// A provider could therefore ship any of the three broken and still pass, so
// they are driven here on their own terms.
func testDirectAccessors(t *testing.T, f *fixture) {
	future := timeAt(f.now, time.Hour)

	folder := f.add(task.KindFolder, "folder")
	// The project is sequential, so the accessors are exercised against the
	// transitive rule of PLAN.md §3.3 rather than the easy case.
	project := f.add(task.KindProject, "project", under(folder), func(t *task.Task) { t.Sequential = true })
	first := f.add(task.KindTask, "first", under(project), at(1))
	group := f.add(task.KindTask, "group", under(project), at(2))
	inGroup := f.add(task.KindTask, "inside the group", under(group))
	deferred := f.add(task.KindTask, "deferred", under(project), at(3), func(t *task.Task) { t.DeferAt = future })
	loose := f.add(task.KindTask, "loose")

	// Children is one level, not a subtree, and it is the direct children of
	// the id given — not of its parent, and not every root.
	children, err := f.s.Children(f.ctx, project.ID)
	requireNoError(t, "Children must list the direct children of a container", err)
	requireSet(t, "Children must return one level only: the group's own child does not belong to the project's children",
		children, "first", "group", "deferred")

	childless, err := f.s.Children(f.ctx, first.ID)
	requireNoError(t, "Children of a leaf is empty, not an error", err)
	if len(childless) != 0 {
		t.Errorf("a leaf must have no children\n  got %v", titles(childless))
	}

	roots, err := f.s.Children(f.ctx, "")
	requireNoError(t, "Children of the empty id must list the top level", err)
	requireSet(t, "the top level is every item with no parent, which includes an inbox task",
		roots, "folder", "loose")

	// Subtree includes the item itself, or a caller cannot tell an empty
	// container from a missing one.
	sub, err := f.s.Subtree(f.ctx, project.ID)
	requireNoError(t, "Subtree must return the item and everything beneath it", err)
	requireSet(t, "Subtree is transitive and includes the item it was asked about",
		sub, "project", "first", "group", "inside the group", "deferred")

	leafSub, err := f.s.Subtree(f.ctx, loose.ID)
	requireNoError(t, "Subtree of a leaf is the leaf", err)
	requireSet(t, "Subtree of a childless item is that item alone", leafSub, "loose")

	// Availability answers for exactly the ids asked about, and agrees with
	// what a listing filtered on availability would have said.
	got, err := f.s.Availability(f.ctx, f.now, first.ID, deferred.ID, inGroup.ID, folder.ID)
	requireNoError(t, "Availability must answer for the ids it is given", err)
	if len(got) != 4 {
		t.Fatalf("Availability must answer for every id it was given and no others\n  asked for 4, got %d", len(got))
	}
	for _, tc := range []struct {
		id, title string
		available bool
		rule      store.Rule
	}{
		{first.ID, "first", true, ""},
		// Its own deferral is more specific than its place in the sequence.
		{deferred.ID, "deferred", false, store.RuleDeferred},
		// The group's turn has not come, so nothing inside it is available.
		{inGroup.ID, "inside the group", false, store.RuleAncestorSequential},
		{folder.ID, "folder", false, store.RuleNotActionable},
	} {
		a, ok := got[tc.id]
		if !ok {
			t.Errorf("Availability did not answer for %q", tc.title)
			continue
		}
		if a.Available != tc.available {
			t.Errorf("%q: available = %v, want %v (rule %q)", tc.title, a.Available, tc.available, a.Rule)
		}
		if !tc.available && a.Rule != tc.rule {
			t.Errorf("%q: blocked by rule %q, want %q", tc.title, a.Rule, tc.rule)
		}
	}

	// Asking for nothing is not asking for everything: a caller that built an
	// empty id list must not get the whole store back.
	none, err := f.s.Availability(f.ctx, f.now)
	requireNoError(t, "Availability with no ids is not an error", err)
	if len(none) != 0 {
		t.Errorf("Availability with no ids must answer for nothing\n  got %d answer(s)", len(none))
	}
}
