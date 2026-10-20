//go:build darwin

package keyring

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strings"

	"github.com/soya-miyoshi/todocloud/internal/secret"
)

// securityBin is the macOS keychain binary. It is looked up on PATH rather
// than hard-coded so that its absence is reported as "unavailable".
const securityBin = "security"

// macOS writes through `security -i`, not `security add-generic-password`.
//
// This was settled empirically, because it decides whether this platform can
// store a token at all:
//
//	printf 'FAKE' | security add-generic-password -s svc -a acct -U
//
// exits 0 and creates the item — with an *empty* password. The same holds for
// a bare `-w` with no value. The binary does not read the password from piped
// stdin; it takes it only from `-w <value>`, which would put the token in
// argv, or from /dev/tty. Storing an empty password silently would be worse
// than not storing at all.
//
// `security -i` reads its *commands* from stdin instead. The child's argv is
// exactly {"security", "-i"} — the token is in the command text on stdin, so
// `ps` and the shell history never see it. Verified to round-trip, including
// base64 and JWT-shaped values, and to replace an existing item with -U.
//
// The cost is that the token is parsed by security's own command lexer, so a
// value containing whitespace, a quote or a backslash could be mangled or
// split. Rather than guess at its quoting rules, a token outside a
// conservative character set is refused as unsupported and the user is given
// the command to run themselves.

func currentBackend() backend {
	if _, err := lookPath(securityBin); err != nil {
		return backend{name: BackendNone}
	}
	return backend{
		name:   BackendKeychain,
		get:    darwinGet,
		set:    darwinSet,
		delete: darwinDelete,
	}
}

func darwinGet(ctx context.Context, account string) (secret.Secret, bool, error) {
	// -w writes the password to stdout, so nothing secret reaches argv.
	cmd := exec.CommandContext(ctx, securityBin,
		"find-generic-password", "-s", Service, "-a", account, "-w")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		if exitCode(err) == notFoundExitCode {
			return secret.Secret{}, false, nil
		}
		return secret.Secret{}, false, childError(securityBin, err, stderr.String())
	}
	value := trimOneNewline(stdout.String())
	if value == "" {
		// An item with an empty password is not a usable credential, and
		// reporting it as present would hide the real problem.
		return secret.Secret{}, false, nil
	}
	return secret.New(value), true, nil
}

func darwinSet(ctx context.Context, account string, value secret.Secret) error {
	if !lexicallySafe(value.Reveal()) {
		return fmt.Errorf("%w: the token contains a character the macOS keychain binary cannot be given safely", ErrWriteUnsupported)
	}
	cmd, stdin := darwinSetCommand(ctx, account, value)
	cmd.Stdin = strings.NewReader(stdin)
	// The child's stdout is discarded: `security -i` echoes nothing useful and
	// anything it did echo could hold the value.
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		return childError(securityBin, err, scrub(stderr.String(), value))
	}
	return nil
}

// darwinSetCommand builds the write command and the text fed to its stdin. It
// is separate so that a test can assert the token appears in the stdin text
// and never in cmd.Args.
func darwinSetCommand(ctx context.Context, account string, value secret.Secret) (*exec.Cmd, string) {
	cmd := exec.CommandContext(ctx, securityBin, "-i")
	// -U updates an existing item instead of failing with a duplicate.
	script := fmt.Sprintf("add-generic-password -s %s -a %s -U -w %s\n",
		Service, account, value.Reveal())
	return cmd, script
}

func darwinDelete(ctx context.Context, account string) error {
	cmd := exec.CommandContext(ctx, securityBin,
		"delete-generic-password", "-s", Service, "-a", account)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	cmd.Stdout = &bytes.Buffer{}

	if err := cmd.Run(); err != nil {
		if exitCode(err) == notFoundExitCode {
			return nil
		}
		return childError(securityBin, err, stderr.String())
	}
	return nil
}

// ManualInstructions returns the command the user can run themselves to store
// account's token, for the platforms where Set is unsupported. It must contain
// a placeholder, never a real token.
func ManualInstructions(account string) string {
	return fmt.Sprintf(
		"security add-generic-password -s %s -a %s -U -w %s",
		Service, account, Placeholder)
}
