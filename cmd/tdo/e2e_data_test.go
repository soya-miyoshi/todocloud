package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Awkward but legitimate data, through the real process. A title arrives as an
// argv element, so the shell quoting, the flag parser and the SQLite text
// encoding all have a say in it — none of which the in-process tests exercise.

// awkwardTitles is the set every round trip is checked against.
func awkwardTitles() map[string]string {
	return map[string]string{
		"emoji and CJK":        "買い物 🛒 done? — 済み ✅",
		"combining characters": "égalité and ＡＢＣ", // decomposed accents plus fullwidth
		"newline and tab":      "first line\nsecond\tcolumn",
		"looks like a flag":    "--not-a-flag",
		"very long":            strings.Repeat("x", 10000),
		"quotes and backslash": `he said "hi" \ then left`,
	}
}

// argvSafeBytes is how much a single value may carry and still be passable
// to the binary on every supported platform. Windows caps a whole command
// line at 32,767 characters in CreateProcess, so a value that a Unix argv
// takes without noticing cannot be handed to the process there at all — the
// exec fails before main runs, which is the OS's limit and not something the
// tool can carry. A value larger than this reaches the store through import,
// which reads a file and has no such ceiling.
const argvSafeBytes = 8 * 1024

// largeFieldValue is the value too big for any argv: the size a real archive
// from a note-taking habit reaches, kept out of the command line.
func largeFieldValue() string { return strings.Repeat("payload ", 100*1024/8) } // 100 KB

// seedLargeField adds one task carrying a 100 KB user-defined field, through
// import rather than argv, and returns its title. The archive is a file, so
// the value's size is the store's business and not the platform's.
func (h *harness) seedLargeField(key, title string) string {
	h.t.Helper()
	archive := filepath.Join(h.root, "large-"+key+".json")
	data, err := json.Marshal(map[string]any{
		"version": 1,
		"tasks": []map[string]any{{
			"title":      title,
			"created_at": "2026-01-01T00:00:00Z",
			"updated_at": "2026-01-01T00:00:00Z",
			key:          largeFieldValue(),
		}},
	})
	if err != nil {
		h.t.Fatalf("encoding the large-field archive: %v", err)
	}
	if err := os.WriteFile(archive, data, 0o600); err != nil {
		h.t.Fatalf("writing the large-field archive: %v", err)
	}
	imported := h.decode(h.mustRun("import", "--json", "--new-ids", archive))
	if imported["imported"] != float64(1) {
		h.t.Fatalf("the large-field import reported %#v, want 1 imported", imported)
	}
	return title
}

// TestAwkwardTitlesSurviveTheRealProcess adds each title through the binary
// and reads it back, so that anything argv, the parser or the driver does to
// it would show up.
func TestAwkwardTitlesSurviveTheRealProcess(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	h.mustRun("init")

	ids := make(map[string]string)
	for name, title := range awkwardTitles() {
		// A title that begins with a dash has to come after the end-of-flags
		// marker, which is how a user passes one too.
		var res result
		if strings.HasPrefix(title, "-") {
			res = h.mustRun("add", "--json", "--", title)
		} else {
			res = h.mustRun("add", "--json", title)
		}
		task := h.taskOf(res)
		if got := fmt.Sprint(task["title"]); got != title {
			t.Errorf("%s: title round-tripped as %q (%d bytes), want %q (%d bytes)",
				name, abbreviate(got), len(got), abbreviate(title), len(title))
		}
		ids[name] = fmt.Sprint(task["id"])
	}

	// show reads each one back by id.
	for name, id := range ids {
		task := h.taskOf(h.mustRun("show", "--json", id))
		want := awkwardTitles()[name]
		if got := fmt.Sprint(task["title"]); got != want {
			t.Errorf("%s: show returned %q, want %q", name, abbreviate(got), abbreviate(want))
		}
	}
}

// TestAUserDefinedFieldHoldsANestedObjectAndALargeString checks --set with
// values that are not scalars and not small.
func TestAUserDefinedFieldHoldsANestedObjectAndALargeString(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	h.mustRun("init")

	nested := `{"owner":{"name":"あや","tags":["a","b"]},"count":2}`
	big := strings.Repeat("payload ", argvSafeBytes/8)

	task := h.taskOf(h.mustRun("add", "--json", "Big fields",
		"--set", "meta="+nested, "--set", "blob="+big))

	// The nested value is stored as it reads: either the parsed object or the
	// string, but byte-identical on the way back either way.
	switch meta := task["meta"].(type) {
	case map[string]any:
		owner, ok := meta["owner"].(map[string]any)
		if !ok || owner["name"] != "あや" {
			t.Errorf("the nested object came back as %#v", meta)
		}
	case string:
		if meta != nested {
			t.Errorf("the nested value came back as %q, want %q", meta, nested)
		}
	default:
		t.Errorf("the nested value came back as %T: %#v", meta, meta)
	}
	if got := fmt.Sprint(task["blob"]); got != big {
		t.Errorf("the %d byte value came back as %d bytes, want %d", len(big), len(got), len(big))
	}

	// The same field a hundred times larger, which only import can deliver.
	h.seedLargeField("blob", "Big fields from an archive")
	for _, stored := range h.tasksOf(h.mustRun("ls", "--json", "--all")) {
		if fmt.Sprint(stored["title"]) != "Big fields from an archive" {
			continue
		}
		if got := fmt.Sprint(stored["blob"]); got != largeFieldValue() {
			t.Errorf("the 100 KB value came back as %d bytes, want %d", len(got), len(largeFieldValue()))
		}
	}
}

// TestFiveHundredTasksListWithALimit adds 500 tasks through 500 processes'
// worth of work — in one session, sequentially — and checks that --limit
// stops where it says it does.
func TestFiveHundredTasksListWithALimit(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	h.mustRun("init")

	const total = 500
	// One process per add would dominate the suite's runtime, so the bulk
	// arrives through import — which is a real process too — and a handful
	// are added one at a time to keep `add` in the path.
	var bulk []map[string]any
	for i := range total - 5 {
		bulk = append(bulk, map[string]any{
			"title":      fmt.Sprintf("bulk %03d", i),
			"created_at": "2026-01-01T00:00:00Z",
			"updated_at": "2026-01-01T00:00:00Z",
		})
	}
	archive := filepath.Join(h.root, "bulk.json")
	data, err := json.Marshal(map[string]any{"version": 1, "tasks": bulk})
	if err != nil {
		t.Fatalf("encoding the bulk archive: %v", err)
	}
	if err := os.WriteFile(archive, data, 0o600); err != nil {
		t.Fatalf("writing the bulk archive: %v", err)
	}
	imported := h.decode(h.mustRun("import", "--json", "--new-ids", archive))
	if imported["imported"] != float64(total-5) {
		t.Fatalf("imported = %#v, want %d", imported["imported"], total-5)
	}
	for i := range 5 {
		h.addTask(fmt.Sprintf("added %d", i))
	}

	all := h.tasksOf(h.mustRun("ls", "--json", "--all"))
	if len(all) != total {
		t.Fatalf("the store holds %d tasks, want %d", len(all), total)
	}
	for _, limit := range []int{1, 10, 499, 500, 501} {
		res := h.mustRun("ls", "--json", "--all", "--limit", fmt.Sprint(limit))
		got := h.tasksOf(res)
		want := min(limit, total)
		if len(got) != want {
			t.Errorf("ls --limit %d returned %d tasks, want %d", limit, len(got), want)
		}
		if count := h.decode(res)["count"]; count != float64(want) {
			t.Errorf("ls --limit %d reported count %#v, want %d", limit, count, want)
		}
	}
}

// TestTheWholeAwkwardSetRoundTripsThroughExportAndImport is the end of the
// data section: everything above, exported from one database and imported
// into a second one, compared field by field.
func TestTheWholeAwkwardSetRoundTripsThroughExportAndImport(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	h.mustRun("init")

	for _, title := range awkwardTitles() {
		if strings.HasPrefix(title, "-") {
			h.mustRun("add", "--json", "--", title)
		} else {
			h.mustRun("add", "--json", title)
		}
	}
	h.mustRun("add", "--json", "With fields",
		"--due", "2026-12-24", "--priority", "3", "--tag", "家事,urgent",
		"--notes", "line one\nline two",
		"--set", "meta={\"k\":[1,2,3]}", "--set", "blob="+strings.Repeat("y", argvSafeBytes))
	// A field far past what any argv carries belongs in the archive too: the
	// export and the import are files at both ends, so this is the one path
	// where its size is tested rather than the command line's.
	h.seedLargeField("blob", "A field too big for a command line")

	archive := filepath.Join(h.root, "awkward.json")
	export := h.mustRun("export", "--json", "--all")
	if err := os.WriteFile(archive, []byte(export.stdout), 0o600); err != nil {
		t.Fatalf("writing the archive: %v", err)
	}

	second := h.second("awkward-b")
	second.mustRun("init")
	imported := second.decode(second.mustRun("import", "--json", archive))
	if imported["skipped"] != float64(0) {
		t.Errorf("the import into an empty store skipped rows: %v", imported)
	}

	want := byID(h.tasksOf(h.mustRun("ls", "--json", "--all")))
	got := byID(second.tasksOf(second.mustRun("ls", "--json", "--all")))
	if len(want) != len(got) {
		t.Fatalf("the second store holds %d tasks, want %d", len(got), len(want))
	}
	for id, wantTask := range want {
		gotTask, ok := got[id]
		if !ok {
			t.Errorf("task %s did not survive the round trip", id)
			continue
		}
		wantJSON, _ := json.Marshal(wantTask)
		gotJSON, _ := json.Marshal(gotTask)
		if string(wantJSON) != string(gotJSON) {
			t.Errorf("task %s differs after the round trip:\nwant %s\ngot  %s",
				id, abbreviate(string(wantJSON)), abbreviate(string(gotJSON)))
		}
	}

	// The CSV form is documented as lossless too, so it has to at least carry
	// every row.
	csv := h.mustRun("export", "--csv", "--all")
	if lines := strings.Count(strings.TrimRight(csv.stdout, "\n"), "\n"); lines < len(want) {
		t.Errorf("the CSV export has %d data lines, want at least %d", lines, len(want))
	}
}

// byID indexes a task list by its id.
func byID(tasks []map[string]any) map[string]map[string]any {
	out := make(map[string]map[string]any, len(tasks))
	for _, task := range tasks {
		out[fmt.Sprint(task["id"])] = task
	}
	return out
}

// abbreviate keeps a failure message readable when the value under test is
// ten thousand characters long.
func abbreviate(s string) string {
	const limit = 120
	if len(s) <= limit {
		return s
	}
	return s[:limit] + fmt.Sprintf("…(%d bytes total)", len(s))
}
