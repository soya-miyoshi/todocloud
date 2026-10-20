package cli

import (
	"strings"
	"testing"

	"github.com/soya-miyoshi/todocloud/internal/exit"
)

// `tdo export` is machine output — a JSON envelope or CSV, whether or not
// --json was passed — so nobody reads numbers off it. Taking a backup must not
// change what `tdo done 2` means for whoever is reading the terminal.
func TestExportDoesNotTouchTheNumberCache(t *testing.T) {
	h := newHarness(t)
	h.mustRun("add", "first")
	h.mustRun("add", "second")

	// A human listing assigns the numbers.
	h.mustRun("ls")
	before := h.taskOf(h.mustRun("show", "1", "--json"))

	// Several exports, in both forms and with a different row set.
	h.mustRun("export")
	h.mustRun("export", "--all")
	h.mustRun("export", "--csv")
	h.mustRun("export", "--json")

	after := h.taskOf(h.mustRun("show", "1", "--json"))
	if before["id"] != after["id"] {
		t.Errorf("export renumbered the listing: task 1 went from %v to %v", before["id"], after["id"])
	}
}

// With no human listing at all, a number has nothing to resolve against, and
// an export must not quietly give it one.
func TestExportDoesNotCreateNumbersOutOfNothing(t *testing.T) {
	h := newHarness(t)
	h.mustRun("add", "only task")
	h.mustRun("export", "--all")

	got := h.run("show", "1")
	if got.code != exit.NotFound {
		t.Errorf("exit code = %d, want %d: export should not have populated the cache\nstderr: %s", got.code, exit.NotFound, got.stderr)
	}
	if !strings.Contains(got.stderr, "tdo ls") {
		t.Errorf("the error does not point at `tdo ls`: %q", got.stderr)
	}
}

// A human listing that finds nothing must leave the numbers alone. The
// sequence that found this: `tdo ls`, then a `tdo review` with nothing due,
// then `tdo done 1` — which reported that there is no task 1, because the
// empty review listing had overwritten the cache the `ls` installed.
func TestAnEmptyListingDoesNotDiscardTheCachedNumbers(t *testing.T) {
	h := newHarness(t)
	h.mustRun("add", "the only task")

	// A human listing installs the numbers.
	h.mustRun("ls")
	if got := h.run("show", "1"); got.code != 0 {
		t.Fatalf("after `ls`, number 1 must resolve: exit %d\nstderr: %s", got.code, got.stderr)
	}

	// `review` finds nothing: nothing is a project and nothing has an
	// interval. It must not renumber anything.
	if got := h.run("review"); got.code != 0 {
		t.Fatalf("review: exit %d\nstderr: %s", got.code, got.stderr)
	}

	if got := h.run("show", "1"); got.code != 0 {
		t.Errorf("a listing that found nothing discarded the cached numbers: `show 1` exits %d\nstderr: %s",
			got.code, got.stderr)
	}
}
