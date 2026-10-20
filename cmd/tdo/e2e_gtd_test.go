package main

import (
	"strings"
	"testing"
)

// A whole GTD session through the real binary: a folder, a project, the
// inbox, availability, a repeat and a review, with the filesystem watched
// around the reads so that the property of PLAN.md §3.4 — nothing but an
// explicit `tdo done` generates a row — is proven against the shipped
// executable and not only in process.
func TestAGTDSessionThroughTheRealBinary(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	h.mustRun("init")

	h.mustRun("folder", "add", "Home")
	project := h.taskOf(h.mustRun("project", "add", "Move house", "--folder", "Home", "--sequential", "--review", "1w", "--json"))
	first := h.taskOf(h.mustRun("add", "Pack the kitchen", "--project", "Move house", "--json"))
	second := h.taskOf(h.mustRun("add", "Hire a van", "--project", "Move house", "--json"))
	captured := h.taskOf(h.mustRun("add", "Ring the landlord", "--json"))

	// The capture is in the inbox and nothing else is.
	inbox := h.decode(h.mustRun("inbox", "--count", "--json"))
	if inbox["count"] != float64(1) {
		t.Fatalf("inbox count = %v, want 1", inbox["count"])
	}

	// A sequential project offers one action, and says why the other waits.
	next := h.taskOf(h.mustRun("next", "--project", "Move house", "--json"))
	if next["id"] != first["id"] {
		t.Fatalf("next = %v, want the first action", next["title"])
	}
	for _, task := range h.tasksOf(h.mustRun("ls", "--blocked", "--json")) {
		if task["id"] != second["id"] {
			continue
		}
		reason, ok := task["blocked_by"].(map[string]any)
		if !ok || reason["rule"] != "sequential" || reason["task_id"] != first["id"] {
			t.Fatalf("blocked_by = %v, want the sibling that comes first", task["blocked_by"])
		}
	}

	// The tree reads as a tree, inside 80 columns.
	tree := h.mustRun("ls", "--all", "--tree").stdout
	for _, line := range strings.Split(strings.TrimRight(tree, "\n"), "\n") {
		if len([]rune(line)) > 80 {
			t.Errorf("a tree row is wider than 80 columns: %q", line)
		}
	}
	if strings.Index(tree, "Move house") >= strings.Index(tree, "Pack the kitchen") {
		t.Errorf("the tree is not nested:\n%s", tree)
	}

	// The short numbers printed by the tree are the numbers that resolve.
	rows := strings.Split(strings.TrimRight(tree, "\n"), "\n")[1:]
	for i, row := range rows {
		shown := h.taskOf(h.mustRun("show", strings.Fields(row)[0], "--json"))
		title, _ := shown["title"].(string)
		if title == "" || !strings.Contains(row, strings.Fields(title)[0]) {
			t.Errorf("row %d (%q) does not resolve to the task it printed: %v", i+1, row, shown["title"])
		}
	}

	// A repeat, and the reads that must not generate one.
	repeating := h.taskOf(h.mustRun("add", "Water the plants", "--repeat", "1d:from_completion", "--json"))
	countBefore := h.exportCount()
	for _, args := range [][]string{
		{"ls", "--json"}, {"show", "--json", repeating["id"].(string)},
		{"next", "--json"}, {"review", "--json"}, {"export", "--json", "--all"},
		{"series", "--json", repeating["id"].(string)},
	} {
		res := h.assertNoStoreChurn(t, nil, args...)
		if res.code != 0 {
			t.Fatalf("expected success:\n%s", res.describe())
		}
		if n := h.exportCount(); n != countBefore {
			t.Fatalf("`tdo %s` generated a row: %d items, want %d", strings.Join(args, " "), n, countBefore)
		}
	}

	done := h.decode(h.mustRun("done", repeating["id"].(string), "--json"))
	repeated, ok := done["repeated"].([]any)
	if !ok || len(repeated) != 1 {
		t.Fatalf("done must report the one successor it created: %v", done["repeated"])
	}
	if n := h.exportCount(); n != countBefore+1 {
		t.Fatalf("done added %d rows, want 1", n-countBefore)
	}

	// Review, and then the whole project purged with its subtree.
	if due := h.tasksOf(h.mustRun("review", "--json")); len(due) != 1 || due[0]["id"] != project["id"] {
		t.Fatalf("review = %v, want the project with an interval", due)
	}
	h.mustRun("review", project["id"].(string))
	if due := h.tasksOf(h.mustRun("review", "--json")); len(due) != 0 {
		t.Fatalf("a project just reviewed is not due again: %v", due)
	}

	if res := h.run("rm", "--purge", "--yes", project["id"].(string)); res.code != 2 {
		t.Fatalf("purging a project that holds actions must refuse: exit %d\n%s", res.code, res.describe())
	}
	h.assertNoStoreChurn(t, nil, "rm", "--purge", "--recursive", "--yes", project["id"].(string))
	for _, task := range h.tasksOf(h.mustRun("export", "--json", "--all")) {
		if task["id"] == first["id"] || task["id"] == second["id"] {
			t.Errorf("--recursive left %v behind", task["title"])
		}
	}
	if captured["id"] == nil {
		t.Fatal("the captured task lost its id")
	}
}

// exportCount reports how many items the store holds, tombstones included.
func (h *harness) exportCount() int {
	h.t.Helper()
	obj := h.decode(h.mustRun("export", "--json", "--all"))
	n, ok := obj["count"].(float64)
	if !ok {
		h.t.Fatalf("no count in the export envelope: %v", obj)
	}
	return int(n)
}
