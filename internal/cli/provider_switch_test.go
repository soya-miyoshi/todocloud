package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// runWithConfig runs the CLI against a temporary store described by a real
// config file, so the interaction between the file, the environment and
// --provider is exercised the way a user meets it.
func runWithConfig(t *testing.T, fileProvider string, env map[string]string, args ...string) result {
	t.Helper()
	dir := t.TempDir()
	db := filepath.Join(dir, "tasks.db")
	cfgPath := filepath.Join(dir, "config.toml")

	body := "provider = \"" + fileProvider + "\"\n"
	if err := os.WriteFile(cfgPath, []byte(body), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}

	base := map[string]string{
		"TODOCLOUD_CONFIG":      cfgPath,
		"TODOCLOUD_SQLITE_PATH": db,
		"TODOCLOUD_STATE_DIR":   filepath.Join(dir, "state"),
		"HOME":                  dir,
	}
	for k, v := range env {
		base[k] = v
	}
	t.Setenv("TODOCLOUD_STATE_DIR", base["TODOCLOUD_STATE_DIR"])

	run := func(args ...string) result {
		var out, errb bytes.Buffer
		e := Env{
			Stdout: &out,
			Stderr: &errb,
			Stdin:  strings.NewReader(""),
			Getenv: func(key string) string { return base[key] },
		}
		code := RunWith(context.Background(), e, append([]string{"tdo"}, args...))
		return result{code: code, stdout: out.String(), stderr: errb.String()}
	}
	if got := run("init"); got.code != 0 {
		t.Fatalf("init failed: %d\nstderr: %s", got.code, got.stderr)
	}
	return run(args...)
}

// Writing to a store the config file does not name is the failure mode that
// matters when a provider can be switched: nothing is lost, but it lands
// somewhere the user is not looking. So a write says so — on stderr.
func TestWriteAnnouncesAnOverriddenProvider(t *testing.T) {
	got := runWithConfig(t, "turso", map[string]string{"TODOCLOUD_PROVIDER": "sqlite"}, "add", "Buy milk")
	if got.code != 0 {
		t.Fatalf("exit %d, want 0\nstderr: %s", got.code, got.stderr)
	}
	if !strings.Contains(got.stderr, "writing to sqlite:") {
		t.Errorf("stderr does not name the store: %q", got.stderr)
	}
	if !strings.Contains(got.stderr, "TODOCLOUD_PROVIDER") || !strings.Contains(got.stderr, `"turso"`) {
		t.Errorf("stderr does not say what overrode what: %q", got.stderr)
	}
}

func TestFlagOverrideIsAlwaysAnnounced(t *testing.T) {
	got := runWithConfig(t, "sqlite", nil, "--provider", "sqlite", "add", "Buy milk")
	if got.code != 0 {
		t.Fatalf("exit %d, want 0\nstderr: %s", got.code, got.stderr)
	}
	// Even a --provider that names the configured provider is announced: it is
	// a one-off instruction, and a mistyped one is exactly what this guards.
	if !strings.Contains(got.stderr, "--provider") {
		t.Errorf("stderr does not mention the flag: %q", got.stderr)
	}
}

// An environment variable that agrees with the config file is not an
// override, and on a machine with no config file the environment *is* the
// configuration. Neither case may produce noise: that was the mistake this
// project already made once with the file-mode warning.
func TestNoNoticeWhenTheEnvironmentAgreesWithTheFile(t *testing.T) {
	got := runWithConfig(t, "sqlite", map[string]string{"TODOCLOUD_PROVIDER": "sqlite"}, "add", "Buy milk")
	if got.code != 0 {
		t.Fatalf("exit %d, want 0\nstderr: %s", got.code, got.stderr)
	}
	if strings.Contains(got.stderr, "writing to") {
		t.Errorf("stderr carries a notice it should not: %q", got.stderr)
	}
}

// Reading is harmless: an unexpected store shows an unexpected list, which is
// self-evident. Only writes announce themselves.
func TestReadsDoNotAnnounceTheStore(t *testing.T) {
	got := runWithConfig(t, "turso", map[string]string{"TODOCLOUD_PROVIDER": "sqlite"}, "ls")
	if got.code != 0 {
		t.Fatalf("exit %d, want 0\nstderr: %s", got.code, got.stderr)
	}
	if strings.Contains(got.stderr, "writing to") {
		t.Errorf("ls announced a write: %q", got.stderr)
	}
}

// The notice must never reach stdout, or `tdo add --json | jq` breaks.
func TestOverrideNoticeStaysOffStdout(t *testing.T) {
	got := runWithConfig(t, "turso", map[string]string{"TODOCLOUD_PROVIDER": "sqlite"}, "add", "Buy milk", "--json")
	if got.code != 0 {
		t.Fatalf("exit %d, want 0\nstderr: %s", got.code, got.stderr)
	}
	var envelope map[string]any
	if err := json.Unmarshal([]byte(got.stdout), &envelope); err != nil {
		t.Fatalf("stdout is not a single JSON value: %v\nstdout: %q", err, got.stdout)
	}
	if _, ok := envelope["task"]; !ok {
		t.Errorf("stdout = %q, want the task envelope", got.stdout)
	}
	if !strings.Contains(got.stderr, "writing to") {
		t.Errorf("the notice went missing under --json: %q", got.stderr)
	}
}

// An export says which store it came from, so an archive opened months later
// is not anonymous.
func TestExportRecordsTheStore(t *testing.T) {
	got := runWithConfig(t, "sqlite", nil, "export")
	if got.code != 0 {
		t.Fatalf("exit %d, want 0\nstderr: %s", got.code, got.stderr)
	}
	var envelope struct {
		Store string `json:"store"`
	}
	if err := json.Unmarshal([]byte(got.stdout), &envelope); err != nil {
		t.Fatalf("export is not JSON: %v", err)
	}
	if !strings.HasPrefix(envelope.Store, "sqlite:") {
		t.Errorf("store = %q, want it to name the sqlite store", envelope.Store)
	}
}
