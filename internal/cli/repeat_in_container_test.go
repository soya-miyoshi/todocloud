package cli

import (
	"testing"
)

// only returns the single task of a listing, failing when there is not
// exactly one. The tests below depend on the listing being unambiguous.
func only(t *testing.T, tasks []map[string]any) map[string]any {
	t.Helper()
	if len(tasks) != 1 {
		t.Fatalf("expected exactly one task in the listing, got %d", len(tasks))
	}
	return tasks[0]
}

// Completing the last open action of a complete-with-last container closes
// the container (PLAN.md §3.3a). When that action repeats, its successor is
// a new open child, so the container must NOT close — there is still work in
// it. This only holds if `tdo done` files the successor before it completes
// the instance; the other order closes the container first and leaves the
// successor parented to something already done.
func TestARepeatingLastActionKeepsItsContainerOpen(t *testing.T) {
	h := newHarness(t)

	h.mustRun("project", "add", "Weekly review", "--complete-with-last")
	h.mustRun("add", "run the review", "--project", "Weekly review", "--repeat", "1w")

	// Resolve by id: the container must not be completed out from under us.
	project := only(t, h.tasksOf(h.mustRun("ls", "--kind", "project", "--json")))
	action := only(t, h.tasksOf(h.mustRun("ls", "--kind", "task", "--json")))

	res := h.mustRun("done", action["id"].(string), "--json")
	repeated, _ := h.decode(res)["repeated"].([]any)
	if len(repeated) != 1 {
		t.Fatalf("a repeating action must produce one successor, got %d", len(repeated))
	}

	after := h.taskOf(h.mustRun("show", project["id"].(string), "--json"))
	if after["status"] != "active" {
		t.Errorf("the container closed although its repeat left an open action in it: status %q", after["status"])
	}

	// And the successor really is inside that container, not orphaned or
	// filed under a completed one.
	next, _ := repeated[0].(map[string]any)
	if next["parent_id"] != project["id"] {
		t.Errorf("the successor is parented to %v, want the container %v", next["parent_id"], project["id"])
	}
}

// The same container with a non-repeating last action does close: that is
// the rule working, and it is what makes the test above meaningful.
func TestANonRepeatingLastActionClosesItsContainer(t *testing.T) {
	h := newHarness(t)

	h.mustRun("project", "add", "Ship the thing", "--complete-with-last")
	h.mustRun("add", "the only step", "--project", "Ship the thing")

	project := only(t, h.tasksOf(h.mustRun("ls", "--kind", "project", "--json")))
	action := only(t, h.tasksOf(h.mustRun("ls", "--kind", "task", "--json")))

	h.mustRun("done", action["id"].(string), "--json")

	after := h.taskOf(h.mustRun("show", project["id"].(string), "--json"))
	if after["status"] != "done" {
		t.Errorf("the container did not complete with its last action: status %q", after["status"])
	}
}

// `tdo add --project "Launch the site"` takes a title, so the command that
// files an item afterwards must take one too. The asymmetry — a title here,
// a number there — is the kind a user discovers by having a command fail for
// no reason they can see.
func TestMvAcceptsAContainerTitleTheWayProjectFlagsDo(t *testing.T) {
	h := newHarness(t)
	h.mustRun("project", "add", "Launch the site")
	h.mustRun("add", "write the copy")

	loose := only(t, h.tasksOf(h.mustRun("ls", "--kind", "task", "--json")))
	project := only(t, h.tasksOf(h.mustRun("ls", "--kind", "project", "--json")))

	if res := h.run("mv", loose["id"].(string), "Launch the site"); res.code != 0 {
		t.Fatalf("mv by title: exit %d\nstderr: %s", res.code, res.stderr)
	}
	moved := h.taskOf(h.mustRun("show", loose["id"].(string), "--json"))
	if moved["parent_id"] != project["id"] {
		t.Errorf("the task was not filed under the named project: parent %v", moved["parent_id"])
	}
}

// Two containers with the same title is an ambiguous reference, not a guess.
func TestMvRefusesAnAmbiguousContainerTitle(t *testing.T) {
	h := newHarness(t)
	h.mustRun("project", "add", "Admin")
	h.mustRun("folder", "add", "Admin")
	h.mustRun("add", "file the receipts")

	loose := only(t, h.tasksOf(h.mustRun("ls", "--kind", "task", "--json")))
	res := h.run("mv", loose["id"].(string), "Admin")
	if res.code != 6 {
		t.Errorf("an ambiguous destination exits %d, want 6\nstderr: %s", res.code, res.stderr)
	}
}
