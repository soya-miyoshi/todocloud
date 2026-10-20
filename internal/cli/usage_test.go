package cli

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/soya-miyoshi/todocloud/internal/exit"
)

// Exit code 2 is the documented class for "the user got the command line
// wrong" (docs/agents.md). urfave reports a parse failure as a plain error,
// which would be classified as a generic failure, so these cases are pinned.
func TestCommandLineMistakesExitWithTheUsageCode(t *testing.T) {
	h := newHarness(t)

	tests := []struct {
		name string
		args []string
	}{
		{"unknown flag on a subcommand", []string{"add", "x", "--nope"}},
		{"unknown global flag", []string{"--nope", "ls"}},
		{"a flag that should never exist", []string{"add", "x", "--token", "TOKEN_GOES_HERE"}},
		{"unknown command", []string{"frobnicate"}},
		{"unknown command with arguments", []string{"frobnicate", "x"}},
		{"missing value for a flag", []string{"add", "x", "--due"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := h.run(tc.args...)
			if got.code != exit.Usage {
				t.Errorf("exit code = %d, want %d\nstdout: %q\nstderr: %q", got.code, exit.Usage, got.stdout, got.stderr)
			}
			if got.stdout != "" {
				t.Errorf("stdout = %q, want nothing: a failure without --json writes to stderr", got.stdout)
			}
		})
	}
}

// The same mistakes must produce the documented envelope on stdout, with the
// usage code, so an agent can tell a bad command line from a missing task.
func TestCommandLineMistakesRenderTheJSONEnvelope(t *testing.T) {
	h := newHarness(t)

	for _, args := range [][]string{
		{"add", "x", "--nope", "--json"},
		{"frobnicate", "--json"},
	} {
		got := h.run(args...)
		if got.code != exit.Usage {
			t.Errorf("%v: exit code = %d, want %d", args, got.code, exit.Usage)
		}

		var envelope struct {
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal([]byte(got.stdout), &envelope); err != nil {
			t.Fatalf("%v: stdout is not the error envelope: %v\nstdout: %q", args, err, got.stdout)
		}
		if envelope.Error.Code != exit.CodeUsage {
			t.Errorf("%v: error code = %q, want %q", args, envelope.Error.Code, exit.CodeUsage)
		}
		if strings.TrimSpace(envelope.Error.Message) == "" {
			t.Errorf("%v: the envelope carries no message", args)
		}
	}
}

// A mistyped command must say so rather than print a help topic, which is what
// urfave does by default.
func TestUnknownCommandNamesItself(t *testing.T) {
	h := newHarness(t)
	got := h.run("frobnicate")
	if !strings.Contains(got.stderr, `unknown command "frobnicate"`) {
		t.Errorf("stderr = %q, want it to name the unknown command", got.stderr)
	}
}

// Help is not a failure.
func TestHelpSucceeds(t *testing.T) {
	h := newHarness(t)
	for _, args := range [][]string{{"--help"}, {"add", "--help"}} {
		if got := h.run(args...); got.code != exit.OK {
			t.Errorf("%v: exit code = %d, want 0\nstderr: %q", args, got.code, got.stderr)
		}
	}
}
