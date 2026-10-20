package cli

import (
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

// Values that read like attacks on something — a SQL statement, a format
// string, a template, a path, a terminal — are nothing but data to this tool.
// These tests assert they survive add -> show --json -> export -> import into
// a second store byte for byte, that they do not break the table, and that the
// filters still match them.

// hostileValues are the strings every test below runs through the CLI.
var hostileValues = map[string]string{
	"sql":          `'; DROP TABLE tasks; --`,
	"sql comment":  `" OR 1=1 --`,
	"format":       `%s %d %#v %%`,
	"template":     `{{.}} {{range .Tasks}}{{end}}`,
	"path":         `../../etc/passwd`,
	"nul":          "before\x00after",
	"ansi":         "\x1b[31mred\x1b[0m\x1b]0;title\x07",
	"carriage":     "first\rsecond",
	"long":         strings.Repeat("A", 10000),
	"json object":  `{"id":"forged","status":"done"}`,
	"json array":   `[1,2,3]`,
	"backslashes":  `C:\temp\%_\\`,
	"like wilds":   `100%_x`,
	"quotes":       `he said "it's" fine`,
	"unicode":      "絵文字 🙂 ja/en mixed",
	"leading dash": "--not-a-flag",
}

// addHostileTask adds one task carrying value in the title, the note, a tag
// and a user-defined field, and returns its id.
func (h *harness) addHostileTask(value string) string {
	h.t.Helper()
	// The flags take their values with = and the title comes after --, so a
	// value that begins with a dash is still read as data.
	res := h.mustRun("add",
		"--note="+value,
		"--tag=plain",
		"--set=attr="+value,
		"--json",
		"--", value)
	task := h.taskOf(res)
	id, _ := task["id"].(string)
	if id == "" {
		h.t.Fatalf("no id in %q", res.stdout)
	}
	return id
}

func TestHostileValuesAreStoredAsData(t *testing.T) {
	for name, value := range hostileValues {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t)
			taskID := h.addHostileTask(value)

			shown := h.taskOf(h.mustRun("show", taskID, "--json"))
			// The title is what `add` built from its arguments, so it is the
			// value with the surrounding whitespace trimmed.
			if shown["title"] != strings.TrimSpace(value) {
				t.Errorf("title: got %q", shown["title"])
			}
			if shown["note"] != value {
				t.Errorf("note: got %q", shown["note"])
			}
			// --set runs the value through task.ParseValue, so a value that
			// is JSON is stored as that JSON, not as the text; everything
			// here that is not JSON must come back unchanged.
			switch name {
			case "json object", "json array":
				if _, ok := shown["attr"].(string); ok {
					t.Errorf("a JSON value should have been parsed, got the string %q", shown["attr"])
				}
			default:
				if shown["attr"] != value {
					t.Errorf("attr: got %q", shown["attr"])
				}
			}

			// The store is intact: a would-be injection did not drop the
			// table, and the task is still the only row.
			listed := h.tasksOf(h.mustRun("ls", "--all", "--json"))
			if len(listed) != 1 {
				t.Fatalf("store holds %d task(s), want 1", len(listed))
			}
		})
	}
}

func TestHostileValuesSurviveExportAndImportIntoASecondStore(t *testing.T) {
	for name, value := range hostileValues {
		t.Run(name, func(t *testing.T) {
			source := newHarness(t)
			taskID := source.addHostileTask(value)
			before := source.taskOf(source.mustRun("show", taskID, "--json"))

			exported := source.mustRun("export", "--all")
			file := filepath.Join(t.TempDir(), "export.json")
			if err := os.WriteFile(file, []byte(exported.stdout), 0o600); err != nil {
				t.Fatalf("write: %v", err)
			}

			target := newHarness(t)
			if got := target.run("import", file); got.code != 0 {
				t.Fatalf("import: exit %d\nstderr: %s", got.code, got.stderr)
			}
			after := target.taskOf(target.mustRun("show", taskID, "--json"))

			for _, key := range []string{"id", "title", "note", "attr", "done", "status", "created_at", "updated_at"} {
				if !reflect.DeepEqual(before[key], after[key]) {
					t.Errorf("%s changed over export/import: %q -> %q", key, before[key], after[key])
				}
			}
			// Also compare the CSV form, which has a second parser.
			csvOut := source.mustRun("export", "--all", "--csv")
			csvFile := filepath.Join(t.TempDir(), "export.csv")
			if err := os.WriteFile(csvFile, []byte(csvOut.stdout), 0o600); err != nil {
				t.Fatalf("write: %v", err)
			}
			third := newHarness(t)
			if got := third.run("import", csvFile); got.code != 0 {
				t.Fatalf("csv import: exit %d\nstderr: %s", got.code, got.stderr)
			}
			fromCSV := third.taskOf(third.mustRun("show", taskID, "--json"))
			for _, key := range []string{"id", "title", "note", "attr", "done", "status"} {
				if !reflect.DeepEqual(before[key], fromCSV[key]) {
					t.Errorf("%s changed over the CSV round trip: %q -> %q", key, before[key], fromCSV[key])
				}
			}
		})
	}
}

func TestHostileValuesStillMatchTheFilters(t *testing.T) {
	for name, value := range hostileValues {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t)
			h.addHostileTask(value)
			h.mustRun("add", "an unrelated task", "--set", "attr=something else")

			// --where on the user-defined field. A value that ParseValue
			// turns into JSON is not a string field any more, so only the
			// textual values are matched this way.
			switch name {
			case "json object", "json array":
			default:
				matched := h.tasksOf(h.mustRun("ls", "--all", "--where", "attr="+value, "--json"))
				if len(matched) != 1 {
					t.Errorf("--where attr=<value> matched %d task(s), want 1", len(matched))
				}
			}
			// --where on the title, which is a required field.
			byTitle := h.tasksOf(h.mustRun("ls", "--all", "--where", "title="+strings.TrimSpace(value), "--json"))
			if len(byTitle) != 1 {
				t.Errorf("--where title=<value> matched %d task(s), want 1", len(byTitle))
			}
			// --tag still works on a task that carries such a value.
			tagged := h.tasksOf(h.mustRun("ls", "--all", "--tag", "plain", "--json"))
			if len(tagged) != 1 {
				t.Errorf("--tag matched %d task(s), want 1", len(tagged))
			}
		})
	}
}

// A hostile value must not break the table: one row per task, the short
// numbers in order, and the 80-column budget respected.
func TestHostileValuesDoNotBreakTheTable(t *testing.T) {
	h := newHarness(t)
	for _, value := range hostileValues {
		h.mustRun("add", "--tag=plain", "--", value)
	}

	res := h.mustRun("ls", "--all")
	lines := strings.Split(strings.TrimRight(res.stdout, "\n"), "\n")
	if len(lines) != len(hostileValues)+1 {
		t.Fatalf("the table has %d line(s) for %d task(s) and a header:\n%q",
			len(lines), len(hostileValues), res.stdout)
	}
	if !strings.HasPrefix(lines[0], "#") {
		t.Fatalf("the first line is not the header: %q", lines[0])
	}
	for i, line := range lines[1:] {
		if !strings.HasPrefix(line, strconv.Itoa(i+1)+" ") {
			t.Errorf("row %d does not start with its short number: %q", i+1, line)
		}
		if n := len([]rune(line)); n > 80 {
			t.Errorf("row %d is %d columns wide: %q", i+1, n, line)
		}
	}
}

// A control character in a title is data, and the human renderer must not let
// it act. An ESC would colour the rest of the display, a CR would overwrite
// the row above, and a NUL or a BEL would make the output lie about what is
// stored — so they are escaped. Machine output is untouched: JSON escapes them
// itself, and `--json` is what a caller parses.
func TestTableEscapesControlCharacters(t *testing.T) {
	h := newHarness(t)
	h.mustRun("add", "--", "\x1b[31mred\x1b[0m")
	h.mustRun("add", "--", "first\rsecond")
	h.mustRun("add", "--", "bell\x07and\x00nul")

	res := h.mustRun("ls", "--all")
	for _, raw := range []string{"\x1b", "\r", "\x07", "\x00"} {
		if strings.Contains(res.stdout, raw) {
			t.Errorf("the table passed %q through to the terminal:\n%q", raw, res.stdout)
		}
	}
	for _, escaped := range []string{`\e[31m`, `\r`, `\x07`, `\x00`} {
		if !strings.Contains(res.stdout, escaped) {
			t.Errorf("the table does not show %s:\n%q", escaped, res.stdout)
		}
	}

	// `show` renders the same value the same way.
	detail := h.mustRun("show", "1")
	if strings.Contains(detail.stdout, "\x1b") {
		t.Errorf("show passed an escape sequence through:\n%q", detail.stdout)
	}

	// The stored value is unchanged: only the rendering escapes.
	stored := h.decode(h.mustRun("show", "1", "--json"))
	task, _ := stored["task"].(map[string]any)
	if title, _ := task["title"].(string); !strings.Contains(title, "\x1b[31m") {
		t.Errorf("the stored title was altered: %q", title)
	}
}
