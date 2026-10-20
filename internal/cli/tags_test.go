package cli

import (
	"io"
	"strings"
	"testing"
)

// This file covers the promoted tag: a tag with a status of its own, the two
// availability rules it drives, and the command that sets it.

// tagsOf pulls the list out of a {"tags":[…]} response.
func (h *harness) tagsOf(res result) []map[string]any {
	h.t.Helper()
	obj := h.decode(res)
	raw, ok := obj["tags"].([]any)
	if !ok {
		h.t.Fatalf("no tags array in %q", res.stdout)
	}
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		tag, ok := item.(map[string]any)
		if !ok {
			h.t.Fatalf("a tag is not an object in %q", res.stdout)
		}
		out = append(out, tag)
	}
	return out
}

// tagNamed returns one tag from `tdo tag ls --json`.
func (h *harness) tagNamed(name string) map[string]any {
	h.t.Helper()
	for _, tag := range h.tagsOf(h.mustRun("tag", "ls", "--json")) {
		if strings.EqualFold(tag["name"].(string), name) {
			return tag
		}
	}
	h.t.Fatalf("no tag named %q in the listing", name)
	return nil
}

func TestTagListReportsStatusAndCount(t *testing.T) {
	h := newHarness(t)
	h.mustRun("add", "Mow the lawn", "--tag", "home,errand")
	h.mustRun("add", "Call the plumber", "--tag", "Home")

	if got := h.tagNamed("home"); got["count"] != float64(2) || got["status"] != "active" {
		t.Fatalf("a tag two tasks carry is active with count 2, got %v", got)
	}

	h.mustRun("tag", "hold", "errand")
	if got := h.tagNamed("errand"); got["status"] != "on_hold" {
		t.Fatalf("`tdo tag hold` must put the tag on hold, got %v", got)
	}
	h.mustRun("tag", "unhold", "errand")
	if got := h.tagNamed("errand"); got["status"] != "active" {
		t.Fatalf("`tdo tag unhold` must put it back, got %v", got)
	}

	// A status may be set on a tag nobody has used yet, and it is then
	// listed at zero: the hold is the point, not the count.
	h.mustRun("tag", "hold", "someday")
	someday := h.tagNamed("someday")
	if someday["count"] != float64(0) || someday["status"] != "on_hold" {
		t.Fatalf("a tag put on hold before it is used must be listed at zero, got %v", someday)
	}
	unused := h.tagsOf(h.mustRun("tag", "ls", "--unused", "--json"))
	if len(unused) != 1 || unused[0]["name"] != "someday" {
		t.Fatalf("--unused must list the tags no live task carries, got %v", unused)
	}
	held := h.tagsOf(h.mustRun("tag", "ls", "--status", "on_hold", "--json"))
	if len(held) != 1 || held[0]["name"] != "someday" {
		t.Fatalf("--status must narrow the listing, got %v", held)
	}
	if res := h.run("tag", "ls", "--status", "done"); res.code != 2 {
		t.Fatalf("a tag is never done: exit %d, want 2\nstderr: %s", res.code, res.stderr)
	}
}

func TestATagOnHoldHoldsItsItemsBack(t *testing.T) {
	h := newHarness(t)
	project := h.taskOf(h.mustRun("project", "add", "Errands", "--json"))
	drill := h.addInto("Return the drill", "Errands")
	h.addInto("Write the letter", "Errands")
	h.mustRun("edit", drill, "--tag", "errand")

	if got := len(h.tasksOf(h.mustRun("ls", "--json"))); got != 3 {
		t.Fatalf("the fixture should offer a project and two tasks, got %d", got)
	}

	h.mustRun("tag", "hold", "errand")
	available := h.tasksOf(h.mustRun("ls", "--json"))
	for _, item := range available {
		if item["title"] == "Return the drill" {
			t.Fatalf("a task whose tag is on hold must not be available: %v", item)
		}
	}
	blocked := h.tasksOf(h.mustRun("ls", "--blocked", "--json"))
	found := false
	for _, item := range blocked {
		if item["title"] != "Return the drill" {
			continue
		}
		found = true
		reason, ok := item["blocked_by"].(map[string]any)
		if !ok {
			t.Fatalf("a blocked item must say why: %v", item)
		}
		if reason["rule"] != "tag_status" || reason["tag"] != "errand" {
			t.Fatalf("the reason must name the rule and the tag, got %v", reason)
		}
	}
	if !found {
		t.Fatal("`tdo ls --blocked` must list the item its tag is holding back")
	}

	// A container's tag holds back what is inside it, exactly as putting the
	// container itself on hold would.
	h.mustRun("tag", "unhold", "errand")
	h.mustRun("edit", project["id"].(string), "--tag", "waiting")
	h.mustRun("tag", "hold", "waiting")
	for _, item := range h.tasksOf(h.mustRun("ls", "--json")) {
		t.Fatalf("a project whose tag is on hold takes its children with it, but %v is still offered", item["title"])
	}
	for _, item := range h.tasksOf(h.mustRun("ls", "--blocked", "--json")) {
		if item["title"] != "Write the letter" {
			continue
		}
		reason := item["blocked_by"].(map[string]any)
		if reason["rule"] != "ancestor_tag_status" || reason["tag"] != "waiting" {
			t.Fatalf("a child must be blocked by its ancestor's tag, got %v", reason)
		}
	}
}

func TestTagRenameAndRemove(t *testing.T) {
	h := newHarness(t)
	h.mustRun("add", "Call the bank", "--tag", "phone")
	h.mustRun("tag", "hold", "phone")

	h.mustRun("tag", "rename", "phone", "calls")
	if got := h.tagNamed("calls"); got["status"] != "on_hold" || got["count"] != float64(1) {
		t.Fatalf("a renamed tag keeps its status and its tasks, got %v", got)
	}
	for _, tag := range h.tagsOf(h.mustRun("tag", "ls", "--json")) {
		if strings.EqualFold(tag["name"].(string), "phone") {
			t.Fatalf("the old name must be gone, got %v", tag)
		}
	}
	task := h.taskOf(h.mustRun("ls", "--all", "--json"))
	if tags, _ := task["tags"].([]any); len(tags) != 1 || tags[0] != "calls" {
		t.Fatalf("the task must carry the new name, got %v", task["tags"])
	}

	removed := h.decode(h.mustRun("tag", "rm", "calls", "--json"))
	if removed["untagged"] != float64(1) {
		t.Fatalf("tag rm must report how many tasks it changed, got %v", removed)
	}
	if got := len(h.tagsOf(h.mustRun("tag", "ls", "--json"))); got != 0 {
		t.Fatalf("the tag must be gone from the listing, %d left", got)
	}
	// Removing the tag that was holding the task back lifts the hold.
	if got := len(h.tasksOf(h.mustRun("ls", "--json"))); got != 1 {
		t.Fatalf("the task must be available again once the tag is gone, got %d", got)
	}
	if res := h.run("tag", "rm", "nothing-is-filed-here"); res.code != 5 {
		t.Fatalf("an unknown tag is not found: exit %d, want 5\nstderr: %s", res.code, res.stderr)
	}
	if res := h.run("tag", "hold", "home,errand"); res.code != 2 {
		t.Fatalf("a comma-separated list is a usage error: exit %d, want 2", res.code)
	}
}

// The numbers a listing prints belong to the last listing of items. Tags are
// named, so `tdo tag ls` must not renumber anything: the bug this avoids is
// `tdo project 1` meaning a folder because `tdo folder ls` ran in between.
func TestTagListingDoesNotRenumberItems(t *testing.T) {
	h := newHarness(t)
	h.mustRun("add", "First", "--tag", "home")
	h.mustRun("add", "Second")
	h.mustRun("ls")

	h.mustRun("tag", "ls")
	shown := h.taskOf(h.mustRun("show", "1", "--json"))
	if shown["title"] != "First" {
		t.Fatalf("`tdo tag ls` must leave the item numbers alone, 1 is now %q", shown["title"])
	}
}

// Every flag `tdo project` declares must be either applied by the reshape
// path or redirected by it. A flag in neither map would be accepted and
// silently ignored, which is the bug this test exists for.
func TestEveryProjectFlagIsAppliedOrRedirected(t *testing.T) {
	a := &app{env: Env{Stdout: io.Discard, Stderr: io.Discard}}
	for _, flag := range a.projectCommand().Flags {
		for _, name := range flag.Names() {
			if reshapeFlags[name] || elsewhere[name] != "" {
				continue
			}
			t.Errorf("`tdo project --%s` is neither applied by `project <ref>` nor redirected by it; "+
				"add it to reshapeFlags or to elsewhere", name)
		}
	}
}
