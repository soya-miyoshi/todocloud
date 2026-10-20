//go:build linux

package keyring

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strings"

	"github.com/soya-miyoshi/todocloud/internal/secret"
)

// secretToolBin is the libsecret CLI. Unlike macOS's `security`, it reads the
// secret from stdin by design, so a write needs no workaround.
const secretToolBin = "secret-tool"

func currentBackend() backend {
	if _, err := lookPath(secretToolBin); err != nil {
		return backend{name: BackendNone}
	}
	return backend{
		name:   BackendSecretTool,
		get:    linuxGet,
		set:    linuxSet,
		delete: linuxDelete,
	}
}

func linuxGet(ctx context.Context, account string) (secret.Secret, bool, error) {
	cmd := exec.CommandContext(ctx, secretToolBin,
		"lookup", "service", Service, "account", account)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		// `secret-tool lookup` exits non-zero with nothing on either stream
		// when the item simply does not exist. A real failure — no session
		// bus, a locked collection — says so on stderr.
		if exitCode(err) > 0 && stdout.Len() == 0 && strings.TrimSpace(stderr.String()) == "" {
			return secret.Secret{}, false, nil
		}
		return secret.Secret{}, false, childError(secretToolBin, err, stderr.String())
	}
	value := trimOneNewline(stdout.String())
	if value == "" {
		return secret.Secret{}, false, nil
	}
	return secret.New(value), true, nil
}

func linuxSet(ctx context.Context, account string, value secret.Secret) error {
	cmd, stdin := linuxSetCommand(ctx, account, value)
	cmd.Stdin = strings.NewReader(stdin)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	cmd.Stdout = &bytes.Buffer{}

	if err := cmd.Run(); err != nil {
		return childError(secretToolBin, err, scrub(stderr.String(), value))
	}
	return nil
}

// linuxSetCommand builds the write command and the text fed to its stdin, so
// that a test can assert the token reaches stdin and never cmd.Args.
func linuxSetCommand(ctx context.Context, account string, value secret.Secret) (*exec.Cmd, string) {
	cmd := exec.CommandContext(ctx, secretToolBin,
		"store",
		"--label="+Service+" "+account,
		"service", Service,
		"account", account)
	// secret-tool reads the secret from stdin and stops at the first newline,
	// so the value is written on its own without a terminator.
	return cmd, value.Reveal()
}

func linuxDelete(ctx context.Context, account string) error {
	// `secret-tool clear` succeeds whether or not anything matched.
	cmd := exec.CommandContext(ctx, secretToolBin,
		"clear", "service", Service, "account", account)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	cmd.Stdout = &bytes.Buffer{}

	if err := cmd.Run(); err != nil {
		return childError(secretToolBin, err, stderr.String())
	}
	return nil
}

// ManualInstructions returns the command the user can run themselves to store
// account's token, for the platforms where Set is unsupported. It must contain
// a placeholder, never a real token.
func ManualInstructions(account string) string {
	return fmt.Sprintf(
		"printf %%s %s | secret-tool store --label=%q service %s account %s",
		Placeholder, Service+" "+account, Service, account)
}
