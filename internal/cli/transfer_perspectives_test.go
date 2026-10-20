package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeFile puts an import file in the test's own directory and returns its
// path.
func writeFile(t *testing.T, name, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("writing %s: %v", name, err)
	}
	return path
}

// PLAN.md §10 makes `tdo export` followed by `tdo import` the way to move a
// list to another provider, and §3.7 calls an export a backup. A saved query
// that is in neither is lost on both paths without a word.
func TestExportCarriesTheSavedPerspectives(t *testing.T) {
	h := newHarness(t)
	h.mustRun("add", "write the report", "--flag")
	h.mustRun("perspective", "save", "hot", "--", "--flagged")

	obj := h.decode(h.mustRun("export"))

	ps, ok := obj["perspectives"].([]any)
	if !ok {
		t.Fatalf("an export must carry the saved perspectives: %v", obj)
	}
	if len(ps) != 1 {
		t.Fatalf("one perspective was saved, the export has %d: %v", len(ps), ps)
	}
	first, _ := ps[0].(map[string]any)
	if first["name"] != "hot" {
		t.Errorf("the exported perspective is not the saved one: %v", first)
	}
	if filter, ok := first["filter"].(map[string]any); !ok || filter["flagged"] != true {
		t.Errorf("a perspective is its filter, and the filter did not come with it: %v", first)
	}

	// count has always meant the number of tasks. Folding anything else into
	// it would change what every existing reader is told.
	if obj["count"] != float64(1) {
		t.Errorf("count must still be the task count, got %v", obj["count"])
	}
	if obj["perspective_count"] != float64(1) {
		t.Errorf("perspective_count must be the number of saved queries, got %v", obj["perspective_count"])
	}
	if obj["version"] != float64(1) {
		t.Errorf("version names the shape of the file, and this is shape 1, got %v", obj["version"])
	}
}

// An export of a store with no saved query still says so, rather than
// leaving a reader to guess whether the key is missing or the list is empty.
func TestAnExportWithNoPerspectivesSaysSo(t *testing.T) {
	h := newHarness(t)
	h.mustRun("add", "write the report")

	obj := h.decode(h.mustRun("export"))
	ps, ok := obj["perspectives"].([]any)
	if !ok || len(ps) != 0 {
		t.Errorf("an empty perspectives array, not a missing key: %v", obj["perspectives"])
	}
}

// The round trip is the point: what export writes, import must restore.
func TestImportRestoresTheExportedPerspectives(t *testing.T) {
	source := newHarness(t)
	source.mustRun("add", "write the report", "--flag")
	source.mustRun("perspective", "save", "hot", "--", "--flagged")
	archive := writeFile(t, "backup.json", source.mustRun("export").stdout)

	target := newHarness(t)
	obj := target.decode(target.mustRun("import", archive, "--json"))
	if obj["perspectives_imported"] != float64(1) || obj["perspectives_skipped"] != float64(0) {
		t.Fatalf("import must restore the saved queries: %v", obj)
	}
	// imported and skipped keep counting tasks only.
	if obj["imported"] != float64(1) {
		t.Errorf("imported must still be the task count: %v", obj)
	}

	listed := target.decode(target.mustRun("perspective", "ls", "--json"))
	raw, _ := json.Marshal(listed["perspectives"])
	if !strings.Contains(string(raw), `"hot"`) {
		t.Errorf("the restored perspective is not in the target store: %s", raw)
	}
	// The restored query is the saved query: running it finds the flagged task.
	if tasks := target.tasksOf(target.mustRun("ls", "--perspective", "hot", "--json")); len(tasks) != 1 {
		t.Errorf("the restored perspective must run as the query it was saved as, it found %d task(s)", len(tasks))
	}
}

// An import adds; it never overwrites. That is what it already does with a
// task whose id is taken, and a saved query the user is still using is worth
// at least as much care: replacing it would change what `tdo ls
// --perspective` means with nothing on screen to say so.
func TestImportSkipsAPerspectiveWhoseNameIsTaken(t *testing.T) {
	source := newHarness(t)
	source.mustRun("add", "write the report", "--flag")
	source.mustRun("perspective", "save", "hot", "--", "--flagged")
	archive := writeFile(t, "backup.json", source.mustRun("export").stdout)

	target := newHarness(t)
	// The name is already in use here, for a different query.
	target.mustRun("perspective", "save", "HOT", "--", "--inbox")

	obj := target.decode(target.mustRun("import", archive, "--json"))
	if obj["perspectives_imported"] != float64(0) || obj["perspectives_skipped"] != float64(1) {
		t.Fatalf("a name already in use must be skipped and counted, not overwritten: %v", obj)
	}

	shown := target.decode(target.mustRun("perspective", "show", "hot", "--json"))
	p, _ := shown["perspective"].(map[string]any)
	filter, _ := p["filter"].(map[string]any)
	if filter["flagged"] != nil {
		t.Errorf("the perspective already in the store must be untouched: %v", filter)
	}
}

// The file is checked before the first write, perspectives included: a file
// that is rejected leaves nothing stored.
func TestABadPerspectiveInAnImportFileIsRejectedBeforeAnythingIsWritten(t *testing.T) {
	h := newHarness(t)
	archive := writeFile(t, "bad.json", `{"version":1,"tasks":[
		{"id":"01J3ZQK8V9XW5S6R7T8Y9Z0A1B","title":"write the report",
		 "created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}],
		"perspectives":[{"name":"broken","filter":{"order":"sideways"}}]}`)

	res := h.run("import", archive)
	if res.code != 2 {
		t.Fatalf("a filter no provider could honour is a usage error, got exit %d\nstderr: %s", res.code, res.stderr)
	}
	if !strings.Contains(res.stderr, "broken") {
		t.Errorf("the error must name the offending perspective: %q", res.stderr)
	}
	if tasks := h.tasksOf(h.mustRun("ls", "--all", "--json")); len(tasks) != 0 {
		t.Errorf("an import is never partial, but %d task(s) were written", len(tasks))
	}
}

// A stored filter carrying a key this binary does not know would run as a
// wider query than the one that was saved, so the file is refused.
func TestAnImportedPerspectiveWithAnUnknownFilterKeyIsRefused(t *testing.T) {
	h := newHarness(t)
	archive := writeFile(t, "newer.json", `{"version":1,"tasks":[],
		"perspectives":[{"name":"from the future","filter":{"flagged":true,"excludes_waiting":true}}]}`)

	res := h.run("import", archive)
	if res.code != 2 {
		t.Fatalf("exit %d, want 2 for a filter this binary cannot run faithfully\nstderr: %s", res.code, res.stderr)
	}
	if !strings.Contains(res.stderr, "excludes_waiting") {
		t.Errorf("the error must name the key it did not understand: %q", res.stderr)
	}
}

// CSV is a task table. A saved query has no row in it, and a user taking a
// CSV backup with perspectives saved should hear that they are not in it —
// on stderr, because stdout is the CSV.
func TestCSVExportSaysThatPerspectivesAreNotInIt(t *testing.T) {
	h := newHarness(t)
	h.mustRun("add", "write the report", "--flag")
	h.mustRun("perspective", "save", "hot", "--", "--flagged")

	res := h.mustRun("export", "--csv")
	if strings.Contains(res.stdout, "perspective") {
		t.Errorf("the CSV itself must stay a task table: %q", res.stdout)
	}
	if !strings.Contains(res.stderr, "perspective") {
		t.Errorf("a CSV export of a store with saved queries must say they are not in it, stderr was %q", res.stderr)
	}

	// With nothing saved there is nothing to say.
	clean := newHarness(t)
	clean.mustRun("add", "write the report")
	if res := clean.mustRun("export", "--csv"); strings.Contains(res.stderr, "perspective") {
		t.Errorf("nothing was saved, so nothing should have been said: %q", res.stderr)
	}
}
