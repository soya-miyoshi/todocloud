package cli

import (
	"strings"
	"testing"

	"github.com/soya-miyoshi/todocloud/internal/exit"
)

// A reference is whatever an agent or a user typed, and it is resolved in a
// fixed order: a short number from the last listing, then an id prefix, then a
// usage error. These tests pin the edges of that order and the exit code each
// one produces.

// TestResolveRefRejectsReferencesThatCannotBeOne covers the references that
// are neither a number nor a possible id prefix, which are the user's mistake
// at the command line: exit 2.
func TestResolveRefRejectsReferencesThatCannotBeOne(t *testing.T) {
	h := newHarness(t)
	h.mustRun("add", "a task")

	for name, ref := range map[string]string{
		"empty":              "",
		"whitespace":         "   ",
		"negative":           "-1",
		"nul byte":           "01J3\x00",
		"excluded letter i":  "01J3I",
		"excluded letter l":  "01J3L",
		"excluded letter o":  "01J3O",
		"excluded letter u":  "01J3U",
		"too long for an id": strings.Repeat("0", 27),
		"punctuation":        "01J3-ABC",
		"path":               "../../etc/passwd",
	} {
		t.Run(name, func(t *testing.T) {
			got := h.run("show", ref)
			if got.code != exit.Usage {
				t.Errorf("tdo show %q: exit %d, want %d\nstderr: %s", ref, got.code, exit.Usage, got.stderr)
			}
			assertCleanFailure(t, got.stderr)
		})
	}
}

// A reference that could be one but matches nothing is a not-found, exit 5 —
// not a usage error, because there is nothing wrong with how it was typed.
func TestResolveRefReportsNotFoundForUnmatchedReferences(t *testing.T) {
	h := newHarness(t)
	h.mustRun("add", "a task")
	// Clear the listing cache by listing nothing, so a number resolves to no
	// id at all.
	h.mustRun("ls", "--status", "done")

	for name, ref := range map[string]string{
		"zero":                              "0",
		"one past the listing":              "999999",
		"seven digits is a prefix":          "0000000",
		"26 characters that are not a ULID": strings.Repeat("Z", 26),
		"a prefix nothing starts with":      "ZZZZ",
	} {
		t.Run(name, func(t *testing.T) {
			got := h.run("show", ref)
			if got.code != exit.NotFound {
				t.Errorf("tdo show %q: exit %d, want %d\nstderr: %s", ref, got.code, exit.NotFound, got.stderr)
			}
			assertCleanFailure(t, got.stderr)
		})
	}
}

// Base32 is case-insensitive, so a pasted lower-cased id resolves.
func TestResolveRefAcceptsALowerCasedID(t *testing.T) {
	h := newHarness(t)
	added := h.taskOf(h.mustRun("add", "a task", "--json"))
	taskID, _ := added["id"].(string)

	shown := h.taskOf(h.mustRun("show", strings.ToLower(taskID), "--json"))
	if shown["id"] != taskID {
		t.Errorf("show %q resolved to %q", strings.ToLower(taskID), shown["id"])
	}
}

// Two tasks sharing a prefix is exit 6, and the message must not name one of
// them as though it had been chosen.
func TestResolveRefReportsAnAmbiguousPrefix(t *testing.T) {
	h := newHarness(t)
	// Imported ids are kept, so two literal ids can be made to share a
	// prefix deliberately.
	body := `{"tasks":[` +
		`{"id":"01J3ABCDEFGHJKMNPQRSTVWXYZ","title":"one","done":false,` +
		`"created_at":"2026-10-20T04:11:00Z","updated_at":"2026-10-20T04:11:00Z"},` +
		`{"id":"01J3ABCDEFGHJKMNPQRSTVWXY0","title":"two","done":false,` +
		`"created_at":"2026-10-20T04:11:00Z","updated_at":"2026-10-20T04:11:00Z"}]}`
	if got := h.run("import", writeImportFile(t, body)); got.code != 0 {
		t.Fatalf("import: exit %d\nstderr: %s", got.code, got.stderr)
	}

	got := h.run("show", "01J3ABCDEFGHJKMNPQRSTVWXY")
	if got.code != exit.Ambiguous {
		t.Fatalf("exit %d, want %d\nstderr: %s", got.code, exit.Ambiguous, got.stderr)
	}
	assertCleanFailure(t, got.stderr)
	// The full id of either task disambiguates.
	if shown := h.taskOf(h.mustRun("show", "01J3ABCDEFGHJKMNPQRSTVWXY0", "--json")); shown["title"] != "two" {
		t.Errorf("the full id resolved to %v", shown["title"])
	}
}

// A tombstone is still addressable: `rm` is reversible only because the task
// is still there to be found by its prefix.
func TestResolveRefFindsATombstonedTask(t *testing.T) {
	h := newHarness(t)
	added := h.taskOf(h.mustRun("add", "to be removed", "--json"))
	taskID, _ := added["id"].(string)
	h.mustRun("rm", taskID)

	shown := h.taskOf(h.mustRun("show", taskID[:8], "--json"))
	if shown["id"] != taskID {
		t.Fatalf("the tombstoned task did not resolve: %v", shown)
	}
	if shown["deleted_at"] == nil {
		t.Errorf("the task resolved but is not tombstoned: %v", shown)
	}
	// Once purged it is gone, and the same prefix is a not-found.
	h.mustRun("rm", taskID, "--purge", "--yes")
	if got := h.run("show", taskID[:8]); got.code != exit.NotFound {
		t.Errorf("after --purge: exit %d, want %d", got.code, exit.NotFound)
	}
}

// A reference that is both a valid short number and a valid id prefix is read
// as the number: that is the documented order in refs.go, and it is what the
// user just read off the screen. Every ULID this decade starts with "01J", so
// "01" is exactly that collision.
func TestResolveRefPrefersTheNumberOverAnIDPrefix(t *testing.T) {
	h := newHarness(t)
	first := h.taskOf(h.mustRun("add", "first", "--json"))
	h.mustRun("add", "second")
	// A human listing is what gives the numbers their meaning: `ls --json`
	// deliberately leaves the cache alone, so that a machine caller cannot
	// renumber the list under whoever is reading the terminal.
	h.mustRun("ls")

	// "01" is a number (1) and also the prefix both ids share, which would be
	// ambiguous if it were read as a prefix.
	shown := h.taskOf(h.mustRun("show", "01", "--json"))
	if shown["id"] != first["id"] {
		t.Errorf("show 01 resolved to %v, want the first row of the listing", shown["id"])
	}
	// Seven digits is past the short-number limit, so the same shape is read
	// as a prefix again — here an ambiguous one.
	if got := h.run("show", "0000001"); got.code != exit.NotFound {
		t.Errorf("a seven-digit reference: exit %d, want %d (an id prefix that matches nothing)", got.code, exit.NotFound)
	}
}

// The same task named twice in one command is applied once, whether it is
// spelled the same way both times or as a number and a prefix.
func TestResolveRefsAppliesARepeatedReferenceOnce(t *testing.T) {
	h := newHarness(t)
	added := h.taskOf(h.mustRun("add", "a task", "--json"))
	taskID, _ := added["id"].(string)
	h.mustRun("ls")

	res := h.mustRun("done", taskID, taskID, "--json")
	obj := h.decode(res)
	tasks, _ := obj["tasks"].([]any)
	if len(tasks) != 1 {
		t.Errorf("the repeated reference produced %d result(s), want 1: %s", len(tasks), res.stdout)
	}

	h.mustRun("undone", taskID)
	h.mustRun("ls")
	res = h.mustRun("done", "1", taskID[:6], "--json")
	obj = h.decode(res)
	tasks, _ = obj["tasks"].([]any)
	if len(tasks) != 1 {
		t.Errorf("a number and a prefix for one task produced %d result(s), want 1: %s", len(tasks), res.stdout)
	}
}

// A command that resolves several references resolves all of them before it
// changes anything, so one bad reference leaves the others untouched.
func TestResolveRefsIsAllOrNothing(t *testing.T) {
	h := newHarness(t)
	added := h.taskOf(h.mustRun("add", "a task", "--json"))
	taskID, _ := added["id"].(string)

	got := h.run("done", taskID, "ZZZZ")
	if got.code != exit.NotFound {
		t.Fatalf("exit %d, want %d\nstderr: %s", got.code, exit.NotFound, got.stderr)
	}
	shown := h.taskOf(h.mustRun("show", taskID, "--json"))
	if shown["done"] != false {
		t.Error("the valid reference was applied despite the failure")
	}
}
