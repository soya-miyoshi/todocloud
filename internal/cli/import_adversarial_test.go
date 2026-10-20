package cli

import (
	"encoding/csv"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/soya-miyoshi/todocloud/internal/exit"
)

// An import file is the one place where the CLI parses a whole document from
// an untrusted source. These tests drive the real command and assert three
// things for every rejection: the documented exit code, that nothing was
// stored, and that the message is a sentence rather than a stack trace or a
// driver complaint.

// validTaskJSON is one well-formed task, as `tdo export` writes it.
const validTaskJSON = `{"id":"01J3ABCDEFGHJKMNPQRSTVWXYZ","kind":"task","title":"Pay the invoice",` +
	`"status":"active","created_at":"2026-10-20T04:11:00Z","updated_at":"2026-10-20T04:11:00Z"}`

// writeImportFile writes body to a file of its own and returns the path.
func writeImportFile(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "import.json")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	return path
}

// storedCount returns how many tasks the store holds, tombstones included.
func (h *harness) storedCount() int {
	h.t.Helper()
	// export is the only listing that holds everything, tombstones included.
	res := h.mustRun("export", "--all", "--json")
	obj := h.decode(res)
	n, ok := obj["count"].(float64)
	if !ok {
		h.t.Fatalf("no count in %q", res.stdout)
	}
	return int(n)
}

// assertCleanFailure checks the message a rejection printed: a user-facing
// sentence, with no stack trace and no driver internals.
func assertCleanFailure(t *testing.T, stderr string) {
	t.Helper()
	if strings.TrimSpace(stderr) == "" {
		t.Error("the rejection printed nothing on stderr")
	}
	for _, leak := range []string{
		"goroutine ", "panic:", ".go:", "runtime error",
		"modernc.org", "SQLITE_", "no such table", "github.com/",
	} {
		if strings.Contains(stderr, leak) {
			t.Errorf("the error leaks %q: %s", leak, stderr)
		}
	}
}

// TestImportRejectsBadFilesWholesale walks the malformed inputs an agent or a
// spreadsheet can produce. Every one of them is a usage error, and none of
// them may leave a task behind: import is not transactional, but each of these
// is rejected before the first write.
func TestImportRejectsBadFilesWholesale(t *testing.T) {
	cases := []struct {
		name string
		body string
	}{
		{"malformed json", `{"tasks":[` + validTaskJSON},
		{"json that is not a task list", `{"provider":"sqlite"}`},
		{"json array of scalars", `[1,2,3]`},
		{"json scalar", `42`},
		{"tasks is a string", `{"tasks":"all of them"}`},
		{"tasks is an object", `{"tasks":{"one":{}}}`},
		{"empty file", ""},
		{"whitespace only", "  \n\t\r\n"},
		{"missing title", `{"tasks":[{"id":"01J3ABCDEFGHJKMNPQRSTVWXYZ","done":false,` +
			`"created_at":"2026-10-20T04:11:00Z","updated_at":"2026-10-20T04:11:00Z"}]}`},
		{"blank title", strings.Replace(`{"tasks":[`+validTaskJSON+`]}`, `"Pay the invoice"`, `"   "`, 1)},
		{"garbage created_at", strings.Replace(`{"tasks":[`+validTaskJSON+`]}`,
			`"created_at":"2026-10-20T04:11:00Z"`, `"created_at":"last tuesday"`, 1)},
		{"missing created_at", `{"tasks":[{"id":"01J3ABCDEFGHJKMNPQRSTVWXYZ","title":"x","done":false,` +
			`"updated_at":"2026-10-20T04:11:00Z"}]}`},
		{"priority out of range", strings.Replace(`{"tasks":[`+validTaskJSON+`]}`,
			`"status":"active"`, `"done":false,"priority":99`, 1)},
		{"a due date that is not a date", strings.Replace(`{"tasks":[`+validTaskJSON+`]}`,
			`"status":"active"`, `"status":"active","due_at":"not a date"`, 1)},
		{"a status that is not one of the four", strings.Replace(`{"tasks":[`+validTaskJSON+`]}`,
			`"status":"active"`, `"status":"yes"`, 1)},
		{"a kind that is not one of the three", strings.Replace(`{"tasks":[`+validTaskJSON+`]}`,
			`"kind":"task"`, `"kind":"milestone"`, 1)},
		{"a review interval on a task", strings.Replace(`{"tasks":[`+validTaskJSON+`]}`,
			`"status":"active"`, `"status":"active","review_interval":{"every":"1w"}`, 1)},
		{"a repeat with no interval", strings.Replace(`{"tasks":[`+validTaskJSON+`]}`,
			`"status":"active"`, `"status":"active","repeat":{"method":"fixed","every":""}`, 1)},
		{"id is not a ulid", strings.Replace(`{"tasks":[`+validTaskJSON+`]}`,
			`"01J3ABCDEFGHJKMNPQRSTVWXYZ"`, `"not-an-id"`, 1)},
		{"nul byte in the id", strings.Replace(`{"tasks":[`+validTaskJSON+`]}`,
			`"01J3ABCDEFGHJKMNPQRSTVWXYZ"`, `"01J3ABCDEFGHJKMNPQRSTVWXY\u0000"`, 1)},

		// CSV.
		{"csv with no header", "\n"},
		{"csv missing a required column", "id,title\n01J3ABCDEFGHJKMNPQRSTVWXYZ,x\n"},
		{"csv with the wrong column count", csvHeaderLine() +
			"01J3ABCDEFGHJKMNPQRSTVWXYZ,task,x\n"},
		{"csv with a bad flagged cell", csvLine(map[string]string{
			"id": "01J3ABCDEFGHJKMNPQRSTVWXYZ", "title": "x", "flagged": "maybe",
			"created_at": "2026-10-20T04:11:00Z", "updated_at": "2026-10-20T04:11:00Z"})},
		{"csv with invalid json in fields", csvLine(map[string]string{
			"id": "01J3ABCDEFGHJKMNPQRSTVWXYZ", "title": "x", "fields": "{not json}",
			"created_at": "2026-10-20T04:11:00Z", "updated_at": "2026-10-20T04:11:00Z"})},
		{"csv with an unclosed quoted field", csvHeaderLine() +
			"01J3ABCDEFGHJKMNPQRSTVWXYZ,task,\"x,active,2026-10-20T04:11:00Z\n"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			got := h.run("import", writeImportFile(t, tc.body))
			if got.code != exit.Usage {
				t.Errorf("exit code = %d, want %d\nstderr: %s", got.code, exit.Usage, got.stderr)
			}
			assertCleanFailure(t, got.stderr)
			if n := h.storedCount(); n != 0 {
				t.Errorf("%d task(s) were stored despite the rejection", n)
			}
			if got.stdout != "" {
				t.Errorf("a rejection wrote to stdout: %q", got.stdout)
			}
		})
	}
}

// csvHeaderLine is the header `tdo export --csv` writes.
func csvHeaderLine() string {
	return strings.Join(csvHeader, ",") + "\n"
}

// csvLine builds a header and one row from the columns a case cares about,
// so a test says what it is testing instead of counting commas.
func csvLine(cells map[string]string) string {
	var row strings.Builder
	w := csv.NewWriter(&row)
	record := make([]string, 0, len(csvHeader))
	for _, column := range csvHeader {
		record = append(record, cells[column])
	}
	if err := w.Write(record); err != nil {
		panic(err)
	}
	w.Flush()
	return csvHeaderLine() + row.String()
}

// A file that is a directory, one that cannot be read and /dev/null are all
// reported as usage errors, because the path came from the command line.
func TestImportOnFilesThatCannotBeRead(t *testing.T) {
	h := newHarness(t)

	dir := t.TempDir()
	unreadable := filepath.Join(dir, "locked.json")
	if err := os.WriteFile(unreadable, []byte(`{"tasks":[]}`), 0o000); err != nil {
		t.Fatalf("write: %v", err)
	}
	missing := filepath.Join(dir, "absent.json")

	for name, path := range map[string]string{
		"a directory":        dir,
		"an unreadable file": unreadable,
		"a missing file":     missing,
	} {
		t.Run(name, func(t *testing.T) {
			got := h.run("import", path)
			if got.code != exit.Usage {
				t.Errorf("exit code = %d, want %d\nstderr: %s", got.code, exit.Usage, got.stderr)
			}
			assertCleanFailure(t, got.stderr)
		})
	}
	if n := h.storedCount(); n != 0 {
		t.Errorf("%d task(s) were stored", n)
	}

	// /dev/null reads as an empty file, which is the empty-file rejection.
	got := h.run("import", os.DevNull)
	if got.code != exit.Usage {
		t.Errorf("%s: exit code = %d, want %d\nstderr: %s", os.DevNull, got.code, exit.Usage, got.stderr)
	}
	assertCleanFailure(t, got.stderr)

	// No argument, and more than one, are usage errors too.
	for _, args := range [][]string{{"import"}, {"import", missing, missing}} {
		if got := h.run(args...); got.code != exit.Usage {
			t.Errorf("tdo %s: exit code = %d, want %d", strings.Join(args, " "), got.code, exit.Usage)
		}
	}
}

// A JSON null in the tasks array is input, not a crash. It is rejected with a
// usage error naming the position, and — because the whole file is validated
// before the first write — a null after a valid task leaves nothing behind.
func TestImportRejectsANullTaskWithoutStoringAnything(t *testing.T) {
	cases := map[string]string{
		"leading null":   `{"tasks":[null]}`,
		"bare array":     `[null]`,
		"null after one": `{"tasks":[` + validTaskJSON + `,null]}`,
	}
	for name, body := range cases {
		body := body
		t.Run(name, func(t *testing.T) {
			h := newHarness(t)
			path := writeImportFile(t, body)

			got := h.run("import", path)
			if got.code != exit.Usage {
				t.Fatalf("exit code = %d, want %d\nstdout: %q\nstderr: %q", got.code, exit.Usage, got.stdout, got.stderr)
			}
			if !strings.Contains(got.stderr, "null") {
				t.Errorf("the error does not say what was wrong: %q", got.stderr)
			}
			if strings.Contains(got.stderr, "goroutine ") || strings.Contains(got.stderr, "panic:") {
				t.Errorf("a panic reached the user: %q", got.stderr)
			}
			if n := h.storedCount(); n != 0 {
				t.Errorf("%d task(s) were stored from a rejected file, want 0", n)
			}
		})
	}
}

// Importing the same id twice in one file is not an error: the second
// occurrence is skipped, exactly as re-importing a file is.
func TestImportSkipsDuplicateIDsWithinOneFile(t *testing.T) {
	h := newHarness(t)
	body := `{"tasks":[` + validTaskJSON + `,` +
		strings.Replace(validTaskJSON, `"Pay the invoice"`, `"the same id again"`, 1) + `]}`

	got := h.run("import", writeImportFile(t, body), "--json")
	if got.code != 0 {
		t.Fatalf("exit %d, want 0\nstderr: %s", got.code, got.stderr)
	}
	obj := h.decode(got)
	if obj["imported"] != float64(1) || obj["skipped"] != float64(1) {
		t.Errorf("imported/skipped = %v/%v, want 1 and 1", obj["imported"], obj["skipped"])
	}
	if n := h.storedCount(); n != 1 {
		t.Errorf("stored %d task(s), want 1", n)
	}
	// The first occurrence is the one that was kept.
	listed := h.tasksOf(h.mustRun("ls", "--all", "--json"))
	if listed[0]["title"] != "Pay the invoice" {
		t.Errorf("the second occurrence overwrote the first: %v", listed[0]["title"])
	}
}

// A reserved name in the file is read as the required field it names, never as
// a user-defined one, so a crafted file cannot smuggle a second `id` or
// `created_at` into Fields.
func TestImportTreatsReservedNamesAsRequiredFields(t *testing.T) {
	h := newHarness(t)
	body := `{"tasks":[{"id":"01J3ABCDEFGHJKMNPQRSTVWXYZ","title":"reserved names",` +
		`"status":"done","created_at":"2026-10-20T04:11:00Z","updated_at":"2026-10-20T04:11:00Z",` +
		`"completed_at":"2026-10-20T05:00:00Z","deleted_at":null}]}`
	if got := h.run("import", writeImportFile(t, body)); got.code != 0 {
		t.Fatalf("exit %d, want 0\nstderr: %s", got.code, got.stderr)
	}

	stored := h.tasksOf(h.mustRun("ls", "--all", "--json"))[0]
	if stored["id"] != "01J3ABCDEFGHJKMNPQRSTVWXYZ" || stored["done"] != true {
		t.Errorf("required fields were not read as such: %v", stored)
	}
	// A CSV fields column naming a reserved key cannot override the column of
	// the same name either.
	h2 := newHarness(t)
	csvBody := csvLine(map[string]string{
		"id": "01J3BBCDEFGHJKMNPQRSTVWXYZ", "kind": "task", "title": "real title", "status": "active",
		"created_at": "2026-10-20T04:11:00Z", "updated_at": "2026-10-20T04:11:00Z",
		"fields": `{"id":"forged","title":"forged","status":"done"}`,
	})
	if got := h2.run("import", writeImportFile(t, csvBody)); got.code != 0 {
		t.Fatalf("csv import: exit %d\nstderr: %s", got.code, got.stderr)
	}
	fromCSV := h2.tasksOf(h2.mustRun("ls", "--all", "--json"))[0]
	if fromCSV["id"] != "01J3BBCDEFGHJKMNPQRSTVWXYZ" || fromCSV["title"] != "real title" || fromCSV["done"] != false {
		t.Errorf("the fields column overrode a required column: %v", fromCSV)
	}
}

// A CSV quoted field may hold a newline, which must not be read as a row
// boundary.
func TestImportKeepsANewlineInsideAQuotedCSVField(t *testing.T) {
	h := newHarness(t)
	body := csvLine(map[string]string{
		"id": "01J3ABCDEFGHJKMNPQRSTVWXYZ", "kind": "task", "title": "two\nlines", "status": "active",
		"created_at": "2026-10-20T04:11:00Z", "updated_at": "2026-10-20T04:11:00Z",
	})
	if got := h.run("import", writeImportFile(t, body)); got.code != 0 {
		t.Fatalf("exit %d, want 0\nstderr: %s", got.code, got.stderr)
	}
	stored := h.tasksOf(h.mustRun("ls", "--all", "--json"))
	if len(stored) != 1 || stored[0]["title"] != "two\nlines" {
		t.Errorf("the embedded newline was not preserved: %v", stored)
	}
}

// A title carrying a NUL byte or bytes that are not UTF-8 is data: it is
// stored, and it comes back as the JSON encoder renders it. The NUL survives;
// the invalid bytes become U+FFFD, which is encoding/json's substitution and
// the one lossy step in the round trip.
func TestImportKeepsHostileBytesInATitle(t *testing.T) {
	h := newHarness(t)
	body := `{"tasks":[` +
		strings.Replace(validTaskJSON, `"Pay the invoice"`, `"nul\u0000inside"`, 1) + `]}`
	if got := h.run("import", writeImportFile(t, body)); got.code != 0 {
		t.Fatalf("exit %d, want 0\nstderr: %s", got.code, got.stderr)
	}
	stored := h.tasksOf(h.mustRun("ls", "--all", "--json"))[0]
	if stored["title"] != "nul\x00inside" {
		t.Errorf("the NUL byte was not preserved: %q", stored["title"])
	}

	h2 := newHarness(t)
	raw := strings.Replace(validTaskJSON, "Pay the invoice", "invalid \xff\xfe bytes", 1)
	if got := h2.run("import", writeImportFile(t, `{"tasks":[`+raw+`]}`)); got.code != 0 {
		t.Fatalf("exit %d, want 0\nstderr: %s", got.code, got.stderr)
	}
	stored2 := h2.tasksOf(h2.mustRun("ls", "--all", "--json"))[0]
	title, _ := stored2["title"].(string)
	if !strings.Contains(title, "invalid ") || !strings.Contains(title, " bytes") {
		t.Errorf("the title was mangled beyond the invalid bytes: %q", title)
	}
	if strings.Contains(title, "\xff") {
		t.Errorf("encoding/json no longer replaces the invalid bytes: %q", title)
	}
}

// A large file and a large number of tasks are accepted: there is no cap, and
// neither case may be a crash or a truncation.
func TestImportAcceptsALargeFileAndManyTasks(t *testing.T) {
	t.Run("five megabytes in one task", func(t *testing.T) {
		h := newHarness(t)
		big := strings.Repeat("A", 5<<20)
		body := `{"tasks":[` +
			strings.Replace(validTaskJSON, `"status":"active"`, `"status":"active","note":"`+big+`"`, 1) + `]}`
		if got := h.run("import", writeImportFile(t, body)); got.code != 0 {
			t.Fatalf("exit %d, want 0\nstderr: %s", got.code, got.stderr)
		}
		stored := h.tasksOf(h.mustRun("ls", "--all", "--json"))[0]
		note, _ := stored["note"].(string)
		if len(note) != len(big) {
			t.Errorf("the note came back %d bytes long, want %d", len(note), len(big))
		}
	})

	t.Run("five thousand tasks", func(t *testing.T) {
		h := newHarness(t)
		var b strings.Builder
		b.WriteString(`{"tasks":[`)
		for i := 0; i < 5000; i++ {
			if i > 0 {
				b.WriteByte(',')
			}
			fmt.Fprintf(&b, `{"id":%q,"title":"task %d","status":"active",`+
				`"created_at":"2026-10-20T04:11:00Z","updated_at":"2026-10-20T04:11:00Z"}`,
				generatedID(i), i)
		}
		b.WriteString(`]}`)

		got := h.run("import", writeImportFile(t, b.String()), "--json")
		if got.code != 0 {
			t.Fatalf("exit %d, want 0\nstderr: %s", got.code, got.stderr)
		}
		if obj := h.decode(got); obj["imported"] != float64(5000) {
			t.Fatalf("imported %v task(s), want 5000", obj["imported"])
		}
		if n := h.storedCount(); n != 5000 {
			t.Errorf("stored %d task(s), want 5000", n)
		}
	})
}

// generatedID builds the nth distinct literal ULID, in Crockford base32.
func generatedID(n int) string {
	const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
	suffix := []byte("0000000000")
	for i := len(suffix) - 1; i >= 0 && n > 0; i-- {
		suffix[i] = alphabet[n%32]
		n /= 32
	}
	return "01J3ABCDEFGHJK" + string(suffix) + "VW"
}

// Base32 is case-insensitive, so a lower-cased ULID in an import file is a
// real id written differently. It is normalised on the way in, which means the
// task is addressable by its own id afterwards and a second import of the same
// file is a skip rather than a constraint failure.
func TestImportOfALowerCasedIDIsNormalisedAndThenSkipped(t *testing.T) {
	h := newHarness(t)
	lower := "01j3abcdefghjkmnpqrstvwxyz"
	body := `{"tasks":[{"id":"` + lower + `","title":"lower","done":false,` +
		`"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}]}`
	path := writeImportFile(t, body)

	first := h.decode(h.mustRun("import", path, "--json"))
	if first["imported"] != float64(1) {
		t.Fatalf("first import: %v, want imported 1", first)
	}

	// Addressable by the id as written and by its canonical form.
	for _, ref := range []string{lower, strings.ToUpper(lower)} {
		shown := h.taskOf(h.mustRun("show", ref, "--json"))
		if shown["id"] != strings.ToUpper(lower) {
			t.Errorf("show %q returned id %v, want the canonical form", ref, shown["id"])
		}
	}

	// A second import is a skip, with no driver message anywhere near it.
	second := h.run("import", path, "--json")
	if second.code != 0 {
		t.Fatalf("second import: exit %d\nstdout: %q\nstderr: %q", second.code, second.stdout, second.stderr)
	}
	obj := h.decode(second)
	if obj["imported"] != float64(0) || obj["skipped"] != float64(1) {
		t.Errorf("second import: %v, want imported 0 and skipped 1", obj)
	}
	if strings.Contains(strings.ToUpper(second.stderr), "UNIQUE CONSTRAINT") {
		t.Errorf("the driver's constraint message reached the user: %q", second.stderr)
	}
}
