//go:build darwin

package keyring

import (
	"bytes"
	"context"
	"os/exec"
	"strings"
	"testing"

	"github.com/soya-miyoshi/todocloud/internal/secret"
)

// setCommandForTest exposes the command Set builds, so that the shared argv
// test can inspect it without running it.
func setCommandForTest(t *testing.T, account string, value secret.Secret) (*exec.Cmd, string) {
	t.Helper()
	return darwinSetCommand(context.Background(), account, value)
}

// TestDarwinSetExecsSecurityInteractively records the finding this platform's
// implementation rests on: the write goes through `security -i`, whose argv is
// only the two fixed arguments, because add-generic-password takes the
// password from -w or /dev/tty and ignores piped stdin.
func TestDarwinSetExecsSecurityInteractively(t *testing.T) {
	cmd, stdin := darwinSetCommand(context.Background(), AccountTursoToken, secret.New(fakeToken))
	if got := strings.Join(cmd.Args, " "); got != "security -i" {
		t.Fatalf("argv = %q, want %q", got, "security -i")
	}
	if !strings.HasPrefix(stdin, "add-generic-password -s "+Service+" -a "+AccountTursoToken+" -U -w ") {
		t.Fatalf("unexpected stdin script: %q", strings.ReplaceAll(stdin, fakeToken, secret.Redacted))
	}
}

func TestDarwinSetRefusesATokenItCannotQuote(t *testing.T) {
	if !Available() {
		t.Skip("no security binary on this machine")
	}
	err := darwinSet(context.Background(), AccountTursoToken, secret.New("fake token with spaces"))
	if err == nil {
		t.Fatal("darwinSet accepted a value it cannot pass safely")
	}
	if !strings.Contains(err.Error(), ErrWriteUnsupported.Error()) {
		t.Fatalf("error = %v, want ErrWriteUnsupported", err)
	}
	if strings.Contains(err.Error(), "fake token with spaces") {
		t.Fatalf("the error quoted the value: %v", err)
	}
}

// TestDarwinRoundTripAgainstTheRealKeychain exercises the three real children
// against a throwaway service name, never the one the CLI uses, with an
// obviously fake value that is deleted again whatever happens.
func TestDarwinRoundTripAgainstTheRealKeychain(t *testing.T) {
	if testing.Short() {
		t.Skip("touches the real keychain")
	}
	if _, err := exec.LookPath(securityBin); err != nil {
		t.Skip("no security binary on this machine")
	}

	const service = Service + "-selftest"
	const account = "selftest"

	del := func() {
		_ = exec.Command(securityBin, "delete-generic-password", "-s", service, "-a", account).Run()
	}
	del()
	t.Cleanup(del)

	write := func(value string) error {
		cmd := exec.Command(securityBin, "-i")
		cmd.Stdin = strings.NewReader("add-generic-password -s " + service + " -a " + account + " -U -w " + value + "\n")
		cmd.Stdout = &bytes.Buffer{}
		cmd.Stderr = &bytes.Buffer{}
		return cmd.Run()
	}
	read := func() (string, int) {
		cmd := exec.Command(securityBin, "find-generic-password", "-s", service, "-a", account, "-w")
		var stdout bytes.Buffer
		cmd.Stdout = &stdout
		cmd.Stderr = &bytes.Buffer{}
		err := cmd.Run()
		if err != nil {
			return "", exitCode(err)
		}
		return trimOneNewline(stdout.String()), 0
	}

	if got, code := read(); code != notFoundExitCode {
		t.Fatalf("a missing item read gave %q and exit %d, want exit %d", got, code, notFoundExitCode)
	}
	if err := write(fakeToken); err != nil {
		t.Fatalf("write: %v", err)
	}
	if got, code := read(); code != 0 || got != fakeToken {
		t.Fatalf("round trip returned %q (exit %d), want the written value", got, code)
	}
	// -U must replace rather than fail with a duplicate.
	if err := write(fakeToken + "-second"); err != nil {
		t.Fatalf("rewrite: %v", err)
	}
	if got, _ := read(); got != fakeToken+"-second" {
		t.Fatalf("rewrite returned %q", got)
	}

	del()
	if _, code := read(); code != notFoundExitCode {
		t.Fatalf("the item survived deletion (exit %d)", code)
	}
}
