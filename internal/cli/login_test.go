package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/soya-miyoshi/todocloud/internal/config"
	"github.com/soya-miyoshi/todocloud/internal/keyring"
	"github.com/soya-miyoshi/todocloud/internal/providercli"
	"github.com/soya-miyoshi/todocloud/internal/secret"
)

// TestMain makes the real provider CLIs unreachable for every test in this
// package. Without it, a developer who happens to have the turso CLI
// installed would have their own credentials driven by these tests — which
// CLAUDE.md §1.5 forbids, and which would make the results depend on the
// machine. A test that wants delegation installs a fakeTurso instead.
func TestMain(m *testing.M) {
	tursoAvailable = func() bool { return false }
	tursoLoggedIn = func(context.Context) (bool, error) {
		panic("a test reached the real turso CLI")
	}
	tursoDatabases = func(context.Context) ([]string, error) {
		panic("a test reached the real turso CLI")
	}
	tursoCreateToken = func(context.Context, string) (secret.Secret, error) {
		panic("a test reached the real turso CLI")
	}
	tursoDatabaseURL = func(context.Context, string) (string, error) {
		panic("a test reached the real turso CLI")
	}
	// Configuration resolves cloud tokens through the OS keychain. Without
	// this, a test that selects a cloud provider would query the developer's
	// real keychain — which CLAUDE.md §1.5 forbids and which would make the
	// result depend on the machine. A test that wants a keychain replaces this
	// seam itself.
	configKeyringLookup = func(string) (secret.Secret, bool, error) {
		return secret.Secret{}, false, nil
	}
	os.Exit(m.Run())
}

// loginFakeToken is the value every test here feeds in. No test may ever see
// it in output.
const loginFakeToken = "FAKE-TOKEN-not-a-real-credential-wxyz"

// fakeKeychain is an in-memory stand-in for the OS keychain. Every test in
// this file installs one, so that none of them can read or write the
// developer's real keychain.
type fakeKeychain struct {
	backend   string
	available bool
	setErr    error
	stored    map[string]secret.Secret
}

// install replaces the command's keychain indirections for the duration of a
// test.
func (k *fakeKeychain) install(t *testing.T) *fakeKeychain {
	t.Helper()
	if k.stored == nil {
		k.stored = map[string]secret.Secret{}
	}
	backend, available := keyringBackend, keyringAvailable
	get, set, del := keyringGet, keyringSet, keyringDelete
	t.Cleanup(func() {
		keyringBackend, keyringAvailable = backend, available
		keyringGet, keyringSet, keyringDelete = get, set, del
	})

	keyringBackend = func() string { return k.backend }
	keyringAvailable = func() bool { return k.available }
	keyringGet = func(_ context.Context, account string) (secret.Secret, bool, error) {
		if !k.available {
			return secret.Secret{}, false, keyring.ErrUnavailable
		}
		v, ok := k.stored[account]
		return v, ok, nil
	}
	keyringSet = func(_ context.Context, account string, value secret.Secret) error {
		if k.setErr != nil {
			return k.setErr
		}
		k.stored[account] = value
		return nil
	}
	keyringDelete = func(_ context.Context, account string) error {
		delete(k.stored, account)
		return nil
	}
	return k
}

// runLogin drives the real command tree with stdin piped, which is the only
// way a token may be supplied.
func runLogin(t *testing.T, stdin string, args ...string) result {
	t.Helper()
	var out, errb bytes.Buffer
	env := Env{
		Stdout: &out,
		Stderr: &errb,
		Stdin:  strings.NewReader(stdin),
		// A clean environment: the developer's own TODOCLOUD_* variables and
		// config file must not reach this command.
		Getenv: func(key string) string {
			if key == "TODOCLOUD_PROVIDER" {
				return "turso"
			}
			return ""
		},
	}
	code := RunWith(context.Background(), env, append([]string{"tdo", "login"}, args...))
	return result{code: code, stdout: out.String(), stderr: errb.String()}
}

// assertNoToken is the assertion every test in this file ends with.
func assertNoToken(t *testing.T, res result) {
	t.Helper()
	if strings.Contains(res.stdout, loginFakeToken) {
		t.Fatalf("the token reached stdout: %q", res.stdout)
	}
	if strings.Contains(res.stderr, loginFakeToken) {
		t.Fatalf("the token reached stderr: %q", res.stderr)
	}
}

func TestLoginWithNoBackendPrintsInstructionsAndSucceeds(t *testing.T) {
	(&fakeKeychain{backend: keyring.BackendNone}).install(t)

	res := runLogin(t, loginFakeToken+"\n")
	if res.code != 0 {
		t.Fatalf("exit %d, want 0\nstderr: %s", res.code, res.stderr)
	}
	// Nothing failed, so nothing goes to stdout and no error is rendered.
	if res.stdout != "" {
		t.Fatalf("stdout should be empty without --json: %q", res.stdout)
	}
	if !strings.Contains(res.stderr, keyring.Placeholder) {
		t.Fatalf("stderr does not carry the manual instructions: %q", res.stderr)
	}
	if strings.Contains(res.stderr, "tdo: warning") || strings.Contains(res.stderr, "tdo: ") {
		t.Fatalf("an unavailable keychain was reported as a failure: %q", res.stderr)
	}
	assertNoToken(t, res)
}

func TestLoginWithNoBackendJSONReportsNotStored(t *testing.T) {
	(&fakeKeychain{backend: keyring.BackendNone}).install(t)

	res := runLogin(t, loginFakeToken+"\n", "--json")
	if res.code != 0 {
		t.Fatalf("exit %d, want 0\nstderr: %s", res.code, res.stderr)
	}
	got := decodeLine(t, res.stdout)
	if got["stored"] != false {
		t.Fatalf("stored = %v, want false", got["stored"])
	}
	if got["backend"] != keyring.BackendNone {
		t.Fatalf("backend = %v, want %q", got["backend"], keyring.BackendNone)
	}
	instructions, ok := got["instructions"].(string)
	if !ok || !strings.Contains(instructions, keyring.Placeholder) {
		t.Fatalf("instructions = %v, want a placeholder", got["instructions"])
	}
	assertNoToken(t, res)
}

// TestLoginWhenWritingIsUnsupportedDegradesInsteadOfFailing covers the macOS
// fallback: a backend exists and can be read, but this particular token
// cannot be handed to it without exposing it in argv.
func TestLoginWhenWritingIsUnsupportedDegradesInsteadOfFailing(t *testing.T) {
	(&fakeKeychain{
		backend:   keyring.BackendKeychain,
		available: true,
		setErr:    keyring.ErrWriteUnsupported,
	}).install(t)

	res := runLogin(t, loginFakeToken+"\n", "--json")
	if res.code != 0 {
		t.Fatalf("exit %d, want 0\nstderr: %s", res.code, res.stderr)
	}
	got := decodeLine(t, res.stdout)
	if got["stored"] != false {
		t.Fatalf("stored = %v, want false", got["stored"])
	}
	if got["instructions"] == nil {
		t.Fatal("no instructions were emitted")
	}
	assertNoToken(t, res)
}

func TestLoginStoresTheTokenFromPipedStdin(t *testing.T) {
	k := (&fakeKeychain{backend: keyring.BackendKeychain, available: true}).install(t)

	res := runLogin(t, loginFakeToken+"\n", "--json")
	if res.code != 0 {
		t.Fatalf("exit %d, want 0\nstderr: %s", res.code, res.stderr)
	}
	got := decodeLine(t, res.stdout)
	if got["stored"] != true {
		t.Fatalf("stored = %v, want true", got["stored"])
	}
	if got["provider"] != "turso" || got["account"] != keyring.AccountTursoToken {
		t.Fatalf("unexpected identification: %v", got)
	}
	// The value must arrive intact: a trailing newline is the terminator, not
	// part of the token.
	stored, ok := k.stored[keyring.AccountTursoToken]
	if !ok {
		t.Fatal("nothing was stored")
	}
	if stored.Reveal() != loginFakeToken {
		t.Fatal("the stored token is not the token that was piped in")
	}
	assertNoToken(t, res)
}

func TestLoginConfirmationNamesTheEnvironmentVariable(t *testing.T) {
	(&fakeKeychain{backend: keyring.BackendKeychain, available: true}).install(t)

	res := runLogin(t, loginFakeToken+"\n")
	if res.code != 0 {
		t.Fatalf("exit %d, want 0\nstderr: %s", res.code, res.stderr)
	}
	if !strings.Contains(res.stderr, "TODOCLOUD_TURSO_TOKEN") {
		t.Fatalf("stderr does not tell the user what to unset: %q", res.stderr)
	}
	assertNoToken(t, res)
}

func TestLoginShowNeverPrintsTheValue(t *testing.T) {
	k := (&fakeKeychain{backend: keyring.BackendKeychain, available: true}).install(t)
	k.stored[keyring.AccountTursoToken] = secret.New(loginFakeToken)

	res := runLogin(t, "", "--show")
	if res.code != 0 {
		t.Fatalf("exit %d, want 0\nstderr: %s", res.code, res.stderr)
	}
	if !strings.Contains(res.stdout, secret.Redacted) {
		t.Fatalf("stdout carries no redaction marker: %q", res.stdout)
	}
	assertNoToken(t, res)

	jres := runLogin(t, "", "--show", "--json")
	got := decodeLine(t, jres.stdout)
	if got["present"] != true {
		t.Fatalf("present = %v, want true", got["present"])
	}
	hint, _ := got["hint"].(string)
	if !strings.HasPrefix(hint, secret.Redacted) {
		t.Fatalf("hint = %q, want a redacted hint", hint)
	}
	assertNoToken(t, jres)
}

func TestLoginShowReportsAnAbsentEntry(t *testing.T) {
	(&fakeKeychain{backend: keyring.BackendKeychain, available: true}).install(t)

	res := runLogin(t, "", "--show", "--json")
	if res.code != 0 {
		t.Fatalf("exit %d, want 0\nstderr: %s", res.code, res.stderr)
	}
	got := decodeLine(t, res.stdout)
	if got["present"] != false {
		t.Fatalf("present = %v, want false", got["present"])
	}
	if got["hint"] != "" {
		t.Fatalf("hint = %v, want empty", got["hint"])
	}
}

func TestLoginRemoveDeletesTheEntry(t *testing.T) {
	k := (&fakeKeychain{backend: keyring.BackendKeychain, available: true}).install(t)
	k.stored[keyring.AccountTursoToken] = secret.New(loginFakeToken)

	res := runLogin(t, "", "--remove", "--yes", "--json")
	if res.code != 0 {
		t.Fatalf("exit %d, want 0\nstderr: %s", res.code, res.stderr)
	}
	got := decodeLine(t, res.stdout)
	if got["removed"] != true || got["stored"] != false {
		t.Fatalf("unexpected shape: %v", got)
	}
	if _, still := k.stored[keyring.AccountTursoToken]; still {
		t.Fatal("the entry survived --remove")
	}
	assertNoToken(t, res)
}

func TestLoginRejectsSQLiteAsAUsageError(t *testing.T) {
	(&fakeKeychain{backend: keyring.BackendKeychain, available: true}).install(t)

	res := runLogin(t, loginFakeToken+"\n", "--provider", "sqlite")
	if res.code != 2 {
		t.Fatalf("exit %d, want 2 (usage)\nstderr: %s", res.code, res.stderr)
	}
	if !strings.Contains(res.stderr, "needs no credential") {
		t.Fatalf("the message does not explain why: %q", res.stderr)
	}
	assertNoToken(t, res)
}

func TestLoginRejectsAnUnknownProvider(t *testing.T) {
	(&fakeKeychain{backend: keyring.BackendKeychain, available: true}).install(t)

	res := runLogin(t, loginFakeToken+"\n", "--provider", "nosuchprovider")
	if res.code != 2 {
		t.Fatalf("exit %d, want 2 (usage)\nstderr: %s", res.code, res.stderr)
	}
}

func TestLoginWithNothingOnStdinIsAUsageError(t *testing.T) {
	(&fakeKeychain{backend: keyring.BackendKeychain, available: true}).install(t)

	res := runLogin(t, "")
	if res.code != 2 {
		t.Fatalf("exit %d, want 2 (usage)\nstderr: %s", res.code, res.stderr)
	}
	if !strings.Contains(res.stderr, "never as a flag") {
		t.Fatalf("the message does not say where the token comes from: %q", res.stderr)
	}
}

func TestLoginRejectsShowAndRemoveTogether(t *testing.T) {
	(&fakeKeychain{backend: keyring.BackendKeychain, available: true}).install(t)

	if res := runLogin(t, "", "--show", "--remove"); res.code != 2 {
		t.Fatalf("exit %d, want 2 (usage)", res.code)
	}
}

// TestLoginHasNoTokenFlag guards the rule directly: a flag that takes a
// secret must not exist, so the obvious spelling must be rejected as unknown.
func TestLoginHasNoTokenFlag(t *testing.T) {
	(&fakeKeychain{backend: keyring.BackendKeychain, available: true}).install(t)

	res := runLogin(t, "", "--token", loginFakeToken)
	if res.code == 0 {
		t.Fatal("--token was accepted; there must be no flag that takes a secret")
	}
	// An unknown flag is rejected by the parser before this command runs, so
	// the code is the tree's existing one for a parse failure, not this
	// command's choice. What matters here is that the value is refused and
	// never echoed.
	if !strings.Contains(res.stderr, "not defined") {
		t.Fatalf("unexpected rejection: %q", res.stderr)
	}
	assertNoToken(t, res)
}

func TestLoginJSONErrorUsesTheExistingEnvelope(t *testing.T) {
	(&fakeKeychain{
		backend:   keyring.BackendKeychain,
		available: true,
		setErr:    errors.New("the keychain is locked"),
	}).install(t)

	res := runLogin(t, loginFakeToken+"\n", "--json")
	if res.code != 3 {
		t.Fatalf("exit %d, want 3 (config/credential)\nstdout: %s", res.code, res.stdout)
	}
	var envelope struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(res.stdout), &envelope); err != nil {
		t.Fatalf("stdout is not the error envelope: %q", res.stdout)
	}
	if envelope.Error.Code != "config" {
		t.Fatalf("error code = %q, want %q", envelope.Error.Code, "config")
	}
	assertNoToken(t, res)
}

// decodeLine parses one line of JSON from stdout, which also asserts that
// nothing but machine output reached it.
func decodeLine(t *testing.T, stdout string) map[string]any {
	t.Helper()
	var v map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(stdout)), &v); err != nil {
		t.Fatalf("stdout is not a single JSON object: %q: %v", stdout, err)
	}
	return v
}

// fakeTursoToken is what the fake Turso CLI mints. Every delegation test ends
// by asserting it reached neither stdout nor stderr.
const fakeTursoToken = "TOKEN_GOES_HERE_turso"

// fakeTurso is a stand-in for the Turso CLI. No test here runs the real one:
// that would put the developer's own credentials in the test output.
type fakeTurso struct {
	installed bool
	loggedIn  bool
	loginErr  error
	databases []string
	listErr   error
	url       string
	urlErr    error
	createErr error

	// created records the databases a token was minted for.
	created []string
}

func (f *fakeTurso) install(t *testing.T) *fakeTurso {
	t.Helper()
	available, loggedIn := tursoAvailable, tursoLoggedIn
	databases, create, url := tursoDatabases, tursoCreateToken, tursoDatabaseURL
	t.Cleanup(func() {
		tursoAvailable, tursoLoggedIn = available, loggedIn
		tursoDatabases, tursoCreateToken, tursoDatabaseURL = databases, create, url
	})

	tursoAvailable = func() bool { return f.installed }
	tursoLoggedIn = func(context.Context) (bool, error) { return f.loggedIn, f.loginErr }
	tursoDatabases = func(context.Context) ([]string, error) {
		if f.listErr != nil {
			return nil, f.listErr
		}
		return f.databases, nil
	}
	tursoCreateToken = func(_ context.Context, database string) (secret.Secret, error) {
		if f.createErr != nil {
			return secret.Secret{}, f.createErr
		}
		f.created = append(f.created, database)
		return secret.New(fakeTursoToken), nil
	}
	tursoDatabaseURL = func(_ context.Context, database string) (string, error) {
		if f.urlErr != nil {
			return "", f.urlErr
		}
		return f.url, nil
	}
	return f
}

// runLoginEnv is runLogin with extra environment variables, for the tests that
// need a configured Turso URL or a provider other than turso.
func runLoginEnv(t *testing.T, env map[string]string, stdin string, args ...string) result {
	t.Helper()
	var out, errb bytes.Buffer
	e := Env{
		Stdout: &out,
		Stderr: &errb,
		Stdin:  strings.NewReader(stdin),
		Getenv: func(key string) string { return env[key] },
	}
	code := RunWith(context.Background(), e, append([]string{"tdo", "login"}, args...))
	return result{code: code, stdout: out.String(), stderr: errb.String()}
}

// assertNoTursoToken is the assertion every delegation test ends with.
func assertNoTursoToken(t *testing.T, res result) {
	t.Helper()
	if strings.Contains(res.stdout, fakeTursoToken) {
		t.Fatalf("the minted token reached stdout: %q", res.stdout)
	}
	if strings.Contains(res.stderr, fakeTursoToken) {
		t.Fatalf("the minted token reached stderr: %q", res.stderr)
	}
}

func TestLoginTursoWithoutTheCLIFallsBackToStdin(t *testing.T) {
	(&fakeKeychain{backend: keyring.BackendKeychain, available: true}).install(t)
	f := (&fakeTurso{}).install(t)

	res := runLogin(t, loginFakeToken+"\n", "--json")
	if res.code != 0 {
		t.Fatalf("exit %d, want 0\nstderr: %s", res.code, res.stderr)
	}
	got := decodeLine(t, res.stdout)
	if got["stored"] != true {
		t.Fatalf("stored = %v, want true", got["stored"])
	}
	if got["source"] != providercli.SourceStdin {
		t.Fatalf("source = %v, want %q", got["source"], providercli.SourceStdin)
	}
	if !strings.Contains(res.stderr, "turso auth login") {
		t.Fatalf("stderr does not say how to install the CLI: %q", res.stderr)
	}
	if len(f.created) != 0 {
		t.Fatalf("an absent CLI minted a token: %v", f.created)
	}
	assertNoToken(t, res)
	assertNoTursoToken(t, res)
}

func TestLoginTursoNotLoggedInExitsConfig(t *testing.T) {
	(&fakeKeychain{backend: keyring.BackendKeychain, available: true}).install(t)
	f := (&fakeTurso{installed: true}).install(t)

	res := runLogin(t, "", "--json")
	if res.code != 3 {
		t.Fatalf("exit %d, want 3 (config)\nstdout: %s\nstderr: %s", res.code, res.stdout, res.stderr)
	}
	got := decodeLine(t, res.stdout)
	envelope, ok := got["error"].(map[string]any)
	if !ok {
		t.Fatalf("stdout is not the error envelope: %q", res.stdout)
	}
	if envelope["code"] != "config" {
		t.Fatalf("error code = %v, want %q", envelope["code"], "config")
	}
	message, _ := envelope["message"].(string)
	if !strings.Contains(message, "turso auth login") {
		t.Fatalf("the message does not say what to run: %q", message)
	}
	if len(f.created) != 0 {
		t.Fatalf("a logged-out CLI minted a token: %v", f.created)
	}
	assertNoTursoToken(t, res)
}

func TestLoginTursoWithOneDatabaseMintsAndStores(t *testing.T) {
	k := (&fakeKeychain{backend: keyring.BackendKeychain, available: true}).install(t)
	f := (&fakeTurso{
		installed: true,
		loggedIn:  true,
		databases: []string{"my-tasks"},
		url:       "libsql://my-tasks-acme.turso.io",
	}).install(t)

	res := runLogin(t, "", "--yes", "--json")
	if res.code != 0 {
		t.Fatalf("exit %d, want 0\nstdout: %s\nstderr: %s", res.code, res.stdout, res.stderr)
	}
	got := decodeLine(t, res.stdout)
	for key, want := range map[string]any{
		"provider": "turso",
		"account":  keyring.AccountTursoToken,
		"backend":  keyring.BackendKeychain,
		"stored":   true,
		"source":   providercli.SourceTursoCLI,
		"database": "my-tasks",
	} {
		if got[key] != want {
			t.Fatalf("%s = %v, want %v (all: %v)", key, got[key], want, got)
		}
	}
	if strings.Join(f.created, ",") != "my-tasks" {
		t.Fatalf("minted for %v, want my-tasks", f.created)
	}
	stored, ok := k.stored[keyring.AccountTursoToken]
	if !ok || stored.Reveal() != fakeTursoToken {
		t.Fatalf("the minted token was not stored: %v", k.stored)
	}
	// The URL hint is advice, so it belongs on stderr and nowhere else.
	if !strings.Contains(res.stderr, "libsql://my-tasks-acme.turso.io") {
		t.Fatalf("stderr carries no url hint: %q", res.stderr)
	}
	if strings.Contains(res.stdout, "libsql://") {
		t.Fatalf("the url hint reached stdout: %q", res.stdout)
	}
	assertNoTursoToken(t, res)
}

func TestLoginTursoWithThreeDatabasesAndNoFlagIsAUsageError(t *testing.T) {
	(&fakeKeychain{backend: keyring.BackendKeychain, available: true}).install(t)
	f := (&fakeTurso{
		installed: true,
		loggedIn:  true,
		databases: []string{"one", "two", "three"},
	}).install(t)

	res := runLogin(t, "", "--yes")
	if res.code != 2 {
		t.Fatalf("exit %d, want 2 (usage)\nstderr: %s", res.code, res.stderr)
	}
	if !strings.Contains(res.stderr, "--database") {
		t.Fatalf("the message does not name the flag: %q", res.stderr)
	}
	if len(f.created) != 0 {
		t.Fatalf("a token was minted for a guess: %v", f.created)
	}
	assertNoTursoToken(t, res)
}

func TestLoginTursoWithTheDatabaseFlag(t *testing.T) {
	(&fakeKeychain{backend: keyring.BackendKeychain, available: true}).install(t)
	f := (&fakeTurso{
		installed: true,
		loggedIn:  true,
		databases: []string{"one", "two", "three"},
		urlErr:    errors.New("no such database"),
	}).install(t)

	res := runLogin(t, "", "--json", "--yes", "--database", "two")
	if res.code != 0 {
		t.Fatalf("exit %d, want 0\nstdout: %s\nstderr: %s", res.code, res.stdout, res.stderr)
	}
	got := decodeLine(t, res.stdout)
	if got["database"] != "two" {
		t.Fatalf("database = %v, want %q", got["database"], "two")
	}
	if strings.Join(f.created, ",") != "two" {
		t.Fatalf("minted for %v, want two", f.created)
	}
	// `turso db show` failed, so the hint is skipped rather than reported.
	if strings.Contains(res.stderr, "[turso]") {
		t.Fatalf("a url hint was printed without a url: %q", res.stderr)
	}
	assertNoTursoToken(t, res)
}

// TestLoginTursoResolvesTheDatabaseFromTheConfiguredURL covers the middle
// resolution step: the name comes from the URL, with no list call at all.
func TestLoginTursoResolvesTheDatabaseFromTheConfiguredURL(t *testing.T) {
	(&fakeKeychain{backend: keyring.BackendKeychain, available: true}).install(t)
	f := (&fakeTurso{
		installed: true,
		loggedIn:  true,
		listErr:   errors.New("db list must not be needed here"),
		url:       "libsql://my-tasks-acme.turso.io",
	}).install(t)

	res := runLoginEnv(t, map[string]string{
		"TODOCLOUD_PROVIDER":  "turso",
		"TODOCLOUD_TURSO_URL": "libsql://my-tasks-acme.turso.io",
	}, "", "--yes", "--json")
	if res.code != 0 {
		t.Fatalf("exit %d, want 0\nstdout: %s\nstderr: %s", res.code, res.stdout, res.stderr)
	}
	if got := decodeLine(t, res.stdout); got["database"] != "my-tasks" {
		t.Fatalf("database = %v, want %q", got["database"], "my-tasks")
	}
	if strings.Join(f.created, ",") != "my-tasks" {
		t.Fatalf("minted for %v", f.created)
	}
	assertNoTursoToken(t, res)
}

// TestLoginTursoMatchesAnAmbiguousURLAgainstTheList covers a hostname whose
// dash split is uncertain.
func TestLoginTursoMatchesAnAmbiguousURLAgainstTheList(t *testing.T) {
	(&fakeKeychain{backend: keyring.BackendKeychain, available: true}).install(t)
	f := (&fakeTurso{
		installed: true,
		loggedIn:  true,
		databases: []string{"todo", "notes"},
		url:       "libsql://todo.turso.io",
	}).install(t)

	res := runLoginEnv(t, map[string]string{
		"TODOCLOUD_PROVIDER":  "turso",
		"TODOCLOUD_TURSO_URL": "libsql://todo.turso.io",
	}, "", "--yes", "--json")
	if res.code != 0 {
		t.Fatalf("exit %d, want 0\nstderr: %s", res.code, res.stderr)
	}
	if got := decodeLine(t, res.stdout); got["database"] != "todo" {
		t.Fatalf("database = %v, want %q", got["database"], "todo")
	}
	if strings.Join(f.created, ",") != "todo" {
		t.Fatalf("minted for %v", f.created)
	}
	assertNoTursoToken(t, res)
}

// TestLoginTursoDiscardsATokenItCannotStore is the rule that matters most
// here: a token we cannot store safely is dropped, never printed.
func TestLoginTursoDiscardsATokenItCannotStore(t *testing.T) {
	(&fakeKeychain{
		backend:   keyring.BackendKeychain,
		available: true,
		setErr:    keyring.ErrWriteUnsupported,
	}).install(t)
	(&fakeTurso{
		installed: true,
		loggedIn:  true,
		databases: []string{"my-tasks"},
		url:       "libsql://my-tasks-acme.turso.io",
	}).install(t)

	res := runLogin(t, "", "--yes", "--json")
	if res.code != 0 {
		t.Fatalf("exit %d, want 0\nstderr: %s", res.code, res.stderr)
	}
	got := decodeLine(t, res.stdout)
	if got["stored"] != false {
		t.Fatalf("stored = %v, want false", got["stored"])
	}
	if got["backend"] != keyring.BackendNone {
		t.Fatalf("backend = %v, want %q", got["backend"], keyring.BackendNone)
	}
	if got["source"] != providercli.SourceTursoCLI {
		t.Fatalf("source = %v, want %q", got["source"], providercli.SourceTursoCLI)
	}
	instructions, _ := got["instructions"].(string)
	if !strings.Contains(instructions, "turso db tokens create my-tasks") {
		t.Fatalf("instructions = %q", instructions)
	}
	assertNoTursoToken(t, res)

	// And the same without --json, where a careless implementation would
	// print the token for the user to copy.
	(&fakeTurso{
		installed: true,
		loggedIn:  true,
		databases: []string{"my-tasks"},
		url:       "libsql://my-tasks-acme.turso.io",
	}).install(t)
	human := runLogin(t, "", "--yes")
	if human.code != 0 {
		t.Fatalf("exit %d, want 0\nstderr: %s", human.code, human.stderr)
	}
	if !strings.Contains(human.stderr, "discarded") {
		t.Fatalf("stderr does not say the token was discarded: %q", human.stderr)
	}
	assertNoTursoToken(t, human)
}

func TestLoginTursoReportsAFailedMintWithoutTheToken(t *testing.T) {
	(&fakeKeychain{backend: keyring.BackendKeychain, available: true}).install(t)
	(&fakeTurso{
		installed: true,
		loggedIn:  true,
		databases: []string{"my-tasks"},
		createErr: errors.New("turso exited with status 1: quota exceeded"),
	}).install(t)

	res := runLogin(t, "", "--yes")
	if res.code != 3 {
		t.Fatalf("exit %d, want 3 (config)\nstderr: %s", res.code, res.stderr)
	}
	if !strings.Contains(res.stderr, "quota exceeded") {
		t.Fatalf("the child's stderr was dropped: %q", res.stderr)
	}
	assertNoTursoToken(t, res)
}

// A config that still names firestore gets told what happened. The provider
// was built and removed (PLAN.md §2), so "unknown provider" would be both
// unhelpful and untrue, and promising a later version would be a lie.
func TestLoginForTheRemovedFirestoreProviderSaysSo(t *testing.T) {
	(&fakeKeychain{backend: keyring.BackendKeychain, available: true}).install(t)

	// Exit 3, the config code — the same answer every other command gives
	// for a removed provider. One cause reported two ways is a trap for a
	// caller that branches on the exit code.
	res := runLoginEnv(t, map[string]string{"TODOCLOUD_PROVIDER": "firestore"}, "", "--json")
	if res.code != 3 {
		t.Fatalf("exit %d, want 3 (config)\nstdout: %s\nstderr: %s", res.code, res.stdout, res.stderr)
	}
	for _, want := range []string{"removed", "docs/providers.md"} {
		if !strings.Contains(res.stdout, want) {
			t.Errorf("the message does not mention %q: %s", want, res.stdout)
		}
	}
}

// TestLoginD1WarnsAboutTheAccountWideToken covers SECURITY.md's warning, and
// also that no provider CLI is consulted for D1 — wrangler must never run.
func TestLoginD1WarnsAboutTheAccountWideToken(t *testing.T) {
	(&fakeKeychain{backend: keyring.BackendKeychain, available: true}).install(t)
	f := (&fakeTurso{installed: true, loggedIn: true, databases: []string{"x"}}).install(t)

	res := runLoginEnv(t, map[string]string{"TODOCLOUD_PROVIDER": "d1"}, loginFakeToken+"\n", "--json")
	if res.code != 0 {
		t.Fatalf("exit %d, want 0\nstderr: %s", res.code, res.stderr)
	}
	got := decodeLine(t, res.stdout)
	if got["stored"] != true || got["account"] != keyring.AccountD1Token {
		t.Fatalf("unexpected shape: %v", got)
	}
	// Every stored token reports its source, so a caller does not have to
	// know which providers support CLI delegation to read the shape.
	if got["source"] != "stdin" {
		t.Fatalf("source = %v, want \"stdin\": %v", got["source"], got)
	}
	if !strings.Contains(res.stderr, "every D1 database") {
		t.Fatalf("the account-wide warning is missing: %q", res.stderr)
	}
	if len(f.created) != 0 {
		t.Fatalf("d1 reached the turso CLI: %v", f.created)
	}
	assertNoToken(t, res)
}

func TestLoginDatabaseFlagIsRejectedForOtherProviders(t *testing.T) {
	(&fakeKeychain{backend: keyring.BackendKeychain, available: true}).install(t)

	res := runLoginEnv(t, map[string]string{"TODOCLOUD_PROVIDER": "d1"}, "", "--database", "x")
	if res.code != 2 {
		t.Fatalf("exit %d, want 2 (usage)\nstderr: %s", res.code, res.stderr)
	}
	if !strings.Contains(res.stderr, "turso provider only") {
		t.Fatalf("unexpected message: %q", res.stderr)
	}
}

// TestLoginShowAndRemoveAreUnaffectedByDelegation guards the shapes that must
// not change: --show and --remove never consult a provider CLI.
func TestLoginShowAndRemoveAreUnaffectedByDelegation(t *testing.T) {
	k := (&fakeKeychain{backend: keyring.BackendKeychain, available: true}).install(t)
	k.stored[keyring.AccountTursoToken] = secret.New(loginFakeToken)
	f := (&fakeTurso{installed: true, loggedIn: true, databases: []string{"my-tasks"}}).install(t)

	show := runLogin(t, "", "--show", "--json")
	got := decodeLine(t, show.stdout)
	if got["present"] != true {
		t.Fatalf("present = %v, want true", got["present"])
	}
	if _, ok := got["database"]; ok {
		t.Fatalf("--show gained a database key: %v", got)
	}

	remove := runLogin(t, "", "--remove", "--yes", "--json")
	if got := decodeLine(t, remove.stdout); got["removed"] != true {
		t.Fatalf("removed = %v, want true", got["removed"])
	}
	if len(f.created) != 0 {
		t.Fatalf("--show/--remove reached the turso CLI: %v", f.created)
	}
	assertNoToken(t, show)
	assertNoToken(t, remove)
}

func TestDoctorProviderCLICheckForTurso(t *testing.T) {
	cases := []struct {
		name      string
		turso     fakeTurso
		wantOK    bool
		wantParts []string
	}{
		{"not installed", fakeTurso{}, false, []string{"not installed", "turso auth login"}},
		{"not logged in", fakeTurso{installed: true}, false, []string{"not logged in"}},
		{"logged in", fakeTurso{installed: true, loggedIn: true}, true, []string{"installed and logged in"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := tc.turso
			(&f).install(t)
			a := &app{env: Env{Getenv: func(string) string { return "" }}}
			c := a.providerCLICheck(context.Background(), "turso")
			if c.Name != "provider_cli" {
				t.Fatalf("name = %q", c.Name)
			}
			if c.OK != tc.wantOK {
				t.Fatalf("ok = %v, want %v (detail %q)", c.OK, tc.wantOK, c.Detail)
			}
			for _, part := range tc.wantParts {
				if !strings.Contains(c.Detail, part) {
					t.Fatalf("detail %q does not mention %q", c.Detail, part)
				}
			}
			if strings.Contains(c.Detail, fakeTursoToken) || strings.Contains(c.Detail, loginFakeToken) {
				t.Fatalf("the detail carries a token: %q", c.Detail)
			}
		})
	}
}

func TestDoctorProviderCLICheckForTheOtherProviders(t *testing.T) {
	a := &app{env: Env{Getenv: func(string) string { return "" }}}

	for _, provider := range []string{"d1", "sqlite", "firestore"} {
		c := a.providerCLICheck(context.Background(), config.Provider(provider))
		if !c.OK || !strings.Contains(c.Detail, "no provider CLI is involved") {
			t.Fatalf("%s check = %+v", provider, c)
		}
		// CLAUDE.md §1.4: wrangler is never run, and never suggested.
		if strings.Contains(strings.ToLower(c.Detail), "wrangler") {
			t.Fatalf("%s check mentions wrangler: %q", provider, c.Detail)
		}
	}
}

// installTerminalStdin makes the confirmation guards in login.go believe
// there is a user at stdin. The real check needs an *os.File tty, which a
// test must never require: these tests answer the prompt from a string
// reader instead.
func installTerminalStdin(t *testing.T) {
	t.Helper()
	old := loginStdinIsTerminal
	t.Cleanup(func() { loginStdinIsTerminal = old })
	loginStdinIsTerminal = func(*app) bool { return true }
}

func TestLoginRemoveWithoutATerminalRefusesInsteadOfDeleting(t *testing.T) {
	k := (&fakeKeychain{backend: keyring.BackendKeychain, available: true}).install(t)
	k.stored[keyring.AccountTursoToken] = secret.New(loginFakeToken)

	res := runLogin(t, "", "--remove")
	if res.code != 2 {
		t.Fatalf("exit %d, want 2 (usage)\nstderr: %s", res.code, res.stderr)
	}
	if !strings.Contains(res.stderr, "refusing to delete the stored turso token") ||
		!strings.Contains(res.stderr, "--yes") {
		t.Fatalf("the refusal does not name the provider and the opt-in: %q", res.stderr)
	}
	if _, still := k.stored[keyring.AccountTursoToken]; !still {
		t.Fatal("the entry was deleted despite the refusal")
	}
	assertNoToken(t, res)
}

func TestLoginRemoveDeclinedOnATerminalDeletesNothing(t *testing.T) {
	k := (&fakeKeychain{backend: keyring.BackendKeychain, available: true}).install(t)
	k.stored[keyring.AccountTursoToken] = secret.New(loginFakeToken)
	installTerminalStdin(t)

	res := runLogin(t, "n\n", "--remove", "--json")
	if res.code != 0 {
		t.Fatalf("exit %d, want 0 (declining is not a failure)\nstderr: %s", res.code, res.stderr)
	}
	got := decodeLine(t, res.stdout)
	if got["removed"] != false || got["stored"] != true {
		t.Fatalf("unexpected shape: %v", got)
	}
	if _, still := k.stored[keyring.AccountTursoToken]; !still {
		t.Fatal("the entry was deleted after the prompt was declined")
	}
	// The prompt itself belongs on stderr, so stdout stays one JSON value.
	if !strings.Contains(res.stderr, "It cannot be recovered.") {
		t.Fatalf("the prompt did not reach stderr: %q", res.stderr)
	}
	assertNoToken(t, res)
}

func TestLoginTursoMintWithoutATerminalRefusesWithoutCallingTurso(t *testing.T) {
	k := (&fakeKeychain{backend: keyring.BackendKeychain, available: true}).install(t)
	f := (&fakeTurso{
		installed: true,
		loggedIn:  true,
		databases: []string{"example"},
		url:       "libsql://example.turso.io",
	}).install(t)

	// A token on stdin must not be read as a fallback: that would store a
	// different credential than the caller asked for.
	res := runLogin(t, loginFakeToken+"\n")
	if res.code != 2 {
		t.Fatalf("exit %d, want 2 (usage)\nstderr: %s", res.code, res.stderr)
	}
	if !strings.Contains(res.stderr, `refusing to mint a new turso token for database "example"`) ||
		!strings.Contains(res.stderr, "--yes") {
		t.Fatalf("the refusal does not name the database and the opt-in: %q", res.stderr)
	}
	if len(f.created) != 0 {
		t.Fatalf("the turso CLI was asked to mint a token: %v", f.created)
	}
	if len(k.stored) != 0 {
		t.Fatalf("something was stored despite the refusal: %v", k.stored)
	}
	assertNoToken(t, res)
	assertNoTursoToken(t, res)
}

func TestLoginTursoMintDeclinedOnATerminalMintsNothing(t *testing.T) {
	k := (&fakeKeychain{backend: keyring.BackendKeychain, available: true}).install(t)
	f := (&fakeTurso{
		installed: true,
		loggedIn:  true,
		databases: []string{"example"},
		url:       "libsql://example.turso.io",
	}).install(t)
	installTerminalStdin(t)

	res := runLogin(t, "n\n", "--json")
	if res.code != 0 {
		t.Fatalf("exit %d, want 0 (declining is not a failure)\nstderr: %s", res.code, res.stderr)
	}
	got := decodeLine(t, res.stdout)
	for key, want := range map[string]any{
		"provider": "turso",
		"account":  keyring.AccountTursoToken,
		"backend":  keyring.BackendKeychain,
		"stored":   false,
		"source":   providercli.SourceTursoCLI,
		"database": "example",
	} {
		if got[key] != want {
			t.Fatalf("%s = %v, want %v (all: %v)", key, got[key], want, got)
		}
	}
	if len(f.created) != 0 {
		t.Fatalf("a token was minted after the prompt was declined: %v", f.created)
	}
	if len(k.stored) != 0 {
		t.Fatalf("something was stored after the prompt was declined: %v", k.stored)
	}
	if !strings.Contains(res.stderr, "no token was created on your Turso account") {
		t.Fatalf("stderr does not say nothing was created: %q", res.stderr)
	}
	assertNoToken(t, res)
	assertNoTursoToken(t, res)
}
