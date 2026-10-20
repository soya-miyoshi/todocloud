package cli

import (
	"testing"

	"github.com/soya-miyoshi/todocloud/internal/exit"
)

// docs/agents.md tells a caller to put a dash-leading title after `--` and
// every flag before it. Both halves of that sentence are load-bearing: a flag
// placed after the separator becomes part of the title, which is the kind of
// thing an agent would otherwise discover by storing a task called
// "--not-a-flag --json".
func TestTheArgumentSeparatorBehavesAsDocumented(t *testing.T) {
	h := newHarness(t)

	// Flags before the separator: the flag applies, the value is the title.
	added := h.taskOf(h.mustRun("add", "--json", "--priority", "2", "--", "--not-a-flag"))
	if added["title"] != "--not-a-flag" {
		t.Errorf("title = %v, want the dash-leading value", added["title"])
	}
	if added["priority"] != float64(2) {
		t.Errorf("priority = %v, want 2: the flag before `--` did not apply", added["priority"])
	}

	// A flag after the separator is an argument, and `add` joins its arguments
	// into the title.
	res := h.mustRun("add", "--", "--leading-dash", "--json")
	if res.code != 0 {
		t.Fatalf("exit %d, want 0\nstderr: %s", res.code, res.stderr)
	}
	if res.stdout == "" || res.stdout[0] == '{' {
		t.Errorf("the trailing --json was honoured as a flag; it should be part of the title:\n%q", res.stdout)
	}

	// Without the separator it is a usage error, not a surprise.
	if got := h.run("add", "--not-a-flag"); got.code != exit.Usage {
		t.Errorf("exit code = %d, want %d", got.code, exit.Usage)
	}
}
