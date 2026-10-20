package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/soya-miyoshi/todocloud/internal/exit"
)

// configEnv is a complete, fake environment whose XDG config home is a fresh
// temporary directory. No test in this file can reach the developer's own
// config file: every path it writes is under t.TempDir.
func configEnv(t *testing.T, extra map[string]string) (map[string]string, string) {
	t.Helper()
	home := t.TempDir()
	xdg := filepath.Join(home, ".config")
	env := map[string]string{
		"HOME":            home,
		"XDG_CONFIG_HOME": xdg,
	}
	for k, v := range extra {
		env[k] = v
	}
	return env, filepath.Join(xdg, "todocloud", "config.toml")
}

// runIn drives the real command tree against env, with stdin piped.
func runIn(t *testing.T, env map[string]string, stdin string, args ...string) result {
	t.Helper()
	var out, errb bytes.Buffer
	e := Env{
		Stdout: &out,
		Stderr: &errb,
		Stdin:  strings.NewReader(stdin),
		Getenv: func(key string) string { return env[key] },
	}
	code := RunWith(context.Background(), e, append([]string{"tdo"}, args...))
	return result{code: code, stdout: out.String(), stderr: errb.String()}
}

func readConfig(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}
	return string(data)
}

func TestConfigSetCreatesTheFileAndTheNextCommandReadsWhatItWrote(t *testing.T) {
	env, path := configEnv(t, nil)

	res := runIn(t, env, "", "config", "set", "turso.url", "libsql://example.turso.io")
	if res.code != 0 {
		t.Fatalf("exit %d\nstdout: %s\nstderr: %s", res.code, res.stdout, res.stderr)
	}
	if !strings.Contains(res.stdout, path) || !strings.Contains(res.stdout, "turso.url") {
		t.Fatalf("the result does not name the file and the key: %q", res.stdout)
	}
	if !strings.Contains(readConfig(t, path), "libsql://example.turso.io") {
		t.Fatalf("the url is not in the file:\n%s", readConfig(t, path))
	}

	// The real proof that a write is useful is that the reader agrees.
	shown := runIn(t, env, "", "config", "--json")
	if shown.code != 0 {
		t.Fatalf("tdo config exit %d: %s", shown.code, shown.stderr)
	}
	var cfg map[string]any
	if err := json.Unmarshal([]byte(shown.stdout), &cfg); err != nil {
		t.Fatalf("config --json: %v", err)
	}
	turso, _ := cfg["turso"].(map[string]any)
	if turso["url"] != "libsql://example.turso.io" {
		t.Fatalf("tdo config does not report the written url: %v", cfg["turso"])
	}
}

func TestConfigSetJSONReportsTheFileAndEveryChange(t *testing.T) {
	env, path := configEnv(t, nil)
	runIn(t, env, "", "config", "set", "provider", "sqlite")

	res := runIn(t, env, "", "--json", "config", "set", "provider", "turso")
	if res.code != 0 {
		t.Fatalf("exit %d: %s", res.code, res.stderr)
	}
	var got struct {
		ConfigFile string `json:"config_file"`
		Created    bool   `json:"created"`
		Wrote      bool   `json:"wrote"`
		Changes    []struct {
			Key      string `json:"key"`
			Value    string `json:"value"`
			Previous string `json:"previous"`
			Added    bool   `json:"added"`
			Changed  bool   `json:"changed"`
		} `json:"changes"`
	}
	if err := json.Unmarshal([]byte(res.stdout), &got); err != nil {
		t.Fatalf("stdout is not the documented shape: %q: %v", res.stdout, err)
	}
	if got.ConfigFile != path || got.Created || !got.Wrote {
		t.Fatalf("got %+v, want a write to the existing %s", got, path)
	}
	if len(got.Changes) != 1 {
		t.Fatalf("got %d changes, want 1", len(got.Changes))
	}
	c := got.Changes[0]
	if c.Key != "provider" || c.Value != "turso" || c.Previous != "sqlite" || c.Added || !c.Changed {
		t.Fatalf("got %+v", c)
	}
}

func TestConfigSetRefusesATokenAndPointsAtLogin(t *testing.T) {
	env, path := configEnv(t, nil)

	res := runIn(t, env, "", "config", "set", "turso.token", "TOKEN_GOES_HERE")
	if res.code != exit.Usage {
		t.Fatalf("exit %d, want %d\nstderr: %s", res.code, exit.Usage, res.stderr)
	}
	if !strings.Contains(res.stderr, "tdo login") {
		t.Fatalf("the refusal does not say what to do instead: %q", res.stderr)
	}
	if strings.Contains(res.stderr, "TOKEN_GOES_HERE") {
		t.Fatalf("the refusal echoed the value: %q", res.stderr)
	}
	if _, err := os.Stat(path); err == nil {
		t.Fatalf("a refused write created %s", path)
	}
}

func TestConfigSetRefusesAConfigPathOutsideTheAllowedOnes(t *testing.T) {
	env, _ := configEnv(t, nil)
	elsewhere := filepath.Join(t.TempDir(), "project.toml")

	res := runIn(t, env, "", "--config", elsewhere, "config", "set", "provider", "turso")
	if res.code != exit.Config {
		t.Fatalf("exit %d, want %d\nstderr: %s", res.code, exit.Config, res.stderr)
	}
	if _, err := os.Stat(elsewhere); err == nil {
		t.Fatalf("a refused write created %s", elsewhere)
	}
}

func TestConfigWithNoArgumentsStillPrintsTheResolvedConfiguration(t *testing.T) {
	env, _ := configEnv(t, nil)

	res := runIn(t, env, "", "config")
	if res.code != 0 {
		t.Fatalf("exit %d: %s", res.code, res.stderr)
	}
	// The unchanged behaviour: the resolved settings, one per line, with the
	// provider among them.
	if !strings.Contains(res.stdout, "provider = ") {
		t.Fatalf("tdo config no longer prints the resolved configuration: %q", res.stdout)
	}
}

func TestLoginSavesTheProviderAndTheDatabaseURLAndSaysSo(t *testing.T) {
	env, path := configEnv(t, map[string]string{"TODOCLOUD_PROVIDER": "turso"})
	(&fakeKeychain{backend: "test keychain", available: true}).install(t)
	(&fakeTurso{installed: true, loggedIn: true, databases: []string{"tasks"}, url: "libsql://example.turso.io"}).install(t)

	res := runIn(t, env, "", "login", "--yes")
	if res.code != 0 {
		t.Fatalf("exit %d\nstderr: %s", res.code, res.stderr)
	}
	// It must say which file it wrote and which keys changed: a command that
	// edits the user's file silently is one they stop trusting.
	if !strings.Contains(res.stderr, path) || !strings.Contains(res.stderr, "turso.url") || !strings.Contains(res.stderr, "provider") {
		t.Fatalf("the save was not announced: %q", res.stderr)
	}
	body := readConfig(t, path)
	if !strings.Contains(body, `provider = "turso"`) || !strings.Contains(body, `url = "libsql://example.turso.io"`) {
		t.Fatalf("the file does not hold what login learned:\n%s", body)
	}
	// And it holds no credential, whatever else it holds.
	if strings.Contains(body, fakeTursoToken) || strings.Contains(body, "token = ") {
		t.Fatalf("login wrote a token into the config file:\n%s", body)
	}
}

func TestLoginJSONReportsTheConfigFileItWrote(t *testing.T) {
	env, path := configEnv(t, map[string]string{"TODOCLOUD_PROVIDER": "turso"})
	(&fakeKeychain{backend: "test keychain", available: true}).install(t)
	(&fakeTurso{installed: true, loggedIn: true, databases: []string{"tasks"}, url: "libsql://example.turso.io"}).install(t)

	res := runIn(t, env, "", "--json", "login", "--yes")
	if res.code != 0 {
		t.Fatalf("exit %d\nstderr: %s", res.code, res.stderr)
	}
	var got struct {
		Stored        bool     `json:"stored"`
		ConfigFile    string   `json:"config_file"`
		ConfigWritten bool     `json:"config_written"`
		ConfigKeys    []string `json:"config_keys"`
	}
	if err := json.Unmarshal([]byte(res.stdout), &got); err != nil {
		t.Fatalf("stdout is not the documented shape: %q: %v", res.stdout, err)
	}
	if !got.Stored || !got.ConfigWritten || got.ConfigFile != path {
		t.Fatalf("got %+v, want a write to %s", got, path)
	}
	if strings.Join(got.ConfigKeys, ",") != "provider,turso.url" {
		t.Fatalf("config_keys = %v", got.ConfigKeys)
	}
}

func TestLoginWithNoSaveLeavesTheConfigFileAloneAndPrintsTheLines(t *testing.T) {
	env, path := configEnv(t, map[string]string{"TODOCLOUD_PROVIDER": "turso"})
	(&fakeKeychain{backend: "test keychain", available: true}).install(t)
	(&fakeTurso{installed: true, loggedIn: true, databases: []string{"tasks"}, url: "libsql://example.turso.io"}).install(t)

	res := runIn(t, env, "", "login", "--yes", "--no-save")
	if res.code != 0 {
		t.Fatalf("exit %d\nstderr: %s", res.code, res.stderr)
	}
	if _, err := os.Stat(path); err == nil {
		t.Fatalf("--no-save wrote %s anyway", path)
	}
	if !strings.Contains(res.stderr, `url = "libsql://example.turso.io"`) {
		t.Fatalf("the lines to paste were not printed: %q", res.stderr)
	}
}

func TestLoginStillSucceedsWithUsableAdviceWhenTheSaveIsRefused(t *testing.T) {
	// A home directory that is itself a git repository: the writer refuses,
	// because a config file inside a repository is one commit from being
	// public. The login did not fail — the token is in the keychain — so the
	// command warns, prints the lines to paste and exits 0.
	home := t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, ".git"), 0o700); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	env := map[string]string{
		"HOME":               home,
		"XDG_CONFIG_HOME":    filepath.Join(home, ".config"),
		"TODOCLOUD_PROVIDER": "turso",
	}
	keys := (&fakeKeychain{backend: "test keychain", available: true}).install(t)
	(&fakeTurso{installed: true, loggedIn: true, databases: []string{"tasks"}, url: "libsql://example.turso.io"}).install(t)

	res := runIn(t, env, "", "login", "--yes")
	if res.code != 0 {
		t.Fatalf("a refused save must not fail the login: exit %d\nstderr: %s", res.code, res.stderr)
	}
	if len(keys.stored) != 1 {
		t.Fatalf("the token was not stored: %v", keys.stored)
	}
	if !strings.Contains(res.stderr, "git repository") {
		t.Fatalf("the warning does not say why: %q", res.stderr)
	}
	if !strings.Contains(res.stderr, `url = "libsql://example.turso.io"`) {
		t.Fatalf("the lines to paste were not printed: %q", res.stderr)
	}
	if _, err := os.Stat(filepath.Join(home, ".config", "todocloud", "config.toml")); err == nil {
		t.Fatal("the refused save wrote the file anyway")
	}
}
