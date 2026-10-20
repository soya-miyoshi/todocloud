package cli

import (
	"strings"
	"testing"
)

// This file covers the three ways `tdo project` and `tdo mv` used to do the
// wrong thing quietly: a reference that resolved to the wrong kind, a flag
// that was accepted and ignored, and an order that could not be changed at
// all.

// The numbers are the last listing's, so the same `1` means different things
// at different moments. `tdo folder ls` followed by `tdo project 1
// --sequential` used to make a *folder* sequential and exit 0.
func TestProjectReshapeRefusesAFolder(t *testing.T) {
	h := newHarness(t)
	home := h.taskOf(h.mustRun("folder", "add", "Home", "--json"))
	h.mustRun("project", "add", "Kitchen", "--folder", "Home")

	h.mustRun("folder", "ls")
	res := h.run("project", "1", "--sequential")
	if res.code != 2 {
		t.Fatalf("a folder is not a project: exit %d, want 2\nstdout: %s\nstderr: %s", res.code, res.stdout, res.stderr)
	}
	if !strings.Contains(res.stderr, "is a folder, not a project") {
		t.Fatalf("the error must say what the reference turned out to be: %q", res.stderr)
	}
	folder := h.taskOf(h.mustRun("show", home["id"].(string), "--json"))
	if folder["sequential"] != false {
		t.Fatal("the folder must be untouched")
	}
}

// A change that goes through says which item it landed on, because a number
// is read off whichever listing came last.
func TestProjectReshapeNamesWhatItResolved(t *testing.T) {
	h := newHarness(t)
	h.mustRun("project", "add", "Kitchen")

	h.mustRun("project", "ls")
	res := h.mustRun("project", "1", "--sequential", "--json")
	if !strings.Contains(res.stderr, `project "Kitchen"`) {
		t.Fatalf("the resolution must be reported on stderr: %q", res.stderr)
	}
	// Machine output stays machine output: the notice is on stderr only.
	if task := h.taskOf(res); task["sequential"] != true {
		t.Fatalf("the project must have been made sequential: %v", task)
	}
}

// `tdo project <ref> --folder F` used to exit 0 and do nothing.
func TestProjectFolderMovesAnExistingProject(t *testing.T) {
	h := newHarness(t)
	home := h.taskOf(h.mustRun("folder", "add", "Home", "--json"))
	work := h.taskOf(h.mustRun("folder", "add", "Work", "--json"))
	project := h.taskOf(h.mustRun("project", "add", "Kitchen", "--folder", "Home", "--json"))
	if project["parent_id"] != home["id"] {
		t.Fatalf("project add --folder must file it: %v", project)
	}

	moved := h.taskOf(h.mustRun("project", project["id"].(string), "--folder", "Work", "--json"))
	if moved["parent_id"] != work["id"] {
		t.Fatalf("project <ref> --folder must move it, got parent %v", moved["parent_id"])
	}
	// An empty --folder is the top level.
	out := h.taskOf(h.mustRun("project", project["id"].(string), "--folder", "", "--json"))
	if out["parent_id"] != nil {
		t.Fatalf("an empty --folder means the top level, got parent %v", out["parent_id"])
	}
	// A folder is still refused where a folder cannot go.
	if res := h.run("project", project["id"].(string), "--folder", project["id"].(string)); res.code != 2 {
		t.Fatalf("a project is not a folder: exit %d, want 2\nstderr: %s", res.code, res.stderr)
	}
}

// A flag the reshape does not apply is a usage error naming where it works,
// not an exit 0 with nothing changed.
func TestProjectReshapeRefusesFlagsItDoesNotApply(t *testing.T) {
	h := newHarness(t)
	project := h.taskOf(h.mustRun("project", "add", "Kitchen", "--json"))
	id := project["id"].(string)

	for _, flag := range [][]string{
		{"--note", "later"},
		{"--tag", "home"},
		{"--due", "2026-12-01"},
		{"--defer", "2026-12-01"},
		{"--flag"},
		{"--estimate", "25m"},
		{"--status", "active"},
		{"--priority", "2"},
		{"--set", "owner=ana"},
		{"--needs-review"},
	} {
		res := h.run(append([]string{"project", id}, flag...)...)
		if res.code != 2 {
			t.Errorf("`tdo project <ref> %s`: exit %d, want 2\nstderr: %s", flag[0], res.code, res.stderr)
			continue
		}
		if !strings.Contains(res.stderr, "does not apply "+flag[0]) {
			t.Errorf("the error must name the flag and where it works: %q", res.stderr)
		}
	}
	// The project is as it was.
	after := h.taskOf(h.mustRun("show", id, "--json"))
	if after["note"] != nil || after["flagged"] != false || after["due_at"] != nil {
		t.Fatalf("a refused command must change nothing: %v", after)
	}
}

// In a sequential project the order of the children is the order they become
// available, so moving one is a feature and not a cosmetic.
func TestReorderPlacesItemsAmongTheirSiblings(t *testing.T) {
	h := newHarness(t)
	h.mustRun("project", "add", "Return", "--sequential")
	first := h.addInto("Collect the receipts", "Return")
	second := h.addInto("Fill the form", "Return")
	scan := h.addInto("Scan the copies", "Return")

	order := func() []string {
		out := []string{}
		for _, item := range h.tasksOf(h.mustRun("ls", "--all", "--json")) {
			if item["kind"] == "task" {
				out = append(out, item["title"].(string))
			}
		}
		return out
	}
	if got := strings.Join(order(), ","); got != "Collect the receipts,Fill the form,Scan the copies" {
		t.Fatalf("a child is added at the end, got %q", got)
	}

	// Put the scan first, then last again.
	h.mustRun("mv", scan, "--before", first)
	if got := strings.Join(order(), ","); got != "Scan the copies,Collect the receipts,Fill the form" {
		t.Fatalf("--before must put it ahead of the anchor, got %q", got)
	}
	h.mustRun("mv", scan, "--after", second)
	if got := strings.Join(order(), ","); got != "Collect the receipts,Fill the form,Scan the copies" {
		t.Fatalf("--after must put it behind the anchor, got %q", got)
	}

	// The order is the order the sequential rule uses, so the first child is
	// the next action and the others say which sibling is in the way.
	next := h.taskOf(h.mustRun("next", "--json"))
	if next["title"] != "Collect the receipts" {
		t.Fatalf("the next action must be the first child, got %v", next["title"])
	}
	h.mustRun("mv", scan, "--before", first)
	next = h.taskOf(h.mustRun("next", "--json"))
	if next["title"] != "Scan the copies" {
		t.Fatalf("reordering must change which action is next, got %v", next["title"])
	}
}

func TestReorderRefusesContradictions(t *testing.T) {
	h := newHarness(t)
	h.mustRun("project", "add", "Return")
	first := h.addInto("One", "Return")
	second := h.addInto("Two", "Return")

	for _, args := range [][]string{
		{"mv", second, "--before", first, "--after", first},
		{"mv", second, "--before", first, "--inbox"},
		{"mv", second, "--before", ""},
		{"mv", "--before", first},
		{"mv", first, "--before", first},
	} {
		if res := h.run(args...); res.code != 2 {
			t.Errorf("`tdo %s`: exit %d, want 2\nstderr: %s", strings.Join(args, " "), res.code, res.stderr)
		}
	}
	// Moving an item next to an anchor somewhere else moves it there too.
	h.mustRun("project", "add", "Other")
	other := h.addInto("Elsewhere", "Other")
	moved := h.taskOf(h.mustRun("mv", second, "--after", other, "--json"))
	anchor := h.taskOf(h.mustRun("show", other, "--json"))
	if moved["parent_id"] != anchor["parent_id"] {
		t.Fatalf("an item placed next to an anchor joins the anchor's container, got %v", moved["parent_id"])
	}
}
