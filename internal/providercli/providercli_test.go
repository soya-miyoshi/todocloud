package providercli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/soya-miyoshi/todocloud/internal/secret"
)

// fakeToken is the value every test here mints. No test may ever see it in an
// error, a formatted value or a JSON document.
const fakeToken = "TOKEN_GOES_HERE_turso"

// installRunner replaces both exec indirections, so that no test in this
// package can reach a real provider CLI.
func installRunner(t *testing.T, present bool, fn Runner) *[][]string {
	t.Helper()
	oldLook, oldRun := lookPath, runner
	t.Cleanup(func() { lookPath, runner = oldLook, oldRun })

	var calls [][]string
	lookPath = func(file string) (string, error) {
		if !present {
			return "", exec.ErrNotFound
		}
		return "/fake/bin/" + file, nil
	}
	runner = func(ctx context.Context, name string, args ...string) Output {
		calls = append(calls, append([]string{name}, args...))
		if fn == nil {
			return Output{}
		}
		return fn(ctx, name, args...)
	}
	return &calls
}

// exitStatus builds a real *exec.ExitError, so the code under test sees the
// same error type a failing child produces.
func exitStatus(t *testing.T, code int) error {
	t.Helper()
	cmd := exec.Command("sh", "-c", fmt.Sprintf("exit %d", code))
	err := cmd.Run()
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) {
		t.Fatalf("could not produce an ExitError: %v", err)
	}
	return err
}

// commandTimeoutForTest shortens the child-process deadline so a timeout test
// does not take ten seconds.
func commandTimeoutForTest(t *testing.T, d time.Duration) func() {
	t.Helper()
	old := commandTimeout
	commandTimeout = d
	return func() { commandTimeout = old }
}

func TestDatabaseFromURL(t *testing.T) {
	cases := []struct {
		name string
		url  string
		want string
		ok   bool
	}{
		{"plain libsql url", "libsql://my-tasks-myname.turso.io", "my-tasks", true},
		{"https url", "https://todo-acme.turso.io", "todo", true},
		{"with a path", "libsql://todo-acme.turso.io/", "todo", true},
		{"with a port", "libsql://todo-acme.turso.io:443", "todo", true},
		{"uppercase host", "libsql://TODO-ACME.turso.io", "todo", true},
		{"no scheme", "todo-acme.turso.io", "todo", true},
		{"several dashes keeps all but the last", "libsql://a-b-c-org.turso.io", "a-b-c", true},
		{"no dash is uncertain", "libsql://todo.turso.io", "", false},
		{"trailing dash is uncertain", "libsql://todo-.turso.io", "", false},
		{"leading dash is uncertain", "libsql://-org.turso.io", "", false},
		{"not a turso host", "libsql://todo-acme.example.com", "", false},
		{"extra label", "libsql://a.todo-acme.turso.io", "", false},
		{"empty", "", "", false},
		{"only the suffix", "libsql://.turso.io", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := DatabaseFromURL(tc.url)
			if got != tc.want || ok != tc.ok {
				t.Fatalf("DatabaseFromURL(%q) = (%q, %v), want (%q, %v)", tc.url, got, ok, tc.want, tc.ok)
			}
		})
	}
}

func TestMatchDatabaseInURL(t *testing.T) {
	cases := []struct {
		name      string
		url       string
		databases []string
		want      string
		ok        bool
	}{
		{"exact label", "libsql://todo.turso.io", []string{"todo", "other"}, "todo", true},
		{"name plus organization", "libsql://my-tasks-acme.turso.io", []string{"my-tasks"}, "my-tasks", true},
		{"longest name wins", "libsql://my-tasks-acme.turso.io", []string{"my", "my-tasks"}, "my-tasks", true},
		{"no match", "libsql://todo-acme.turso.io", []string{"notes", "other"}, "", false},
		{"empty list", "libsql://todo-acme.turso.io", nil, "", false},
		{"not a turso host", "libsql://todo-acme.example.com", []string{"todo"}, "", false},
		{"empty names ignored", "libsql://todo.turso.io", []string{"", "todo"}, "todo", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := MatchDatabaseInURL(tc.url, tc.databases)
			if got != tc.want || ok != tc.ok {
				t.Fatalf("MatchDatabaseInURL(%q, %v) = (%q, %v), want (%q, %v)",
					tc.url, tc.databases, got, ok, tc.want, tc.ok)
			}
		})
	}
}

func TestTursoAvailable(t *testing.T) {
	installRunner(t, false, nil)
	if TursoAvailable() {
		t.Fatal("TursoAvailable reported an absent binary as present")
	}
	installRunner(t, true, nil)
	if !TursoAvailable() {
		t.Fatal("TursoAvailable reported a present binary as absent")
	}
}

// TestTursoLoggedInReadsOnlyTheExitStatus is the point of the function:
// `turso auth token` prints a credential, so its stdout must not be read,
// returned or placed in an error.
func TestTursoLoggedInReadsOnlyTheExitStatus(t *testing.T) {
	calls := installRunner(t, true, func(context.Context, string, ...string) Output {
		return Output{Stdout: fakeToken + "\n"}
	})

	loggedIn, err := TursoLoggedIn(context.Background())
	if err != nil {
		t.Fatalf("TursoLoggedIn: %v", err)
	}
	if !loggedIn {
		t.Fatal("a zero exit status should mean logged in")
	}
	want := []string{"turso", "auth", "token"}
	if len(*calls) != 1 || strings.Join((*calls)[0], " ") != strings.Join(want, " ") {
		t.Fatalf("ran %v, want %v", *calls, want)
	}
}

func TestTursoLoggedInTreatsANonZeroExitAsNotLoggedIn(t *testing.T) {
	installRunner(t, true, func(context.Context, string, ...string) Output {
		return Output{Stdout: fakeToken, Stderr: "not logged in", Err: exitStatus(t, 1)}
	})

	loggedIn, err := TursoLoggedIn(context.Background())
	if err != nil {
		t.Fatalf("a refused session is not an error: %v", err)
	}
	if loggedIn {
		t.Fatal("a non-zero exit status should mean not logged in")
	}
}

// TestTursoLoggedInNeverPutsStdoutInItsError covers the failure path, where a
// careless implementation would quote the child's output.
func TestTursoLoggedInNeverPutsStdoutInItsError(t *testing.T) {
	installRunner(t, true, func(context.Context, string, ...string) Output {
		return Output{
			Stdout: fakeToken,
			Stderr: "turso: something went wrong",
			Err:    errors.New("exec: signal: killed"),
		}
	})

	loggedIn, err := TursoLoggedIn(context.Background())
	if err == nil {
		t.Fatal("a non-exit failure should be reported as an error")
	}
	if loggedIn {
		t.Fatal("a failed command must not report a session")
	}
	if strings.Contains(err.Error(), fakeToken) {
		t.Fatalf("the child's stdout reached the error: %q", err)
	}
	if !strings.Contains(err.Error(), "something went wrong") {
		t.Fatalf("the error drops the child's stderr: %q", err)
	}
}

func TestTursoLoggedInWithoutTheBinary(t *testing.T) {
	installRunner(t, false, func(context.Context, string, ...string) Output {
		t.Fatal("no command may run when the binary is absent")
		return Output{}
	})
	if _, err := TursoLoggedIn(context.Background()); err == nil {
		t.Fatal("an absent binary should be an error, not a silent false")
	}
}

func TestTursoLoggedInReportsATimeout(t *testing.T) {
	installRunner(t, true, func(ctx context.Context, _ string, _ ...string) Output {
		<-ctx.Done()
		return Output{Err: ctx.Err()}
	})

	// The real timeout is ten seconds; shorten it so the test is fast.
	restore := commandTimeoutForTest(t, 20*time.Millisecond)
	defer restore()

	loggedIn, err := TursoLoggedIn(context.Background())
	if err == nil {
		t.Fatal("a hung CLI must be reported, not waited on forever")
	}
	if loggedIn {
		t.Fatal("a timed-out command must not report a session")
	}
	if !strings.Contains(err.Error(), "did not finish within") {
		t.Fatalf("the error does not name the timeout: %q", err)
	}
}

func TestTursoDatabasesParsesTheTable(t *testing.T) {
	installRunner(t, true, func(context.Context, string, ...string) Output {
		return Output{Stdout: "NAME      GROUP     URL\n" +
			"my-tasks  default   libsql://my-tasks-acme.turso.io\n" +
			"notes     default   libsql://notes-acme.turso.io\n\n"}
	})

	names, err := TursoDatabases(context.Background())
	if err != nil {
		t.Fatalf("TursoDatabases: %v", err)
	}
	if strings.Join(names, ",") != "my-tasks,notes" {
		t.Fatalf("names = %v", names)
	}
}

func TestTursoDatabasesWithEmptyOutput(t *testing.T) {
	installRunner(t, true, func(context.Context, string, ...string) Output {
		return Output{}
	})
	names, err := TursoDatabases(context.Background())
	if err != nil {
		t.Fatalf("TursoDatabases: %v", err)
	}
	if len(names) != 0 {
		t.Fatalf("names = %v, want none", names)
	}
}

func TestTursoDatabasesReportsAFailure(t *testing.T) {
	installRunner(t, true, func(context.Context, string, ...string) Output {
		return Output{Stdout: fakeToken, Stderr: "not logged in", Err: exitStatus(t, 2)}
	})
	_, err := TursoDatabases(context.Background())
	if err == nil {
		t.Fatal("a non-zero exit should be an error")
	}
	if !strings.Contains(err.Error(), "status 2") {
		t.Fatalf("the error does not report the exit status: %q", err)
	}
	if strings.Contains(err.Error(), fakeToken) {
		t.Fatalf("the child's stdout reached the error: %q", err)
	}
}

func TestTursoCreateTokenReturnsASecret(t *testing.T) {
	calls := installRunner(t, true, func(context.Context, string, ...string) Output {
		return Output{Stdout: fakeToken + "\n"}
	})

	token, err := TursoCreateToken(context.Background(), "my-tasks")
	if err != nil {
		t.Fatalf("TursoCreateToken: %v", err)
	}
	if token.Reveal() != fakeToken {
		t.Fatalf("the token was altered: %q", token.Reveal())
	}
	want := "turso db tokens create my-tasks"
	if len(*calls) != 1 || strings.Join((*calls)[0], " ") != want {
		t.Fatalf("ran %v, want %q", *calls, want)
	}

	// The whole reason this is a secret.Secret: no rendering path discloses it.
	rendered := []string{
		fmt.Sprint(token),
		fmt.Sprintf("%v %s %q %#v", token, token, token, token),
		fmt.Sprintf("%v", struct{ Token secret.Secret }{token}),
	}
	data, err := json.Marshal(map[string]any{"token": token})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	rendered = append(rendered, string(data))
	for _, s := range rendered {
		if strings.Contains(s, fakeToken) {
			t.Fatalf("a rendering disclosed the token: %q", s)
		}
	}
}

func TestTursoCreateTokenTrimsExactlyOneNewline(t *testing.T) {
	installRunner(t, true, func(context.Context, string, ...string) Output {
		return Output{Stdout: fakeToken + "\n\n"}
	})
	token, err := TursoCreateToken(context.Background(), "db")
	if err != nil {
		t.Fatalf("TursoCreateToken: %v", err)
	}
	if token.Reveal() != fakeToken+"\n" {
		t.Fatalf("more than one line ending was trimmed: %q", token.Reveal())
	}
}

func TestTursoCreateTokenWithEmptyOutput(t *testing.T) {
	installRunner(t, true, func(context.Context, string, ...string) Output {
		return Output{}
	})
	if _, err := TursoCreateToken(context.Background(), "db"); err == nil {
		t.Fatal("an empty mint should be an error, not an empty secret")
	}
}

// TestTursoCreateTokenScrubsItsOwnTokenFromStderr covers a CLI that echoes
// what it printed into its diagnostics.
func TestTursoCreateTokenScrubsItsOwnTokenFromStderr(t *testing.T) {
	installRunner(t, true, func(context.Context, string, ...string) Output {
		return Output{
			Stdout: fakeToken + "\n",
			Stderr: "failed after printing " + fakeToken,
			Err:    exitStatus(t, 1),
		}
	})
	_, err := TursoCreateToken(context.Background(), "db")
	if err == nil {
		t.Fatal("a non-zero exit should be an error")
	}
	if strings.Contains(err.Error(), fakeToken) {
		t.Fatalf("the token survived into the error: %q", err)
	}
	if !strings.Contains(err.Error(), secret.Redacted) {
		t.Fatalf("the error should show it was redacted: %q", err)
	}
}

func TestTursoCreateTokenReportsATimeout(t *testing.T) {
	installRunner(t, true, func(ctx context.Context, _ string, _ ...string) Output {
		<-ctx.Done()
		return Output{Err: ctx.Err()}
	})
	restore := commandTimeoutForTest(t, 20*time.Millisecond)
	defer restore()

	if _, err := TursoCreateToken(context.Background(), "db"); err == nil {
		t.Fatal("a hung mint must be reported")
	}
}

func TestTursoCreateTokenRefusesAFlagShapedName(t *testing.T) {
	installRunner(t, true, func(context.Context, string, ...string) Output {
		t.Fatal("a rejected name must not reach a child process")
		return Output{}
	})
	for _, name := range []string{"", "--help", "a b", "a;rm -rf /"} {
		if _, err := TursoCreateToken(context.Background(), name); err == nil {
			t.Fatalf("name %q was accepted", name)
		}
	}
}

func TestTursoDatabaseURL(t *testing.T) {
	calls := installRunner(t, true, func(context.Context, string, ...string) Output {
		return Output{Stdout: "libsql://my-tasks-acme.turso.io\n"}
	})
	url, err := TursoDatabaseURL(context.Background(), "my-tasks")
	if err != nil {
		t.Fatalf("TursoDatabaseURL: %v", err)
	}
	if url != "libsql://my-tasks-acme.turso.io" {
		t.Fatalf("url = %q", url)
	}
	want := "turso db show my-tasks --url"
	if len(*calls) != 1 || strings.Join((*calls)[0], " ") != want {
		t.Fatalf("ran %v, want %q", *calls, want)
	}
}

func TestTursoDatabaseURLFailures(t *testing.T) {
	installRunner(t, true, func(context.Context, string, ...string) Output {
		return Output{Stderr: "no such database", Err: exitStatus(t, 1)}
	})
	if _, err := TursoDatabaseURL(context.Background(), "nope"); err == nil {
		t.Fatal("a non-zero exit should be an error")
	}

	installRunner(t, true, func(context.Context, string, ...string) Output {
		return Output{}
	})
	if _, err := TursoDatabaseURL(context.Background(), "db"); err == nil {
		t.Fatal("empty output should be an error")
	}
}

func TestExecRunnerAgainstAFakeExecutable(t *testing.T) {
	// The fake is a #!/bin/sh script, which CreateProcess cannot start: a
	// batch file would need cmd.exe in front of it and would no longer be
	// the same test. What execRunner does with a child's streams and exit
	// status is covered on every platform through the injected runner; this
	// test is here for the one path that needs a real process.
	if runtime.GOOS == "windows" {
		t.Skip("a shell script is not executable on windows")
	}

	dir := t.TempDir()
	script := filepath.Join(dir, "fake-turso")
	body := "#!/bin/sh\nprintf '%s\\n' \"" + fakeToken + "\"\nprintf 'a note\\n' >&2\nexit 7\n"
	if err := os.WriteFile(script, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}

	out := execRunner(context.Background(), script)
	if out.Err == nil {
		t.Fatal("the fake exits 7, so an error is expected")
	}
	if trimOneNewline(out.Stdout) != fakeToken {
		t.Fatalf("stdout = %q", out.Stdout)
	}
	if strings.TrimSpace(out.Stderr) != "a note" {
		t.Fatalf("stderr = %q", out.Stderr)
	}
	// childError is the only path from an Output to an error, and the token
	// must not survive it.
	err := childError("fake-turso", Output{Stderr: out.Stderr, Err: out.Err})
	if strings.Contains(err.Error(), fakeToken) {
		t.Fatalf("the token reached the error: %q", err)
	}
	if !strings.Contains(err.Error(), "status 7") {
		t.Fatalf("the error does not report the exit status: %q", err)
	}
}
