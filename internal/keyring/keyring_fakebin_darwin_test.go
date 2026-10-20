//go:build darwin

package keyring

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/soya-miyoshi/todocloud/internal/secret"
)

// The real `security` binary is never executed by anything in this file.
// Instead a shell script called `security` is put at the front of PATH, so the
// package's own exec calls reach a stand-in whose output each test chooses.
// That is what makes the read, write and delete paths testable at all: the
// developer's keychain is neither read nor written, which CLAUDE.md §1.5
// requires, and the results do not depend on what is in it.

// sentinelKeyringToken is the fake credential these tests feed through the
// package. It is obviously not a real token, and no error message, no argv
// element and no instruction string may ever contain it.
const sentinelKeyringToken = "TOKEN_GOES_HERE_keyring_7f3a"

// fakeSecurity is a scripted stand-in for the `security` binary.
type fakeSecurity struct {
	// stdout and stderr are what the child writes on each stream.
	stdout string
	stderr string
	// exitCode is the status it exits with.
	exitCode int

	// argvPath and stdinPath are the files the child records its arguments
	// and its standard input in, so a test can assert where the secret went.
	argvPath  string
	stdinPath string
}

// install writes the script and puts its directory at the front of PATH.
func (f *fakeSecurity) install(t *testing.T) *fakeSecurity {
	t.Helper()
	dir := t.TempDir()
	f.argvPath = filepath.Join(dir, "argv")
	f.stdinPath = filepath.Join(dir, "stdin")

	// Single-quoted shell literals, so nothing in the scripted output is
	// re-interpreted. None of the fixtures contains a quote.
	for _, s := range []string{f.stdout, f.stderr} {
		if strings.Contains(s, "'") {
			t.Fatalf("a fixture with a single quote cannot be embedded in the script: %q", s)
		}
	}
	script := "#!/bin/sh\n" +
		"for arg in \"$@\"; do printf '%s\\n' \"$arg\" >> '" + f.argvPath + "'; done\n" +
		"cat >> '" + f.stdinPath + "' 2>/dev/null\n" +
		"printf '%s' '" + f.stdout + "'\n" +
		"printf '%s' '" + f.stderr + "' >&2\n" +
		"exit " + itoa(f.exitCode) + "\n"

	path := filepath.Join(dir, securityBin)
	if err := os.WriteFile(path, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return f
}

// argv returns the arguments the child was given, one per line.
func (f *fakeSecurity) argv(t *testing.T) []string {
	t.Helper()
	return f.readLines(t, f.argvPath)
}

// stdin returns everything written to the child's standard input.
func (f *fakeSecurity) stdin(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile(f.stdinPath)
	if err != nil {
		if os.IsNotExist(err) {
			return ""
		}
		t.Fatal(err)
	}
	return string(data)
}

func (f *fakeSecurity) readLines(t *testing.T, path string) []string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSuffix(string(data), "\n"), "\n")
	if len(lines) == 1 && lines[0] == "" {
		return nil
	}
	return lines
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var digits []byte
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	return string(digits)
}

func TestGetReadsTheValueTheChildPrints(t *testing.T) {
	cases := []struct {
		name   string
		stdout string
		want   string
	}{
		{"unix terminator", sentinelKeyringToken + "\n", sentinelKeyringToken},
		{"windows terminator", sentinelKeyringToken + "\r\n", sentinelKeyringToken},
		{"no terminator", sentinelKeyringToken, sentinelKeyringToken},
		{"two terminators keep one", sentinelKeyringToken + "\n\n", sentinelKeyringToken + "\n"},
		// A stored value that happens to be the redaction marker is still a
		// value: it must come back as it was stored, and still be unprintable.
		{"the redaction marker itself", secret.Redacted + "\n", secret.Redacted},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			(&fakeSecurity{stdout: c.stdout}).install(t)

			got, present, err := Get(context.Background(), AccountTursoToken)
			if err != nil {
				t.Fatalf("Get: %v", err)
			}
			if !present {
				t.Fatal("Get reported no entry although the child printed one")
			}
			if got.Reveal() != c.want {
				t.Fatalf("Get returned %q, want %q", got.Reveal(), c.want)
			}
			// Whatever the value is, rendering it must not disclose it.
			if rendered := got.String(); rendered != secret.Redacted {
				t.Fatalf("the value rendered as %q", rendered)
			}
		})
	}
}

func TestGetArgvNeverCarriesASecret(t *testing.T) {
	f := (&fakeSecurity{stdout: sentinelKeyringToken + "\n"}).install(t)
	if _, _, err := Get(context.Background(), AccountD1Token); err != nil {
		t.Fatalf("Get: %v", err)
	}
	argv := f.argv(t)
	want := []string{"find-generic-password", "-s", Service, "-a", AccountD1Token, "-w"}
	if strings.Join(argv, " ") != strings.Join(want, " ") {
		t.Fatalf("argv = %q, want %q", argv, want)
	}
}

func TestGetReportsAMissingEntryAsAnAbsence(t *testing.T) {
	cases := []struct {
		name string
		fake fakeSecurity
	}{
		{"the documented not-found status", fakeSecurity{exitCode: notFoundExitCode}},
		// An item that exists with an empty password is not a usable
		// credential; reporting it as present would hide the real problem.
		{"an entry with an empty password", fakeSecurity{stdout: "\n"}},
		{"no output at all", fakeSecurity{}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			fake := c.fake
			fake.install(t)
			got, present, err := Get(context.Background(), AccountTursoToken)
			if err != nil {
				t.Fatalf("a missing entry was reported as an error: %v", err)
			}
			if present {
				t.Fatal("a missing entry was reported as present")
			}
			if !got.Empty() {
				t.Fatal("a missing entry produced a non-empty secret")
			}
		})
	}
}

// TestGetReportsAGenuineFailureWithoutTheChildStdout is the test that matters
// most here: on a read the child's stdout *is* the token, so an error built
// from a failed read may report the status and stderr and nothing else.
func TestGetReportsAGenuineFailureWithoutTheChildStdout(t *testing.T) {
	(&fakeSecurity{
		stdout:   sentinelKeyringToken,
		stderr:   "SecKeychainSearchCopyNext: the keychain is locked",
		exitCode: 1,
	}).install(t)

	_, present, err := Get(context.Background(), AccountTursoToken)
	if err == nil {
		t.Fatal("a locked keychain was reported as a plain absence")
	}
	if present {
		t.Fatal("a failed read reported a present entry")
	}
	if strings.Contains(err.Error(), sentinelKeyringToken) {
		t.Fatalf("the error carries the child's stdout: %q", err.Error())
	}
	if !strings.Contains(err.Error(), "status 1") {
		t.Fatalf("the error does not report the exit status: %q", err.Error())
	}
	if !strings.Contains(err.Error(), "the keychain is locked") {
		t.Fatalf("the error drops the child's stderr: %q", err.Error())
	}
}

// TestGetFailureWithoutStderr and the next test cover the two remaining shapes
// of a child failure: one that says nothing, and one that never ran at all.
// Neither may fall back to quoting stdout.
func TestGetFailureWithoutStderr(t *testing.T) {
	(&fakeSecurity{stdout: sentinelKeyringToken, exitCode: 2}).install(t)

	_, _, err := Get(context.Background(), AccountTursoToken)
	if err == nil {
		t.Fatal("a failing child was reported as an absence")
	}
	if strings.Contains(err.Error(), sentinelKeyringToken) {
		t.Fatalf("the error carries the child's stdout: %q", err.Error())
	}
	if !strings.Contains(err.Error(), "status 2") {
		t.Fatalf("the error does not report the exit status: %q", err.Error())
	}
}

func TestGetFailureWhenTheBinaryCannotBeExecuted(t *testing.T) {
	// A `security` on PATH that the kernel cannot execute: the backend is
	// detected, but the child never starts, so the failure is not an exit
	// status. PATH is replaced rather than prepended, so that no fallback to
	// the machine's real `security` is possible.
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, securityBin), []byte("\x00\x01 not a program\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)

	_, present, err := Get(context.Background(), AccountTursoToken)
	if err == nil {
		t.Fatal("an unexecutable binary was reported as an absence")
	}
	if present {
		t.Fatal("an unexecutable binary reported a present entry")
	}
	if !strings.Contains(err.Error(), securityBin) {
		t.Fatalf("the error does not name the binary: %q", err.Error())
	}
}

func TestSetSendsTheSecretOnStdinAndNotInArgv(t *testing.T) {
	f := (&fakeSecurity{}).install(t)

	if err := Set(context.Background(), AccountTursoToken, secret.New(sentinelKeyringToken)); err != nil {
		t.Fatalf("Set: %v", err)
	}

	argv := f.argv(t)
	if strings.Join(argv, " ") != "-i" {
		t.Fatalf("argv = %q, want just -i", argv)
	}
	for _, arg := range argv {
		if strings.Contains(arg, sentinelKeyringToken) {
			t.Fatalf("the token reached argv element %q", arg)
		}
	}
	stdin := f.stdin(t)
	if !strings.Contains(stdin, sentinelKeyringToken) {
		t.Fatal("the token did not reach the child's stdin, so it would be stored empty")
	}
	if !strings.HasPrefix(stdin, "add-generic-password -s "+Service+" -a "+AccountTursoToken+" -U -w ") {
		t.Fatalf("unexpected stdin script: %q", strings.ReplaceAll(stdin, sentinelKeyringToken, secret.Redacted))
	}
}

func TestSetRefusesAValueItCannotPassSafely(t *testing.T) {
	f := (&fakeSecurity{}).install(t)

	err := Set(context.Background(), AccountTursoToken, secret.New("TOKEN GOES HERE with spaces"))
	if !errors.Is(err, ErrWriteUnsupported) {
		t.Fatalf("Set error = %v, want ErrWriteUnsupported", err)
	}
	if strings.Contains(err.Error(), "with spaces") {
		t.Fatalf("the error quoted the value: %v", err)
	}
	if argv := f.argv(t); argv != nil {
		t.Fatalf("a refused value still ran a child with argv %q", argv)
	}
}

// TestSetScrubsTheValueOutOfAFailedChildDiagnostics covers a child that echoes
// its input back on stderr, which is the one way a write could disclose the
// token through an error.
func TestSetScrubsTheValueOutOfAFailedChildDiagnostics(t *testing.T) {
	(&fakeSecurity{
		stderr:   "add-generic-password: rejected " + sentinelKeyringToken,
		exitCode: 1,
	}).install(t)

	err := Set(context.Background(), AccountD1Token, secret.New(sentinelKeyringToken))
	if err == nil {
		t.Fatal("a failed child was reported as a successful write")
	}
	if strings.Contains(err.Error(), sentinelKeyringToken) {
		t.Fatalf("the error carries the token: %q", err.Error())
	}
	if !strings.Contains(err.Error(), secret.Redacted) {
		t.Fatalf("the error does not mark the redaction: %q", err.Error())
	}
}

func TestDeleteOutcomes(t *testing.T) {
	t.Run("success", func(t *testing.T) {
		f := (&fakeSecurity{}).install(t)
		if err := Delete(context.Background(), AccountTursoToken); err != nil {
			t.Fatalf("Delete: %v", err)
		}
		want := []string{"delete-generic-password", "-s", Service, "-a", AccountTursoToken}
		if got := f.argv(t); strings.Join(got, " ") != strings.Join(want, " ") {
			t.Fatalf("argv = %q, want %q", got, want)
		}
	})

	t.Run("a missing entry is not an error", func(t *testing.T) {
		(&fakeSecurity{exitCode: notFoundExitCode}).install(t)
		if err := Delete(context.Background(), AccountD1Token); err != nil {
			t.Fatalf("deleting a missing entry failed: %v", err)
		}
	})

	t.Run("a genuine failure is reported", func(t *testing.T) {
		(&fakeSecurity{
			stdout:   sentinelKeyringToken,
			stderr:   "the keychain is locked",
			exitCode: 1,
		}).install(t)
		err := Delete(context.Background(), AccountTursoToken)
		if err == nil {
			t.Fatal("a locked keychain was reported as a successful delete")
		}
		if strings.Contains(err.Error(), sentinelKeyringToken) {
			t.Fatalf("the error carries the child's stdout: %q", err.Error())
		}
	})
}

// TestBackendIsDetectedFromPath pairs with the existing absent-binary test:
// with a `security` on PATH this platform reports the keychain backend.
func TestBackendIsDetectedFromPath(t *testing.T) {
	(&fakeSecurity{}).install(t)
	if got := Backend(); got != BackendKeychain {
		t.Fatalf("Backend() = %q, want %q", got, BackendKeychain)
	}
	if !Available() {
		t.Fatal("Available() = false with a security binary on PATH")
	}
}

func TestManualInstructionsCarryNoSentinel(t *testing.T) {
	for _, account := range []string{AccountTursoToken, AccountD1Token} {
		got := ManualInstructions(account)
		if strings.Contains(got, sentinelKeyringToken) {
			t.Fatalf("instructions for %s carry a token value: %q", account, got)
		}
		if !strings.Contains(got, Placeholder) {
			t.Fatalf("instructions for %s lack the placeholder: %q", account, got)
		}
	}
}

// TestSecretToolEmptyOutputCase records the one branch this platform cannot
// reach: `secret-tool lookup` reports a missing item with a non-zero status
// and nothing on either stream, which linuxGet alone distinguishes.
func TestSecretToolEmptyOutputCase(t *testing.T) {
	t.Skipf("the secret-tool branch is built only on linux; this is %s", runtime.GOOS)
}
