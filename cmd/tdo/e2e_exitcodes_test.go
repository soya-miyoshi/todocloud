package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The exit codes are the part of the contract a script branches on, and they
// are produced by os.Exit in main — which only a subprocess can observe. This
// is the whole table in one place, one assertion each.

func TestTheExitCodeContractThroughTheRealProcess(t *testing.T) {
	t.Parallel()

	// Two tasks whose ids share a long prefix, so that the prefix is
	// genuinely ambiguous rather than merely unlucky.
	const (
		sharedPrefix = "01J00000000000000000000"
		idA          = sharedPrefix + "00A"
		idB          = sharedPrefix + "00B"
		// An import file carries its own timestamps; they are part of a task,
		// so a hand-written seed has to supply them.
		seedStamp = "2026-01-01T00:00:00Z"
	)

	cases := []struct {
		name string
		// initialized says whether the store exists before the command runs.
		initialized bool
		// seed adds the two ambiguous tasks.
		seedAmbiguous bool
		env           []string
		args          []string
		want          int
		wantJSONCode  string
	}{
		{name: "success", initialized: true, args: []string{"ls", "--json"}, want: 0},
		{name: "unknown flag", initialized: true, args: []string{"ls", "--nope", "--json"}, want: 2, wantJSONCode: "usage"},
		{name: "unknown command", initialized: true, args: []string{"frobnicate", "--json"}, want: 2, wantJSONCode: "usage"},
		{name: "priority out of range", initialized: true, args: []string{"add", "--json", "x", "--priority", "9"}, want: 2, wantJSONCode: "usage"},
		{name: "reserved set name", initialized: true, args: []string{"add", "--json", "x", "--set", "id=nope"}, want: 2, wantJSONCode: "usage"},
		{name: "uninitialized store", initialized: false, args: []string{"ls", "--json"}, want: 3, wantJSONCode: "config"},
		{name: "unimplemented provider", initialized: true, args: []string{"--provider", "turso", "ls", "--json"}, want: 3, wantJSONCode: "config"},
		{name: "unknown reference", initialized: true, args: []string{"show", "--json", "01JZZZZZZZZZZZZZZZZZZZZZZZ"}, want: 5, wantJSONCode: "not_found"},
		{name: "ambiguous prefix", initialized: true, seedAmbiguous: true, args: []string{"show", "--json", sharedPrefix}, want: 6, wantJSONCode: "ambiguous_id"},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			h := newHarness(t)
			if tc.initialized {
				h.mustRun("init")
			}
			if tc.seedAmbiguous {
				archive := filepath.Join(h.root, "ambiguous.json")
				data, err := json.Marshal(map[string]any{"version": 1, "tasks": []map[string]any{
					{"id": idA, "title": "first", "created_at": seedStamp, "updated_at": seedStamp},
					{"id": idB, "title": "second", "created_at": seedStamp, "updated_at": seedStamp},
				}})
				if err != nil {
					t.Fatalf("encoding the seed: %v", err)
				}
				if err := os.WriteFile(archive, data, 0o600); err != nil {
					t.Fatalf("writing the seed: %v", err)
				}
				h.mustRun("import", "--json", archive)
			}

			res := h.run(tc.args...)
			if res.code != tc.want {
				t.Fatalf("exit %d, want %d:\n%s", res.code, tc.want, res.describe())
			}
			if tc.wantJSONCode == "" {
				return
			}
			envelope := h.decode(res)
			errObj, ok := envelope["error"].(map[string]any)
			if !ok {
				t.Fatalf("no error envelope on stdout:\n%s", res.describe())
			}
			if got := errObj["code"]; got != tc.wantJSONCode {
				t.Errorf("error code = %#v, want %q:\n%s", got, tc.wantJSONCode, res.describe())
			}
			// No message may carry anything that looks like a credential, and
			// the prose stays off stderr under --json.
			if msg, _ := errObj["message"].(string); strings.Contains(msg, "TOKEN_GOES_HERE") {
				t.Errorf("the error message echoed a token-shaped value: %q", msg)
			}
		})
	}
}

// TestASecretInTheEnvironmentNeverReachesTheOutput checks the one place a
// subprocess test can look that an in-process one cannot: the real streams of
// a process whose environment holds a token.
func TestASecretInTheEnvironmentNeverReachesTheOutput(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	h.mustRun("init")

	const placeholder = "TOKEN_GOES_HERE"
	env := append([]string{}, h.env...)
	for i, kv := range env {
		if strings.HasPrefix(kv, "TODOCLOUD_TURSO_TOKEN=") {
			env[i] = "TODOCLOUD_TURSO_TOKEN=" + placeholder
		}
		if strings.HasPrefix(kv, "TODOCLOUD_D1_TOKEN=") {
			env[i] = "TODOCLOUD_D1_TOKEN=" + placeholder
		}
	}

	for _, args := range [][]string{
		{"config", "--json"},
		{"config"},
		{"config", "--debug"},
		{"doctor", "--json"},
		{"doctor", "--debug"},
		{"version", "--json"},
	} {
		res := h.runWithEnv(env, nil, args...)
		if strings.Contains(res.stdout, placeholder) || strings.Contains(res.stderr, placeholder) {
			t.Errorf("tdo %s printed the token from the environment:\n%s", strings.Join(args, " "), res.describe())
		}
	}
}

// TestLoginRefusesBeforeTouchingAnything is the only login path this suite
// goes near, and it is the one that refuses on sight: sqlite needs no
// credential, so it is a usage error, and with PATH pointing at an empty
// directory no provider CLI could have been reached even if it had tried.
func TestLoginRefusesBeforeTouchingAnything(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	h.mustRun("init")

	before := snapshotDir(t, h.data)
	res := h.run("login", "--json")
	if res.code != 2 {
		t.Errorf("tdo login for sqlite exited %d, want 2:\n%s", res.code, res.describe())
	}
	after := snapshotDir(t, h.data)
	if len(added(before, after)) != 0 || len(removed(before, after)) != 0 {
		t.Errorf("tdo login changed the data directory\nbefore %v\nafter %v", before, after)
	}
}
