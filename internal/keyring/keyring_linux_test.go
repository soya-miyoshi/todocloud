//go:build linux

package keyring

import (
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
	return linuxSetCommand(context.Background(), account, value)
}

// TestLinuxSetPassesTheSecretOnStdinOnly pins the one property that makes
// secret-tool usable: it takes the secret from stdin, so argv holds only the
// attribute names.
func TestLinuxSetPassesTheSecretOnStdinOnly(t *testing.T) {
	cmd, stdin := linuxSetCommand(context.Background(), AccountD1Token, secret.New(fakeToken))
	joined := strings.Join(cmd.Args, " ")
	if strings.Contains(joined, fakeToken) {
		t.Fatalf("the token reached argv: %q", joined)
	}
	if !strings.Contains(joined, "store") || !strings.Contains(joined, AccountD1Token) {
		t.Fatalf("unexpected argv: %q", joined)
	}
	if stdin != fakeToken {
		t.Fatal("the secret written to stdin is not the token as given")
	}
}
