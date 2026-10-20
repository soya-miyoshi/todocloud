package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/soya-miyoshi/todocloud/internal/exit"
	"github.com/soya-miyoshi/todocloud/internal/id"
)

// An import file is something a user can hand-edit and a program can generate,
// so it is untrusted input. Ids must still be ULIDs: reference resolution
// matches by prefix and listings rely on ids sorting into creation order.
func TestImportRejectsAnIDThatIsNotAULID(t *testing.T) {
	h := newHarness(t)
	file := filepath.Join(t.TempDir(), "tasks.json")
	body := `{"tasks":[{"id":"../../etc/passwd","title":"forged","done":false,` +
		`"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}]}`
	if err := os.WriteFile(file, []byte(body), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	got := h.run("import", file)
	if got.code != exit.Usage {
		t.Errorf("exit code = %d, want %d\nstderr: %s", got.code, exit.Usage, got.stderr)
	}
	if !strings.Contains(got.stderr, "--new-ids") {
		t.Errorf("the error does not offer the way forward: %q", got.stderr)
	}

	// Nothing may have been stored.
	listed := h.run("ls", "--all", "--json")
	var out struct{ Count int }
	if err := json.Unmarshal([]byte(listed.stdout), &out); err != nil {
		t.Fatalf("ls: %v", err)
	}
	if out.Count != 0 {
		t.Errorf("%d task(s) were stored despite the rejection", out.Count)
	}
}

// --new-ids is how data from another tool gets in: the ids are replaced rather
// than trusted.
func TestImportWithNewIDsAssignsRealULIDs(t *testing.T) {
	h := newHarness(t)
	file := filepath.Join(t.TempDir(), "tasks.json")
	body := `{"tasks":[` +
		`{"id":"1","title":"from another tool","done":false,` +
		`"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","client":"acme"},` +
		`{"id":"2","title":"and another","done":false,` +
		`"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}]}`
	if err := os.WriteFile(file, []byte(body), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	got := h.run("import", file, "--new-ids", "--json")
	if got.code != 0 {
		t.Fatalf("exit %d, want 0\nstderr: %s", got.code, got.stderr)
	}

	listed := h.run("ls", "--all", "--json")
	var out struct {
		Tasks []map[string]any `json:"tasks"`
	}
	if err := json.Unmarshal([]byte(listed.stdout), &out); err != nil {
		t.Fatalf("ls: %v", err)
	}
	if len(out.Tasks) != 2 {
		t.Fatalf("stored %d task(s), want 2", len(out.Tasks))
	}
	for _, stored := range out.Tasks {
		got, _ := stored["id"].(string)
		if !id.Valid(got) {
			t.Errorf("stored id %q is not a ULID", got)
		}
	}
	// The user-defined field must survive re-identification.
	if out.Tasks[0]["client"] != "acme" && out.Tasks[1]["client"] != "acme" {
		t.Errorf("the user-defined field was lost: %v", out.Tasks)
	}
}

// A file `tdo export` wrote must keep working untouched, ids included.
func TestImportKeepsExportedIDs(t *testing.T) {
	h := newHarness(t)
	h.mustRun("add", "Pay the invoice")
	exported := h.run("export", "--all")
	if exported.code != 0 {
		t.Fatalf("export failed: %s", exported.stderr)
	}
	file := filepath.Join(t.TempDir(), "export.json")
	if err := os.WriteFile(file, []byte(exported.stdout), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	// Importing into the same store is a no-op, which proves the ids were
	// kept rather than regenerated.
	got := h.run("import", file, "--json")
	if got.code != 0 {
		t.Fatalf("exit %d, want 0\nstderr: %s", got.code, got.stderr)
	}
	var out struct {
		Imported int `json:"imported"`
		Skipped  int `json:"skipped"`
	}
	if err := json.Unmarshal([]byte(got.stdout), &out); err != nil {
		t.Fatalf("import: %v", err)
	}
	if out.Imported != 0 || out.Skipped != 1 {
		t.Errorf("imported=%d skipped=%d, want 0 and 1: the exported id was not kept", out.Imported, out.Skipped)
	}
}
