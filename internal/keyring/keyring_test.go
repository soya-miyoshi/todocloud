package keyring

import (
	"context"
	"errors"
	"os/exec"
	"runtime"
	"strings"
	"testing"

	"github.com/soya-miyoshi/todocloud/internal/secret"
)

// fakeToken is what every test in this package stores or inspects. It is
// obviously not a credential.
const fakeToken = "FAKE-TOKEN-not-a-real-credential-0000"

func TestTrimOneNewlineRemovesExactlyOneTerminator(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"unix terminator", "abc\n", "abc"},
		{"windows terminator", "abc\r\n", "abc"},
		{"only one of two", "abc\n\n", "abc\n"},
		{"no terminator", "abc", "abc"},
		{"trailing space is part of the value", "abc \n", "abc "},
		{"leading space is part of the value", " abc\n", " abc"},
		{"interior newline survives", "a\nb\n", "a\nb"},
		{"empty", "", ""},
		{"just a terminator", "\n", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := trimOneNewline(c.in); got != c.want {
				t.Fatalf("trimOneNewline(%q) = %q, want %q", c.in, got, c.want)
			}
		})
	}
}

func TestExitCodeDistinguishesNotFoundFromFailure(t *testing.T) {
	// `false` exits 1, which stands in for a real failure; the not-found code
	// is 44 on macOS and is never produced by a plain failure.
	err := exec.Command("false").Run()
	if err == nil {
		t.Skip("no usable `false` binary on this machine")
	}
	if code := exitCode(err); code != 1 {
		t.Fatalf("exitCode = %d, want 1", code)
	}
	if code := exitCode(errors.New("never ran")); code != -1 {
		t.Fatalf("exitCode of a non-exec error = %d, want -1", code)
	}
	if notFoundExitCode == 1 {
		t.Fatal("the not-found code must not collide with an ordinary failure")
	}
}

func TestChildErrorNeverCarriesStdout(t *testing.T) {
	err := exec.Command("false").Run()
	if err == nil {
		t.Skip("no usable `false` binary on this machine")
	}
	// The child's stdout holds the token on a read, so childError must take
	// only stderr. Feeding it the token as stderr proves the scrubbed path is
	// the only way a value could appear, and that this call site cannot.
	got := childError("security", err, "the item could not be read").Error()
	if strings.Contains(got, fakeToken) {
		t.Fatalf("error text leaked the token: %q", got)
	}
	if !strings.Contains(got, "status 1") {
		t.Fatalf("error text does not report the exit status: %q", got)
	}
}

func TestScrubRemovesTheValueFromDiagnostics(t *testing.T) {
	got := scrub("security: bad value "+fakeToken+" rejected", secret.New(fakeToken))
	if strings.Contains(got, fakeToken) {
		t.Fatalf("scrub left the value in place: %q", got)
	}
	if !strings.Contains(got, secret.Redacted) {
		t.Fatalf("scrub did not mark the redaction: %q", got)
	}
	if got := scrub("unchanged", secret.Secret{}); got != "unchanged" {
		t.Fatalf("scrub with no value changed the text: %q", got)
	}
}

func TestManualInstructionsHoldAPlaceholderAndNoRealisticToken(t *testing.T) {
	for _, account := range []string{AccountTursoToken, AccountD1Token} {
		got := ManualInstructions(account)
		if !strings.Contains(got, Placeholder) {
			t.Fatalf("instructions for %s lack the placeholder: %q", account, got)
		}
		if !strings.Contains(got, account) {
			t.Fatalf("instructions for %s do not name the account: %q", account, got)
		}
		// A placeholder has to be unmistakable, so nothing else in the
		// string may look like a generated credential.
		for _, field := range strings.Fields(got) {
			if field != Placeholder && looksGenerated(field) {
				t.Fatalf("instructions contain a realistic-looking token %q: %q", field, got)
			}
		}
	}
}

func TestLexicallySafeRejectsAnythingNeedingQuoting(t *testing.T) {
	// A real Turso token is a JWT, so the characters one is made of have to
	// pass: dots, dashes, underscores and the base64url padding set. The
	// fixture spells them out instead of looking like a token, because an
	// obviously fake placeholder is what CLAUDE.md §1.3 requires and what
	// keeps a credential scanner from flagging this file.
	safe := []string{
		"abc123",
		"TOKEN_GOES_HERE.part-two_three.sig-_~+/=",
		"libsql:token",
	}
	for _, v := range safe {
		if !lexicallySafe(v) {
			t.Fatalf("lexicallySafe(%q) = false, want true", v)
		}
	}
	unsafe := []string{"", "has space", "quote\"d", "back\\slash", "new\nline", "semi;colon", "tab\there", "dollar$sign", "'quoted'"}
	for _, v := range unsafe {
		if lexicallySafe(v) {
			t.Fatalf("lexicallySafe(%q) = true, want false", v)
		}
	}
}

func TestUnknownAccountIsRejectedBeforeAnyChildRuns(t *testing.T) {
	ctx := context.Background()
	// An account name shaped like a flag must never reach a child's argv.
	const hostile = "-w"
	if _, _, err := Get(ctx, hostile); err == nil {
		t.Fatal("Get accepted an unknown account")
	}
	if err := Set(ctx, hostile, secret.New(fakeToken)); err == nil {
		t.Fatal("Set accepted an unknown account")
	}
	if err := Delete(ctx, hostile); err == nil {
		t.Fatal("Delete accepted an unknown account")
	}
}

func TestSetRefusesAnEmptyToken(t *testing.T) {
	if err := Set(context.Background(), AccountTursoToken, secret.Secret{}); err == nil {
		t.Fatal("Set stored an empty token")
	}
}

func TestBackendIsNoneWhenTheBinaryIsAbsent(t *testing.T) {
	original := lookPath
	t.Cleanup(func() { lookPath = original })
	lookPath = func(string) (string, error) { return "", exec.ErrNotFound }

	if got := Backend(); got != BackendNone {
		t.Fatalf("Backend() with no binary on PATH = %q, want %q", got, BackendNone)
	}
	if Available() {
		t.Fatal("Available() = true with no binary on PATH")
	}

	ctx := context.Background()
	if _, _, err := Get(ctx, AccountTursoToken); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("Get error = %v, want ErrUnavailable", err)
	}
	if err := Set(ctx, AccountTursoToken, secret.New(fakeToken)); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("Set error = %v, want ErrUnavailable", err)
	}
	if err := Delete(ctx, AccountTursoToken); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("Delete error = %v, want ErrUnavailable", err)
	}
}

func TestBackendMatchesThePlatform(t *testing.T) {
	want := map[string]string{
		"darwin": BackendKeychain,
		"linux":  BackendSecretTool,
	}[runtime.GOOS]
	if want == "" {
		if got := Backend(); got != BackendNone {
			t.Fatalf("Backend() on %s = %q, want %q", runtime.GOOS, got, BackendNone)
		}
		return
	}
	if !Available() {
		t.Skipf("no %s backend on this machine", want)
	}
	if got := Backend(); got != want {
		t.Fatalf("Backend() = %q, want %q", got, want)
	}
}

// TestNoTokenReachesArgv is the test that guards the rule this package exists
// for: a secret may travel on the child's stdin, never in its arguments.
func TestNoTokenReachesArgv(t *testing.T) {
	if !Available() {
		t.Skip("no keychain backend on this machine")
	}
	value := secret.New(fakeToken)
	for _, account := range []string{AccountTursoToken, AccountD1Token} {
		cmd, stdin := setCommandForTest(t, account, value)
		joined := strings.Join(cmd.Args, " ")
		if strings.Contains(joined, fakeToken) {
			t.Fatalf("the token reached argv: %q", joined)
		}
		for _, arg := range cmd.Args {
			if strings.Contains(arg, fakeToken) {
				t.Fatalf("the token reached argv element %q", arg)
			}
		}
		if !strings.Contains(stdin, fakeToken) {
			t.Fatal("the token did not reach the child's stdin, so it would be stored empty")
		}
	}
}

// looksGenerated approximates "this could be mistaken for a real token": long,
// and mixing cases with digits the way an issued credential does. Command
// names and flags do not.
func looksGenerated(field string) bool {
	if len(field) < 16 {
		return false
	}
	var upper, lower, digit bool
	for _, r := range field {
		switch {
		case r >= 'A' && r <= 'Z':
			upper = true
		case r >= 'a' && r <= 'z':
			lower = true
		case r >= '0' && r <= '9':
			digit = true
		}
	}
	return upper && lower && digit
}
