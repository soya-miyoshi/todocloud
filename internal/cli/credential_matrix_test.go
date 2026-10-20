package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/soya-miyoshi/todocloud/internal/config"
	"github.com/soya-miyoshi/todocloud/internal/keyring"
	"github.com/soya-miyoshi/todocloud/internal/secret"
)

// This file tests the project's central promise as a matrix rather than as a
// handful of assertions spread over the command tests: one sentinel value per
// credential source, every command, every output stream, every rendering mode.
//
// Every credential source is populated at once — both token environment
// variables, a guarded config file, the keychain and the provider CLI that
// mints a token — so that a run proves the whole resolution path rather than
// one branch of it. Nothing here touches the developer's own environment,
// config file, keychain or provider CLI: the keychain and the Turso CLI are
// replaced through the package-level indirections, and everything on disk
// lives under t.TempDir().

// tomlString renders a value as a basic TOML string for a hand-written
// fixture. A path is the reason it exists: on Windows a temporary directory
// is C:\Users\..., and a backslash in a TOML basic string begins an escape
// sequence, so pasting such a path in raw produces a file the parser rejects
// — and a test that fails for a reason that has nothing to do with what it
// is testing.
func tomlString(v string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(v) + `"`
}

// credSentinel is one fake credential and the source it is planted in. Each
// value is obviously fake and distinctive enough to grep the repository for.
type credSentinel struct {
	source string
	value  string
}

var credSentinels = []credSentinel{
	{"the TODOCLOUD_TURSO_TOKEN environment variable", "TOKEN_GOES_HERE_env_7f3a"},
	{"the TODOCLOUD_D1_TOKEN environment variable", "TOKEN_GOES_HERE_envd1_7f3a"},
	{"the OS keychain", "TOKEN_GOES_HERE_keyring_7f3a"},
	{"the config file", "TOKEN_GOES_HERE_file_7f3a"},
	{"a token minted by the turso CLI", "TOKEN_GOES_HERE_minted_7f3a"},
	{"a token pasted on stdin", "TOKEN_GOES_HERE_stdin_7f3a"},
}

// Named lookups into credSentinels, so a fixture reads as what it plants.
const (
	sentinelEnvTurso = "TOKEN_GOES_HERE_env_7f3a"
	sentinelEnvD1    = "TOKEN_GOES_HERE_envd1_7f3a"
	sentinelKeyring  = "TOKEN_GOES_HERE_keyring_7f3a"
	sentinelFile     = "TOKEN_GOES_HERE_file_7f3a"
	sentinelMinted   = "TOKEN_GOES_HERE_minted_7f3a"
	sentinelStdin    = "TOKEN_GOES_HERE_stdin_7f3a"
)

// outputMode is one rendering of the same command.
type outputMode struct {
	name  string
	flags []string
	// json says whether stdout must hold machine output, which is also
	// checked for being exactly one JSON value.
	json bool
}

var outputModes = []outputMode{
	{name: "plain"},
	{name: "json", flags: []string{"--json"}, json: true},
	{name: "debug", flags: []string{"--debug"}},
	{name: "json+debug", flags: []string{"--json", "--debug"}, json: true},
}

// matrixCommand is one command line to run in every mode. Adding a command to
// the matrix is one line here.
type matrixCommand struct {
	name string
	// args are everything after the program name, excluding the mode flags,
	// which are inserted before them so that a positional argument cannot
	// swallow them.
	args []string
	// stdin is what the command reads, for the one command that reads a token.
	stdin string
	// stdoutIsNotJSON marks a command whose stdout is machine output in
	// another format, so the single-JSON-value check does not apply.
	stdoutIsNotJSON bool
	// mustSucceed asserts the run exercised a real success path rather than
	// failing early for an unrelated reason.
	mustSucceed bool
}

// matrixSubcommands is every subcommand in the tree, with the global flags it
// needs to reach its own code. It drives the deliberate-failure rows.
var matrixSubcommands = []struct {
	name    string
	globals []string
}{
	{name: "add"},
	{name: "inbox"},
	{name: "ls"},
	{name: "next"},
	{name: "project"},
	{name: "folder"},
	{name: "repeat"},
	{name: "series"},
	{name: "review"},
	{name: "perspective"},
	{name: "drop"},
	{name: "hold"},
	{name: "unhold"},
	{name: "flag"},
	{name: "unflag"},
	{name: "defer"},
	{name: "due"},
	{name: "mv"},
	{name: "serve"},
	{name: "show"},
	{name: "done"},
	{name: "undone"},
	{name: "edit"},
	{name: "rm"},
	{name: "init"},
	{name: "migrate"},
	{name: "config"},
	{name: "doctor"},
	{name: "export"},
	{name: "import"},
	{name: "version"},
	{name: "login", globals: []string{"--provider", "turso"}},
}

// matrixFixture is one populated world: a store, a config file holding a
// token, an environment holding two more, a keychain holding a fourth and a
// Turso CLI that mints a fifth.
type matrixFixture struct {
	dir string
	// env is the injected environment, read through Env.Getenv only.
	env map[string]string
	// exportFile is a valid export document, for the import row.
	exportFile string
	// strayConfig names a config file whose sqlite path does not exist, for
	// the missing-store failure row.
	strayConfig string
	// missingConfig names a config file that is not there at all.
	missingConfig string
}

// newMatrixFixture builds the world and initializes the store.
func newMatrixFixture(t *testing.T) *matrixFixture {
	t.Helper()
	dir := t.TempDir()
	db := filepath.Join(dir, "tasks.db")
	state := filepath.Join(dir, "state")
	xdgConfig := filepath.Join(dir, "config")

	// The config file has to satisfy every guard for its token to be loaded
	// at all: the XDG path, mode 0600, outside any git repository. t.TempDir
	// is outside the repository this test lives in.
	cfgPath := filepath.Join(xdgConfig, "todocloud", "config.toml")
	if err := os.MkdirAll(filepath.Dir(cfgPath), 0o700); err != nil {
		t.Fatal(err)
	}
	body := "provider = \"sqlite\"\n" +
		"\n[turso]\nurl = \"libsql://example.turso.io\"\ntoken = \"" + sentinelFile + "\"\n" +
		"\n[d1]\naccount_id = \"00000000-0000-0000-0000-000000000000\"\n" +
		"database_id = \"00000000-0000-0000-0000-000000000000\"\n" +
		"token = \"" + sentinelFile + "\"\n"
	if err := os.WriteFile(cfgPath, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}

	stray := filepath.Join(dir, "stray.toml")
	strayBody := "provider = \"sqlite\"\n\n[sqlite]\npath = " +
		tomlString(filepath.Join(dir, "absent", "tasks.db")) + "\n"
	if err := os.WriteFile(stray, []byte(strayBody), 0o600); err != nil {
		t.Fatal(err)
	}

	// shortref reads the state directory from the process environment, so it
	// has to be redirected there as well as in the injected one.
	t.Setenv("TODOCLOUD_STATE_DIR", state)

	f := &matrixFixture{
		dir:           dir,
		exportFile:    filepath.Join(dir, "export.json"),
		strayConfig:   stray,
		missingConfig: filepath.Join(dir, "not-there.toml"),
		env: map[string]string{
			"TODOCLOUD_PROVIDER":    "sqlite",
			"TODOCLOUD_SQLITE_PATH": db,
			"TODOCLOUD_STATE_DIR":   state,
			"HOME":                  dir,
			"XDG_CONFIG_HOME":       xdgConfig,
			"XDG_STATE_HOME":        state,
			// Every credential source is live at once.
			config.EnvTursoToken: sentinelEnvTurso,
			config.EnvD1Token:    sentinelEnvD1,
			config.EnvTursoURL:   "libsql://example.turso.io",
		},
	}

	installMatrixKeychain(t)
	installMatrixTurso(t)

	if res := f.run(t, outputMode{}, matrixCommand{args: []string{"init"}}); res.code != 0 {
		t.Fatalf("fixture init failed: exit %d\nstderr: %s", res.code, res.stderr)
	}
	// Three tasks and one listing, so the short reference "1" resolves and
	// the rows that read or change a task exercise their real paths.
	for _, title := range []string{"Matrix one", "Matrix two", "Matrix three"} {
		if res := f.run(t, outputMode{}, matrixCommand{args: []string{"add", title}}); res.code != 0 {
			t.Fatalf("fixture add failed: exit %d\nstderr: %s", res.code, res.stderr)
		}
	}
	if res := f.run(t, outputMode{}, matrixCommand{args: []string{"ls"}}); res.code != 0 {
		t.Fatalf("fixture ls failed: exit %d\nstderr: %s", res.code, res.stderr)
	}
	exported := f.run(t, outputMode{}, matrixCommand{args: []string{"export"}})
	if exported.code != 0 {
		t.Fatalf("fixture export failed: exit %d\nstderr: %s", exported.code, exported.stderr)
	}
	if err := os.WriteFile(f.exportFile, []byte(exported.stdout), 0o600); err != nil {
		t.Fatal(err)
	}
	return f
}

// run drives the real command tree with both streams captured and the
// environment injected.
func (f *matrixFixture) run(t *testing.T, mode outputMode, cmd matrixCommand) result {
	t.Helper()
	var out, errb bytes.Buffer
	args := append([]string{"tdo"}, mode.flags...)
	args = append(args, cmd.args...)
	env := Env{
		Stdout: &out,
		Stderr: &errb,
		Stdin:  strings.NewReader(cmd.stdin),
		Getenv: func(key string) string { return f.env[key] },
	}
	code := RunWith(context.Background(), env, args)
	return result{code: code, stdout: out.String(), stderr: errb.String()}
}

// installMatrixKeychain replaces the keychain this package reaches with an
// in-memory one holding the keychain sentinel for both accounts.
func installMatrixKeychain(t *testing.T) {
	t.Helper()
	backend, available := keyringBackend, keyringAvailable
	get, set, del := keyringGet, keyringSet, keyringDelete
	t.Cleanup(func() {
		keyringBackend, keyringAvailable = backend, available
		keyringGet, keyringSet, keyringDelete = get, set, del
	})

	stored := map[string]secret.Secret{
		keyring.AccountTursoToken: secret.New(sentinelKeyring),
		keyring.AccountD1Token:    secret.New(sentinelKeyring),
	}
	keyringBackend = func() string { return keyring.BackendKeychain }
	keyringAvailable = func() bool { return true }
	keyringGet = func(_ context.Context, account string) (secret.Secret, bool, error) {
		v, ok := stored[account]
		return v, ok, nil
	}
	keyringSet = func(_ context.Context, account string, value secret.Secret) error {
		stored[account] = value
		return nil
	}
	keyringDelete = func(_ context.Context, account string) error {
		delete(stored, account)
		return nil
	}
}

// installMatrixTurso replaces the Turso CLI with one that is installed,
// logged in, and mints the minted sentinel. The real binary is never run.
func installMatrixTurso(t *testing.T) {
	t.Helper()
	available, loggedIn := tursoAvailable, tursoLoggedIn
	databases, create, url := tursoDatabases, tursoCreateToken, tursoDatabaseURL
	t.Cleanup(func() {
		tursoAvailable, tursoLoggedIn = available, loggedIn
		tursoDatabases, tursoCreateToken, tursoDatabaseURL = databases, create, url
	})

	tursoAvailable = func() bool { return true }
	tursoLoggedIn = func(context.Context) (bool, error) { return true, nil }
	tursoDatabases = func(context.Context) ([]string, error) { return []string{"matrix-tasks"}, nil }
	tursoCreateToken = func(context.Context, string) (secret.Secret, error) {
		return secret.New(sentinelMinted), nil
	}
	tursoDatabaseURL = func(context.Context, string) (string, error) {
		return "libsql://example.turso.io", nil
	}
}

// matrixRows returns the command lines the matrix runs: the successful path of
// every command, a deliberate failure of every command, and the specific
// failures a user actually hits.
func matrixRows(f *matrixFixture) []matrixCommand {
	rows := []matrixCommand{
		{name: "version", args: []string{"version"}, mustSucceed: true},
		{name: "config", args: []string{"config"}, mustSucceed: true},
		{name: "doctor", args: []string{"doctor"}, mustSucceed: true},
		{name: "init", args: []string{"init"}, mustSucceed: true},
		{name: "migrate", args: []string{"migrate"}, mustSucceed: true},
		{name: "add", args: []string{"add", "Buy milk"}, mustSucceed: true},
		{name: "ls", args: []string{"ls"}, mustSucceed: true},
		{name: "ls --all", args: []string{"ls", "--all"}, mustSucceed: true},
		{name: "show", args: []string{"show", "1"}, mustSucceed: true},
		{name: "done", args: []string{"done", "1"}, mustSucceed: true},
		{name: "undone", args: []string{"undone", "1"}, mustSucceed: true},
		{name: "edit", args: []string{"edit", "1", "--title", "Renamed"}, mustSucceed: true},
		// The structure commands, and then the commands that take a
		// reference. The short numbers come from the listing just above each
		// block, which is how a human reaches them too.
		{name: "folder add", args: []string{"folder", "add", "Home"}, mustSucceed: true},
		{name: "project add", args: []string{"project", "add", "Errands", "--folder", "Home", "--review", "1w"}, mustSucceed: true},
		{name: "project <ref>", args: []string{"project", "Errands", "--sequential"}, mustSucceed: true},
		{name: "inbox", args: []string{"inbox"}, mustSucceed: true},
		{name: "inbox --count", args: []string{"inbox", "--count"}, mustSucceed: true},
		{name: "inbox process", args: []string{"inbox", "process", "1", "--project", "Errands"}, mustSucceed: true},
		{name: "mv --inbox", args: []string{"mv", "1", "--inbox"}, mustSucceed: true},
		{name: "next", args: []string{"next"}, mustSucceed: true},
		{name: "project ls", args: []string{"project", "ls"}, mustSucceed: true},
		{name: "folder ls", args: []string{"folder", "ls"}, mustSucceed: true},
		{name: "review", args: []string{"review"}, mustSucceed: true},
		{name: "review <ref>", args: []string{"review", "Errands"}, mustSucceed: true},
		{name: "ls --all (renumbers)", args: []string{"ls", "--all"}, mustSucceed: true},
		{name: "flag", args: []string{"flag", "1"}, mustSucceed: true},
		{name: "unflag", args: []string{"unflag", "1"}, mustSucceed: true},
		{name: "hold", args: []string{"hold", "1"}, mustSucceed: true},
		{name: "unhold", args: []string{"unhold", "1"}, mustSucceed: true},
		{name: "drop", args: []string{"drop", "1"}, mustSucceed: true},
		{name: "undone (after drop)", args: []string{"undone", "1"}, mustSucceed: true},
		{name: "defer", args: []string{"defer", "1", "2026-12-01"}, mustSucceed: true},
		{name: "defer --clear", args: []string{"defer", "1", "--clear"}, mustSucceed: true},
		{name: "due", args: []string{"due", "1", "2026-12-01"}, mustSucceed: true},
		{name: "due --clear", args: []string{"due", "1", "--clear"}, mustSucceed: true},
		{name: "repeat", args: []string{"repeat", "1", "1w"}, mustSucceed: true},
		{name: "series", args: []string{"series", "1"}, mustSucceed: true},
		{name: "repeat --stop", args: []string{"repeat", "1", "--stop"}, mustSucceed: true},
		{name: "perspective save", args: []string{"perspective", "save", "flagged", "--", "--flagged"}, mustSucceed: true},
		{name: "perspective ls", args: []string{"perspective", "ls"}, mustSucceed: true},
		{name: "perspective show", args: []string{"perspective", "show", "flagged"}, mustSucceed: true},
		{name: "ls --perspective", args: []string{"ls", "--perspective", "flagged"}, mustSucceed: true},
		{name: "perspective rm", args: []string{"perspective", "rm", "flagged"}, mustSucceed: true},
		{name: "ls --all (renumbers again)", args: []string{"ls", "--all"}, mustSucceed: true},
		{name: "rm", args: []string{"rm", "2"}, mustSucceed: true},
		{name: "rm --purge --yes", args: []string{"rm", "--purge", "--yes", "3"}, mustSucceed: true},
		{name: "export", args: []string{"export"}, mustSucceed: true},
		{name: "export --csv", args: []string{"export", "--csv"}, stdoutIsNotJSON: true, mustSucceed: true},
		{name: "import", args: []string{"import", "--new-ids", f.exportFile}, mustSucceed: true},
		{
			name:        "login --show",
			args:        []string{"--provider", "turso", "login", "--show"},
			mustSucceed: true,
		},
		{
			name:        "login (mints through the turso CLI)",
			args:        []string{"--provider", "turso", "login", "--yes", "--database", "matrix-tasks"},
			mustSucceed: true,
		},
		{
			name:        "login (reads a pasted token from stdin)",
			args:        []string{"--provider", "d1", "login", "--yes"},
			stdin:       sentinelStdin + "\n",
			mustSucceed: true,
		},
		{
			name:        "login --remove --yes",
			args:        []string{"--provider", "turso", "login", "--remove", "--yes"},
			mustSucceed: true,
		},
	}

	// A deliberate failure of every command: an unknown flag, which must be
	// reported without any of the configuration it never got to read.
	for _, sub := range matrixSubcommands {
		args := append(append([]string{}, sub.globals...), sub.name, "--definitely-not-a-flag")
		rows = append(rows, matrixCommand{name: sub.name + " (unknown flag)", args: args})
	}

	// The failures a user meets for real.
	rows = append(rows,
		matrixCommand{name: "unknown command", args: []string{"nosuchcommand"}},
		// serve is only ever exercised through a failure here: a row that
		// succeeded would block the test on a listener.
		matrixCommand{name: "serve with an impossible port", args: []string{"serve", "--port", "70000"}},
		matrixCommand{name: "unknown reference", args: []string{"show", "999999"}},
		matrixCommand{name: "malformed reference", args: []string{"done", "not-an-id"}},
		matrixCommand{name: "missing store", args: []string{"--config", f.strayConfig, "ls"}},
		matrixCommand{name: "missing config file", args: []string{"--config", f.missingConfig, "config"}},
		matrixCommand{name: "unimplemented provider", args: []string{"--provider", "turso", "ls"}},
		matrixCommand{name: "import of a missing file", args: []string{"import", filepath.Join(f.dir, "absent.json")}},
		matrixCommand{
			name: "login --remove with --show",
			args: []string{"--provider", "turso", "login", "--remove", "--show"},
		},
		matrixCommand{
			name:  "login with nothing on stdin",
			args:  []string{"--provider", "d1", "login", "--yes"},
			stdin: "",
		},
	)
	return rows
}

// TestNoCredentialReachesAnyStream is the matrix: commands × modes, with every
// credential source populated, asserting that no sentinel appears on either
// stream and that --json stdout holds exactly one JSON value.
func TestNoCredentialReachesAnyStream(t *testing.T) {
	for _, mode := range outputModes {
		t.Run(mode.name, func(t *testing.T) {
			// A fresh world per mode, so a row that changes the store cannot
			// make another mode's row fail for an unrelated reason.
			f := newMatrixFixture(t)
			for _, row := range matrixRows(f) {
				t.Run(row.name, func(t *testing.T) {
					res := f.run(t, mode, row)

					for _, s := range credSentinels {
						if strings.Contains(res.stdout, s.value) {
							t.Errorf("`tdo %s` in %s mode leaked %s onto stdout\nstdout: %s",
								strings.Join(row.args, " "), mode.name, s.source, res.stdout)
						}
						if strings.Contains(res.stderr, s.value) {
							t.Errorf("`tdo %s` in %s mode leaked %s onto stderr\nstderr: %s",
								strings.Join(row.args, " "), mode.name, s.source, res.stderr)
						}
					}

					if mode.json && !row.stdoutIsNotJSON {
						assertAtMostOneJSONValue(t, row, mode, res.stdout)
					}
					if row.mustSucceed && res.code != 0 {
						t.Errorf("`tdo %s` in %s mode exited %d, want 0 (the row is meant to exercise a success path)\nstderr: %s",
							strings.Join(row.args, " "), mode.name, res.code, res.stderr)
					}
					if !row.mustSucceed && res.code == 0 && strings.Contains(row.name, "unknown flag") {
						t.Errorf("`tdo %s` in %s mode exited 0, so the deliberate failure did not happen",
							strings.Join(row.args, " "), mode.name)
					}
				})
			}
		})
	}
}

// assertAtMostOneJSONValue checks that a --json run put one JSON document on
// stdout and nothing else: a second document is a place a leak could hide.
func assertAtMostOneJSONValue(t *testing.T, row matrixCommand, mode outputMode, stdout string) {
	t.Helper()
	if strings.TrimSpace(stdout) == "" {
		// Some commands report entirely on stderr; an empty stdout cannot
		// hide anything.
		return
	}
	dec := json.NewDecoder(strings.NewReader(stdout))
	var first any
	if err := dec.Decode(&first); err != nil {
		t.Errorf("`tdo %s` in %s mode did not put JSON on stdout: %q: %v",
			strings.Join(row.args, " "), mode.name, stdout, err)
		return
	}
	var second any
	if err := dec.Decode(&second); err != io.EOF {
		t.Errorf("`tdo %s` in %s mode put more than one JSON value on stdout, where a leak could hide: %q",
			strings.Join(row.args, " "), mode.name, stdout)
	}
}

// TestMatrixCoversEveryCommand keeps the matrix honest: every command in the
// tree must appear in it, so a new command cannot be added without a row.
func TestMatrixCoversEveryCommand(t *testing.T) {
	f := newMatrixFixture(t)
	covered := map[string]bool{}
	for _, row := range matrixRows(f) {
		for _, arg := range row.args {
			if !strings.HasPrefix(arg, "-") {
				covered[arg] = true
			}
		}
	}

	a := &app{env: Env{Stdout: io.Discard, Stderr: io.Discard}}
	for _, c := range a.root().Commands {
		names := append([]string{c.Name}, c.Aliases...)
		found := false
		for _, n := range names {
			if covered[n] {
				found = true
			}
		}
		if !found {
			t.Errorf("command %q has no row in the credential matrix", c.Name)
		}
	}
}

// guardCase is one config file the token guard has to judge.
type guardCase struct {
	name string
	// inRepository puts the file inside a directory with a .git entry.
	inRepository bool
	// mode is the file's permission bits.
	mode os.FileMode
	// location is how the file is named: "xdg", "env" or "flag".
	location string
	// key is the token key written in the file: "token", "api_token" or "".
	key string
	// wantLoaded is whether the token should end up in the configuration.
	wantLoaded bool
	// wantWarning is whether the run should say something on stderr.
	wantWarning bool
}

// TestConfigFileTokenGuardMatrix tests the config-file guard where a user
// actually meets it: through `tdo config --json`. It overlaps the
// internal/config tests deliberately — the guard is only worth anything if it
// still holds once the command layer has resolved the path, read the file and
// rendered the result.
func TestConfigFileTokenGuardMatrix(t *testing.T) {
	cases := []guardCase{
		{
			name: "xdg path, mode 600, token", mode: 0o600, location: "xdg", key: "token",
			wantLoaded: true,
		},
		{
			name: "env path, mode 600, token", mode: 0o600, location: "env", key: "token",
			wantLoaded: true,
		},
		{
			name: "arbitrary --config path, mode 600, token", mode: 0o600, location: "flag", key: "token",
			wantWarning: true,
		},
		{
			name: "xdg path, mode 640, token", mode: 0o640, location: "xdg", key: "token",
			wantWarning: true,
		},
		{
			name: "xdg path, mode 644, token", mode: 0o644, location: "xdg", key: "token",
			wantWarning: true,
		},
		{
			name: "env path, mode 644, token", mode: 0o644, location: "env", key: "token",
			wantWarning: true,
		},
		{
			name:         "xdg path inside a git repository, mode 600, token",
			inRepository: true, mode: 0o600, location: "xdg", key: "token",
			wantWarning: true,
		},
		{
			name:         "env path inside a git repository, mode 600, token",
			inRepository: true, mode: 0o600, location: "env", key: "token",
			wantWarning: true,
		},
		{
			// An unsupported spelling is reported and dropped, wherever it is.
			name: "xdg path, mode 600, api_token", mode: 0o600, location: "xdg", key: "api_token",
			wantWarning: true,
		},
		{
			name: "env path, mode 600, api_token", mode: 0o600, location: "env", key: "api_token",
			wantWarning: true,
		},
		{
			name: "arbitrary --config path, mode 600, api_token", mode: 0o600, location: "flag", key: "api_token",
			wantWarning: true,
		},
		{
			name: "xdg path, mode 644, no token at all", mode: 0o644, location: "xdg", key: "",
		},
		{
			name:         "xdg path inside a git repository, no token at all",
			inRepository: true, mode: 0o600, location: "xdg", key: "",
		},
		{
			name: "arbitrary --config path, mode 600, no token at all", mode: 0o600, location: "flag", key: "",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			// Where a file token is not read at all, every case that writes
			// one is a refusal with a warning, whatever the path and the mode
			// say. The verdict is the platform's, not the matrix's, so the
			// expectation moves rather than the case being dropped: that a
			// token in a file never loads here is exactly what is worth
			// asserting on such a platform.
			if !config.FileTokensSupported && c.key == "token" {
				c.wantLoaded = false
				c.wantWarning = true
			}

			res, described := runGuardCase(t, c)

			if res.code != 0 {
				t.Fatalf("`tdo config --json` exited %d\nstderr: %s", res.code, res.stderr)
			}

			turso, _ := described["turso"].(map[string]any)
			present, _ := turso["token_present"].(bool)
			if present != c.wantLoaded {
				t.Errorf("token_present = %v, want %v\nstderr: %s", present, c.wantLoaded, res.stderr)
			}
			origin, _ := turso["token_origin"].(string)
			if c.wantLoaded && !strings.HasPrefix(origin, "file:") {
				t.Errorf("token_origin = %q, want a file: origin", origin)
			}
			if !c.wantLoaded && origin != "" {
				t.Errorf("a refused token still recorded the origin %q", origin)
			}

			gotWarning := strings.TrimSpace(res.stderr) != ""
			if gotWarning != c.wantWarning {
				t.Errorf("warning on stderr = %v, want %v\nstderr: %s", gotWarning, c.wantWarning, res.stderr)
			}

			// Whatever the verdict, the value itself may not appear anywhere:
			// not in a warning, not in an origin, not in the rendered config.
			if strings.Contains(res.stderr, sentinelFile) {
				t.Errorf("the token value reached stderr: %s", res.stderr)
			}
			if strings.Contains(res.stdout, sentinelFile) {
				t.Errorf("the token value reached stdout: %s", res.stdout)
			}
			for _, raw := range described["warnings"].([]any) {
				if strings.Contains(raw.(string), sentinelFile) {
					t.Errorf("a warning carries the token value: %s", raw)
				}
			}
			for name, raw := range described["origins"].(map[string]any) {
				if strings.Contains(fmt.Sprint(raw), sentinelFile) {
					t.Errorf("the origin of %s carries the token value: %v", name, raw)
				}
			}
		})
	}
}

// runGuardCase builds one config file as the case describes it, runs
// `tdo config --json` against it and decodes the result.
func runGuardCase(t *testing.T, c guardCase) (result, map[string]any) {
	t.Helper()
	root := t.TempDir()
	state := filepath.Join(root, "state")
	t.Setenv("TODOCLOUD_STATE_DIR", state)

	// Where the file sits on disk. A repository case gets a .git entry above
	// it, which is what fileTokenGuard looks for.
	base := root
	if c.inRepository {
		base = filepath.Join(root, "repo")
		if err := os.MkdirAll(filepath.Join(base, ".git"), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	xdgConfig := filepath.Join(base, "config")

	var cfgPath string
	switch c.location {
	case "xdg":
		cfgPath = filepath.Join(xdgConfig, "todocloud", "config.toml")
	case "env", "flag":
		cfgPath = filepath.Join(base, "named.toml")
	default:
		t.Fatalf("unknown location %q", c.location)
	}
	if err := os.MkdirAll(filepath.Dir(cfgPath), 0o700); err != nil {
		t.Fatal(err)
	}

	body := "provider = \"sqlite\"\n\n[sqlite]\npath = " + tomlString(filepath.Join(root, "tasks.db")) + "\n" +
		"\n[turso]\nurl = \"libsql://example.turso.io\"\n"
	if c.key != "" {
		body += c.key + " = \"" + sentinelFile + "\"\n"
	}
	if err := os.WriteFile(cfgPath, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	// The mode is set after the write, so an umask cannot soften it.
	if err := os.Chmod(cfgPath, c.mode); err != nil {
		t.Fatal(err)
	}

	env := map[string]string{
		"HOME":            root,
		"XDG_CONFIG_HOME": xdgConfig,
		"XDG_STATE_HOME":  state,
		// No token in the environment: the environment wins over the file, so
		// its absence is what makes this a test of the file.
	}
	args := []string{"tdo", "--json", "config"}
	switch c.location {
	case "env":
		env[config.EnvConfig] = cfgPath
	case "flag":
		args = []string{"tdo", "--json", "--config", cfgPath, "config"}
	}

	var out, errb bytes.Buffer
	code := RunWith(context.Background(), Env{
		Stdout: &out,
		Stderr: &errb,
		Stdin:  strings.NewReader(""),
		Getenv: func(key string) string { return env[key] },
	}, args)
	res := result{code: code, stdout: out.String(), stderr: errb.String()}

	var described map[string]any
	dec := json.NewDecoder(strings.NewReader(res.stdout))
	if err := dec.Decode(&described); err != nil {
		t.Fatalf("stdout is not JSON: %q: %v", res.stdout, err)
	}
	if dec.More() {
		t.Fatalf("stdout holds more than one JSON value: %q", res.stdout)
	}
	return res, described
}
