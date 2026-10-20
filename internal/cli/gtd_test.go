package cli

import (
	"strings"
	"testing"
)

// This file covers the GTD surface of PLAN.md §4: the tree, availability, the
// inbox, repetition, review and saved queries, driven through the real
// command tree exactly as a user or an agent drives it.

// count returns how many items the store holds, tombstones included. It goes
// through `export`, which is the only listing that hides nothing.
func (h *harness) storedTotal() int {
	h.t.Helper()
	res := h.mustRun("export", "--all", "--json")
	obj := h.decode(res)
	n, ok := obj["count"].(float64)
	if !ok {
		h.t.Fatalf("no count in %q", res.stdout)
	}
	return int(n)
}

// addInto adds a task inside a container and returns its id.
func (h *harness) addInto(title, project string) string {
	h.t.Helper()
	t := h.taskOf(h.mustRun("add", title, "--project", project, "--json"))
	return t["id"].(string)
}

func TestACapturedTaskLandsInTheInboxAndIsFiledByProcessing(t *testing.T) {
	h := newHarness(t)
	h.mustRun("project", "add", "Errands", "--json")
	captured := h.taskOf(h.mustRun("add", "Buy stamps", "--json"))
	if captured["parent_id"] != nil {
		t.Fatalf("a capture with no --project belongs to nobody: %v", captured)
	}

	if obj := h.decode(h.mustRun("inbox", "--count", "--json")); obj["count"] != float64(1) {
		t.Fatalf("inbox count: %v", obj["count"])
	}
	filed := h.taskOf(h.mustRun("inbox", "process", captured["id"].(string), "--project", "Errands", "--json"))
	if filed["parent_id"] == nil {
		t.Fatalf("processing must file the item somewhere: %v", filed)
	}
	if obj := h.decode(h.mustRun("inbox", "--count", "--json")); obj["count"] != float64(0) {
		t.Fatalf("the filed item is still in the inbox: %v", obj["count"])
	}
}

func TestTheDefaultListingShowsOnlyWhatCanBeWorkedOn(t *testing.T) {
	h := newHarness(t)
	h.mustRun("project", "add", "Errands", "--json")
	h.addInto("Can be done", "Errands")
	deferred := h.addInto("Not yet", "Errands")
	h.mustRun("defer", deferred, "2099-01-01")

	// --kind task asks the question this case is about; a project of its own
	// is available too, and appears in a listing that does not narrow by kind.
	available := h.tasksOf(h.mustRun("ls", "--kind", "task", "--json"))
	if len(available) != 1 || available[0]["title"] != "Can be done" {
		t.Fatalf("the default listing is the available work: %v", available)
	}
	if available[0]["available"] != true || available[0]["blocked_by"] != nil {
		t.Fatalf("an available task says so without a reason: %v", available[0])
	}

	if all := h.tasksOf(h.mustRun("ls", "--json")); len(all) != 2 {
		t.Fatalf("a project with available work is available itself: %v", all)
	}
	blocked := h.tasksOf(h.mustRun("ls", "--deferred", "--json"))
	if len(blocked) != 1 || blocked[0]["id"] != deferred {
		t.Fatalf("--deferred is what is waiting for a date: %v", blocked)
	}
	reason, ok := blocked[0]["blocked_by"].(map[string]any)
	if !ok || reason["rule"] != "deferred" || reason["task_id"] != deferred {
		t.Fatalf("blocked_by must name the rule and the item: %v", blocked[0]["blocked_by"])
	}
}

func TestASequentialProjectOffersOneActionAtATime(t *testing.T) {
	h := newHarness(t)
	h.mustRun("project", "add", "Move house", "--sequential", "--json")
	first := h.addInto("Pack", "Move house")
	second := h.addInto("Hire a van", "Move house")

	next := h.taskOf(h.mustRun("next", "--json"))
	if next["id"] != first {
		t.Fatalf("next must be the first child of a sequential project: %v", next["title"])
	}
	blocked := h.tasksOf(h.mustRun("ls", "--blocked", "--json"))
	var found map[string]any
	for _, task := range blocked {
		if task["id"] == second {
			found = task
		}
	}
	if found == nil {
		t.Fatalf("the second action should be blocked: %v", blocked)
	}
	reason := found["blocked_by"].(map[string]any)
	if reason["rule"] != "sequential" || reason["task_id"] != first {
		t.Fatalf("the reason must name the sibling that comes first: %v", reason)
	}

	// `tdo show` explains it in a sentence, naming the sibling by title.
	shown := h.mustRun("show", second)
	if !strings.Contains(shown.stdout, "Pack") || !strings.Contains(shown.stdout, "available") {
		t.Fatalf("show must explain the hold: %q", shown.stdout)
	}

	h.mustRun("done", first)
	if after := h.taskOf(h.mustRun("next", "--json")); after["id"] != second {
		t.Fatalf("completing the first action releases the second: %v", after)
	}
}

func TestHoldingAProjectEmptiesItFromEveryListing(t *testing.T) {
	h := newHarness(t)
	project := h.taskOf(h.mustRun("project", "add", "Later", "--json"))
	child := h.addInto("Something inside", "Later")

	h.mustRun("hold", project["id"].(string))
	if tasks := h.tasksOf(h.mustRun("ls", "--json")); len(tasks) != 0 {
		t.Fatalf("a held project takes its children with it: %v", tasks)
	}
	blocked := h.tasksOf(h.mustRun("ls", "--blocked", "--json"))
	for _, task := range blocked {
		if task["id"] != child {
			continue
		}
		reason := task["blocked_by"].(map[string]any)
		if reason["rule"] != "ancestor_status" || reason["task_id"] != project["id"] {
			t.Fatalf("the reason must name the project: %v", reason)
		}
		return
	}
	t.Fatalf("the child should appear under --blocked: %v", blocked)
}

func TestTheTreeIsPrintedWithIndentation(t *testing.T) {
	h := newHarness(t)
	h.mustRun("folder", "add", "Home")
	h.mustRun("project", "add", "Kitchen", "--folder", "Home")
	h.addInto("Fix the tap", "Kitchen")

	out := h.mustRun("ls", "--all", "--tree").stdout
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	if len(lines) != 4 {
		t.Fatalf("expected a header and three rows: %q", out)
	}
	indent := func(line string) int {
		// The title column starts after the fixed columns, so the relative
		// indentation is what is compared, not an absolute position.
		return strings.Index(line, strings.TrimSpace(line[strings.Index(line, "  "):]))
	}
	_ = indent
	if strings.Index(lines[1], "Home") >= strings.Index(lines[2], "Kitchen") {
		t.Fatalf("a project must be indented under its folder:\n%s", out)
	}
	if strings.Index(lines[2], "Kitchen") >= strings.Index(lines[3], "Fix the tap") {
		t.Fatalf("an action must be indented under its project:\n%s", out)
	}
	for _, line := range lines {
		if len([]rune(line)) > 80 {
			t.Fatalf("a tree row is wider than 80 columns: %q", line)
		}
	}
}

func TestATaskCannotGoInsideAFolderAndNothingCanContainItself(t *testing.T) {
	h := newHarness(t)
	folder := h.taskOf(h.mustRun("folder", "add", "Home", "--json"))
	project := h.taskOf(h.mustRun("project", "add", "Kitchen", "--folder", "Home", "--json"))
	task := h.taskOf(h.mustRun("add", "Fix the tap", "--project", "Kitchen", "--json"))

	if res := h.run("add", "Loose", "--parent", folder["id"].(string)); res.code != 2 {
		t.Fatalf("a task inside a folder is a usage error: exit %d (%s)", res.code, res.stderr)
	}
	if res := h.run("mv", task["id"].(string), folder["id"].(string)); res.code != 2 {
		t.Fatalf("moving a task into a folder is a usage error: exit %d (%s)", res.code, res.stderr)
	}
	if res := h.run("mv", folder["id"].(string), project["id"].(string)); res.code != 2 {
		t.Fatalf("a cycle is a usage error: exit %d (%s)", res.code, res.stderr)
	}
	if res := h.run("mv", folder["id"].(string), folder["id"].(string)); res.code != 2 {
		t.Fatalf("an item cannot be its own parent: exit %d (%s)", res.code, res.stderr)
	}
}

func TestPurgingAContainerNeedsRecursive(t *testing.T) {
	h := newHarness(t)
	project := h.taskOf(h.mustRun("project", "add", "Errands", "--json"))
	h.addInto("Buy stamps", "Errands")

	res := h.run("rm", project["id"].(string), "--purge", "--yes")
	if res.code != 2 {
		t.Fatalf("purging a container that holds items must refuse: exit %d (%s)", res.code, res.stderr)
	}
	if n := h.storedTotal(); n != 2 {
		t.Fatalf("the refusal deleted something: %d item(s) left", n)
	}
	h.mustRun("rm", project["id"].(string), "--purge", "--recursive", "--yes")
	if n := h.storedTotal(); n != 0 {
		t.Fatalf("--recursive must take the subtree: %d item(s) left", n)
	}
}

func TestRemovingAContainerTombstonesItsSubtree(t *testing.T) {
	h := newHarness(t)
	project := h.taskOf(h.mustRun("project", "add", "Errands", "--json"))
	h.addInto("Buy stamps", "Errands")

	removed := h.tasksOf(h.mustRun("rm", project["id"].(string), "--json"))
	if len(removed) != 2 {
		t.Fatalf("rm on a container takes its children with it: %v", removed)
	}
	for _, task := range removed {
		if task["deleted_at"] == nil {
			t.Fatalf("a removed item carries a tombstone: %v", task)
		}
	}
}

func TestCompletingARepeatingTaskCreatesExactlyOneSuccessor(t *testing.T) {
	h := newHarness(t)
	added := h.taskOf(h.mustRun("add", "Water the plants", "--repeat", "1w", "--due", "2026-11-01", "--json"))
	id := added["id"].(string)

	obj := h.decode(h.mustRun("done", id, "--json"))
	repeated, ok := obj["repeated"].([]any)
	if !ok || len(repeated) != 1 {
		t.Fatalf("done must report the successor it created: %v", obj["repeated"])
	}
	next := repeated[0].(map[string]any)
	if next["id"] == id {
		t.Fatalf("the successor needs an id of its own: %v", next)
	}
	if next["due_at"] != "2026-11-08T00:00:00Z" {
		t.Fatalf("a fixed repeat advances the due date: %v", next["due_at"])
	}
	if next["series_id"] != added["series_id"] {
		t.Fatalf("the successor stays in the series: %v vs %v", next["series_id"], added["series_id"])
	}
	if n := h.storedTotal(); n != 2 {
		t.Fatalf("exactly one successor: %d item(s) stored", n)
	}

	// The series shows both instances, and --no-repeat ends it.
	series := h.decode(h.mustRun("series", next["id"].(string), "--json"))
	if series["count"] != float64(2) {
		t.Fatalf("series: %v", series["count"])
	}
	h.mustRun("done", next["id"].(string), "--no-repeat")
	if n := h.storedTotal(); n != 2 {
		t.Fatalf("--no-repeat must create nothing: %d item(s) stored", n)
	}
}

// The safety property of PLAN.md §3.4: a new instance appears only as the
// direct result of an explicit `tdo done`. A tool an agent drives must not
// manufacture rows while it is being read, so every read is run repeatedly
// and the store is counted after each one.
func TestNoCommandGeneratesARepeatExceptAnExplicitDone(t *testing.T) {
	h := newHarness(t)
	h.mustRun("project", "add", "Chores", "--review", "1d", "--json")
	added := h.taskOf(h.mustRun("add", "Water the plants", "--project", "Chores",
		"--repeat", "1d", "--due", "2020-01-01", "--json"))
	id := added["id"].(string)

	before := h.storedTotal()
	if before != 2 {
		t.Fatalf("the fixture should hold a project and one task, got %d", before)
	}

	// Every read, including the ones whose whole subject is repetition and
	// review, and each of them twice.
	reads := [][]string{
		{"ls"}, {"ls", "--json"}, {"ls", "--all", "--json"}, {"ls", "--blocked", "--json"},
		{"ls", "--tree"}, {"show", id}, {"show", id, "--json"},
		{"next", "--json"}, {"inbox", "--json"}, {"inbox", "--count", "--json"},
		{"review", "--json"}, {"review"}, {"series", id, "--json"},
		{"project", "ls", "--json"}, {"folder", "ls", "--json"},
		{"export", "--json"}, {"export", "--all", "--csv"},
	}
	for round := 0; round < 2; round++ {
		for _, args := range reads {
			h.mustRun(args...)
			if n := h.storedTotal(); n != before {
				t.Fatalf("`tdo %s` changed the number of items from %d to %d — a read must generate nothing",
					strings.Join(args, " "), before, n)
			}
		}
	}

	// Only the explicit completion does, and only once.
	h.mustRun("done", id, "--json")
	if n := h.storedTotal(); n != before+1 {
		t.Fatalf("done on a repeating task adds exactly one row: %d, want %d", n, before+1)
	}
}

func TestReviewListsWhatIsDueAndMarkingItMovesTheNextDate(t *testing.T) {
	h := newHarness(t)
	h.mustRun("project", "add", "Errands", "--review", "1w", "--json")
	h.mustRun("project", "add", "Unreviewed", "--json")

	due := h.tasksOf(h.mustRun("review", "--json"))
	if len(due) != 1 || due[0]["title"] != "Errands" {
		t.Fatalf("only a project with a review interval is ever due: %v", due)
	}
	if due[0]["next_review_at"] == nil {
		t.Fatalf("a reviewable project carries its derived next_review_at: %v", due[0])
	}

	marked := h.taskOf(h.mustRun("review", "Errands", "--json"))
	if marked["last_reviewed_at"] == nil {
		t.Fatalf("review <ref> records that it was looked at: %v", marked)
	}
	if again := h.tasksOf(h.mustRun("review", "--json")); len(again) != 0 {
		t.Fatalf("a project just reviewed is not due again: %v", again)
	}
}

func TestAPerspectiveIsExactlyTheFilterItSaved(t *testing.T) {
	h := newHarness(t)
	h.mustRun("add", "Important", "--flag")
	h.mustRun("add", "Ordinary")

	saved := h.decode(h.mustRun("perspective", "save", "hot", "--json", "--", "--flagged"))
	p, ok := saved["perspective"].(map[string]any)
	if !ok || p["name"] != "hot" {
		t.Fatalf("perspective save shape: %v", saved)
	}

	tasks := h.tasksOf(h.mustRun("ls", "--perspective", "hot", "--json"))
	if len(tasks) != 1 || tasks[0]["title"] != "Important" {
		t.Fatalf("running a perspective is running its filter: %v", tasks)
	}
	// Mixing a perspective with a filter flag would be neither one nor the
	// other, so it is refused.
	if res := h.run("ls", "--perspective", "hot", "--inbox"); res.code != 2 {
		t.Fatalf("--perspective with a filter flag: exit %d", res.code)
	}

	listed := h.decode(h.mustRun("perspective", "ls", "--json"))
	if listed["count"] != float64(1) {
		t.Fatalf("perspective ls: %v", listed)
	}
	h.mustRun("perspective", "rm", "hot")
	if res := h.run("ls", "--perspective", "hot"); res.code != 5 {
		t.Fatalf("a removed perspective is not found: exit %d", res.code)
	}
}

func TestEveryEmittedTaskCarriesTheDerivedKeys(t *testing.T) {
	h := newHarness(t)
	h.mustRun("add", "Anything", "--json")

	for _, args := range [][]string{
		{"ls", "--json"}, {"inbox", "--json"}, {"next", "--json"},
		{"show", "1", "--json"},
	} {
		if args[0] == "show" {
			h.mustRun("ls")
		}
		res := h.mustRun(args...)
		obj := h.decode(res)
		var task map[string]any
		switch v := obj["task"].(type) {
		case map[string]any:
			task = v
		default:
			task = h.tasksOf(res)[0]
		}
		for _, key := range []string{"available", "blocked_by", "next_review_at", "kind", "status"} {
			if _, ok := task[key]; !ok {
				t.Errorf("`tdo %s` left out %q: %v", strings.Join(args, " "), key, task)
			}
		}
	}
}

func TestFlagsAndDatesAndStatusesRoundTrip(t *testing.T) {
	h := newHarness(t)
	added := h.taskOf(h.mustRun("add", "Subject", "--json"))
	id := added["id"].(string)

	if got := h.tasksOf(h.mustRun("flag", id, "--json"))[0]; got["flagged"] != true {
		t.Fatalf("flag: %v", got)
	}
	if got := h.tasksOf(h.mustRun("unflag", id, "--json"))[0]; got["flagged"] != false {
		t.Fatalf("unflag: %v", got)
	}
	if got := h.tasksOf(h.mustRun("hold", id, "--json"))[0]; got["status"] != "on_hold" {
		t.Fatalf("hold: %v", got)
	}
	if got := h.tasksOf(h.mustRun("drop", id, "--json"))[0]; got["status"] != "dropped" || got["dropped_at"] == nil {
		t.Fatalf("drop: %v", got)
	}
	if got := h.tasksOf(h.mustRun("undone", id, "--json"))[0]; got["status"] != "active" {
		t.Fatalf("undone: %v", got)
	}
	if got := h.tasksOf(h.mustRun("due", id, "2026-11-01", "--json"))[0]; got["due_at"] != "2026-11-01T00:00:00Z" {
		t.Fatalf("due: %v", got)
	}
	if got := h.tasksOf(h.mustRun("due", id, "--clear", "--json"))[0]; got["due_at"] != nil {
		t.Fatalf("due --clear: %v", got)
	}
	if got := h.tasksOf(h.mustRun("defer", id, "2026-11-01", "--json"))[0]; got["defer_at"] != "2026-11-01T00:00:00Z" {
		t.Fatalf("defer: %v", got)
	}
	if got := h.tasksOf(h.mustRun("defer", id, "--clear", "--json"))[0]; got["defer_at"] != nil {
		t.Fatalf("defer --clear: %v", got)
	}
	if got := h.taskOf(h.mustRun("edit", id, "--estimate", "25m", "--json")); got["estimated_minutes"] != float64(25) {
		t.Fatalf("estimate: %v", got)
	}
	if tasks := h.tasksOf(h.mustRun("ls", "--estimate-under", "30m", "--json")); len(tasks) != 1 {
		t.Fatalf("--estimate-under: %v", tasks)
	}
}
