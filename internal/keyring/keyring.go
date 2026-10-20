// Package keyring stores provider tokens in the operating system's keychain,
// which is the recommended place for an interactive user: a config file can
// end up committed to a repository, and an exported environment variable
// tends to end up in a dotfiles repository.
//
// The keychain is reached by executing the system's own binaries — `security`
// on macOS, `secret-tool` on Linux — never by linking a framework, so that
// CGO_ENABLED=0 keeps building for every supported platform. Two consequences
// follow, and both are load-bearing:
//
//   - A token must never reach the child's argv. `ps` shows argv to every user
//     on the machine and the shell writes it to its history file. Every secret
//     this package passes to a child goes through the child's stdin.
//   - A platform whose binary cannot accept a secret that way simply has no
//     writable backend. Set then returns ErrWriteUnsupported and the caller
//     prints ManualInstructions instead of failing; reading still works.
//
// Nothing in this package formats a token into an error, a message or a log
// line: values are carried as secret.Secret, and a child's stdout — which
// holds the token on a read — is never quoted into an error.
package keyring

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"

	"github.com/soya-miyoshi/todocloud/internal/secret"
)

// Service is the keychain service name every entry is filed under.
const Service = "todocloud"

// Account names for the entries this CLI owns.
const (
	AccountTursoToken = "turso.token"
	AccountD1Token    = "d1.token"
)

// Backend names reported by Backend.
const (
	BackendKeychain   = "keychain"
	BackendSecretTool = "secret-tool"
	BackendNone       = "none"
)

// ErrUnavailable and ErrWriteUnsupported let callers degrade instead of fail.
// A command that cannot store a token is still a successful command: the user
// is told what to run themselves.
var (
	// ErrUnavailable means no keychain backend exists on this machine.
	ErrUnavailable = errors.New("no OS keychain backend is available on this platform")
	// ErrWriteUnsupported means a backend exists and can be read, but its
	// binary cannot be given a secret without exposing it in argv.
	ErrWriteUnsupported = errors.New("this platform's keychain binary cannot accept a secret without exposing it in argv")
)

// notFoundExitCode is what `security` returns for "the item does not exist",
// which is not a failure.
const notFoundExitCode = 44

// Backend reports which mechanism is in use: "keychain" (macOS security),
// "secret-tool" (Linux libsecret) or "none".
func Backend() string {
	return currentBackend().name
}

// Available reports whether a keychain backend is usable on this machine.
func Available() bool {
	return currentBackend().name != BackendNone
}

// Get returns the stored token. The boolean is false when no entry exists,
// which is not an error.
func Get(ctx context.Context, account string) (secret.Secret, bool, error) {
	if err := validateAccount(account); err != nil {
		return secret.Secret{}, false, err
	}
	b := currentBackend()
	if b.name == BackendNone {
		return secret.Secret{}, false, ErrUnavailable
	}
	return b.get(ctx, account)
}

// Set stores or replaces a token. It returns ErrWriteUnsupported when the
// platform's binary cannot accept a secret without exposing it in argv.
func Set(ctx context.Context, account string, value secret.Secret) error {
	if err := validateAccount(account); err != nil {
		return err
	}
	if value.Empty() {
		return errors.New("refusing to store an empty token")
	}
	b := currentBackend()
	if b.name == BackendNone {
		return ErrUnavailable
	}
	if b.set == nil {
		return ErrWriteUnsupported
	}
	return b.set(ctx, account, value)
}

// Delete removes an entry. Deleting a missing entry is not an error.
func Delete(ctx context.Context, account string) error {
	if err := validateAccount(account); err != nil {
		return err
	}
	b := currentBackend()
	if b.name == BackendNone {
		return ErrUnavailable
	}
	return b.delete(ctx, account)
}

// validateAccount rejects anything that is not one of the entries this CLI
// owns. Accepting a caller-chosen name would let an account string shaped
// like a flag reach a child's argv.
func validateAccount(account string) error {
	switch account {
	case AccountTursoToken, AccountD1Token:
		return nil
	default:
		return fmt.Errorf("unknown keyring account %q", account)
	}
}

// backend is one platform's implementation. A nil set means the platform can
// be read but not written, which is reported as ErrWriteUnsupported.
type backend struct {
	name   string
	get    func(ctx context.Context, account string) (secret.Secret, bool, error)
	set    func(ctx context.Context, account string, value secret.Secret) error
	delete func(ctx context.Context, account string) error
}

// lookPath is exec.LookPath, replaced in tests to simulate a machine where a
// backend's binary is absent.
var lookPath = exec.LookPath

// trimOneNewline removes exactly one trailing line ending and nothing else.
// A token must not be silently altered: trailing whitespace that is not the
// terminator the binary added is part of the value as far as this code knows.
func trimOneNewline(s string) string {
	switch {
	case strings.HasSuffix(s, "\r\n"):
		return s[:len(s)-2]
	case strings.HasSuffix(s, "\n"):
		return s[:len(s)-1]
	default:
		return s
	}
}

// childError builds the error for a failed child process. It reports only the
// exit status and stderr; the child's stdout is deliberately excluded, because
// on a read it holds the token itself.
func childError(name string, err error, stderr string) error {
	stderr = strings.TrimSpace(stderr)
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		if stderr == "" {
			return fmt.Errorf("%s exited with status %d", name, exitErr.ExitCode())
		}
		return fmt.Errorf("%s exited with status %d: %s", name, exitErr.ExitCode(), stderr)
	}
	if stderr == "" {
		return fmt.Errorf("%s: %w", name, err)
	}
	return fmt.Errorf("%s: %w: %s", name, err, stderr)
}

// exitCode returns the child's exit status, or -1 when it never ran.
func exitCode(err error) int {
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode()
	}
	return -1
}

// Placeholder stands in for the token in every instruction this package
// prints. It is obviously fake, so a user who pastes the line unchanged gets
// an obviously wrong entry rather than a plausible one.
const Placeholder = "TOKEN_GOES_HERE"

// lexicallySafe reports whether value can be embedded in a command line that
// a child's own lexer will parse without mangling or splitting it. The set is
// deliberately narrow: it covers every token shape the supported providers
// issue (hex, base64url, JWTs) and nothing that needs quoting.
func lexicallySafe(value string) bool {
	if value == "" {
		return false
	}
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case strings.ContainsRune("-_.~+/=:", r):
		default:
			return false
		}
	}
	return true
}

// scrub removes value from text, so that a child's diagnostics cannot carry
// the token into an error message even if the child echoed its input back.
func scrub(text string, value secret.Secret) string {
	if value.Empty() {
		return text
	}
	return strings.ReplaceAll(text, value.Reveal(), secret.Redacted)
}
