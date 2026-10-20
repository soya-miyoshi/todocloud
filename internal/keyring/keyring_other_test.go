//go:build !darwin && !linux

package keyring

import (
	"os/exec"
	"testing"

	"github.com/soya-miyoshi/todocloud/internal/secret"
)

// setCommandForTest satisfies the shared test on a platform with no backend.
// TestNoTokenReachesArgv skips before calling it, because Available is false.
func setCommandForTest(t *testing.T, account string, value secret.Secret) (*exec.Cmd, string) {
	t.Helper()
	t.Skip("no keychain backend on this platform")
	return nil, ""
}

// TestUnsupportedPlatformHasNoBackend is the whole contract here: detect,
// report unavailable, and never fail a command because of it.
func TestUnsupportedPlatformHasNoBackend(t *testing.T) {
	if Available() {
		t.Fatal("Available() = true on a platform with no keychain CLI")
	}
	if got := Backend(); got != BackendNone {
		t.Fatalf("Backend() = %q, want %q", got, BackendNone)
	}
}
