// Package providercli drives the providers' own command-line tools, so that a
// user who has already logged in with `turso auth login` or
// `gcloud auth application-default login` does not have to find a token in a
// dashboard and paste it.
//
// Three rules shape every function here, and all three are load-bearing:
//
//   - A secret never reaches a child's argv. The only secret this package
//     handles is the token `turso db tokens create` mints, and that arrives on
//     the child's stdout; it is wrapped in a secret.Secret before it is
//     returned and it is never formatted into anything.
//   - A child's stdout is never quoted into an error. An error reports the
//     exit status and a scrubbed stderr only, exactly as internal/keyring
//     does, because on a mint stdout *is* the token.
//   - Login state is read from an exit status, never from output. `turso auth
//     token` prints a credential, so this package runs it and looks only at
//     whether it succeeded.
//
// Every exec'd command goes through two package-level indirections — lookPath
// and runner — so the tests drive fake executables and never a real provider
// CLI.
package providercli

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/soya-miyoshi/todocloud/internal/secret"
)

// TursoBin is the Turso CLI's name on PATH.
const TursoBin = "turso"

// SourceTursoCLI and SourceStdin name where a token came from, for the
// documented --json output of `tdo login`.
const (
	SourceTursoCLI = "turso-cli"
	SourceStdin    = "stdin"
)

// commandTimeout bounds every child process. A provider CLI that hangs — on a
// prompt, on a stalled network call — must not wedge `tdo login`.
// It is a variable only so that a test can shorten it; nothing changes it at
// run time.
var commandTimeout = 10 * time.Second

// Output is what a child process did. Stdout is held separately and is never
// included in an error by anything in this package.
type Output struct {
	Stdout string
	Stderr string
	Err    error
}

// Runner runs name with args and collects its output. It is a package
// variable so that tests can drive every branch — success, a non-zero exit, a
// timeout, empty output — without a real binary.
type Runner func(ctx context.Context, name string, args ...string) Output

var (
	// lookPath is exec.LookPath, replaced in tests to simulate a machine
	// where a provider CLI is absent.
	lookPath = exec.LookPath
	// runner executes a child process.
	runner Runner = execRunner
	// goos is runtime.GOOS, replaced in tests to cover the Windows path of
	// the well-known Application Default Credentials location.
	goos = runtime.GOOS
)

// execRunner is the real runner. The child gets no stdin: none of these
// commands may prompt, and a CLI waiting on a terminal would otherwise block
// until the timeout.
func execRunner(ctx context.Context, name string, args ...string) Output {
	cmd := exec.CommandContext(ctx, name, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	cmd.Stdin = nil
	err := cmd.Run()
	return Output{Stdout: stdout.String(), Stderr: stderr.String(), Err: err}
}

// run executes one provider CLI command under a timeout.
func run(ctx context.Context, name string, args ...string) Output {
	ctx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	out := runner(ctx, name, args...)
	// A child killed by the deadline reports a generic failure, so the
	// deadline is reported explicitly instead.
	if out.Err != nil && ctx.Err() != nil && errors.Is(ctx.Err(), context.DeadlineExceeded) {
		out.Err = fmt.Errorf("%s did not finish within %s", name, commandTimeout)
	}
	return out
}

// childError builds the error for a failed child. It reports the exit status
// and a trimmed stderr, and never the child's stdout.
func childError(name string, out Output) error {
	stderr := strings.TrimSpace(out.Stderr)
	var exitErr *exec.ExitError
	if errors.As(out.Err, &exitErr) {
		if stderr == "" {
			return fmt.Errorf("%s exited with status %d", name, exitErr.ExitCode())
		}
		return fmt.Errorf("%s exited with status %d: %s", name, exitErr.ExitCode(), stderr)
	}
	if stderr == "" {
		return fmt.Errorf("%s: %w", name, out.Err)
	}
	return fmt.Errorf("%s: %w: %s", name, out.Err, stderr)
}

// scrub removes value from text, so a child that echoed its own output onto
// stderr cannot carry the token into an error message.
func scrub(text string, value secret.Secret) string {
	if value.Empty() {
		return text
	}
	return strings.ReplaceAll(text, value.Reveal(), secret.Redacted)
}

// trimOneNewline removes exactly one trailing line ending and nothing else. A
// token is used as given: trailing whitespace that is not the terminator the
// CLI added is part of the value as far as this code knows.
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

// TursoAvailable reports whether the Turso CLI is on PATH.
func TursoAvailable() bool {
	_, err := lookPath(TursoBin)
	return err == nil
}

// TursoLoggedIn reports whether the Turso CLI holds a usable session.
//
// It runs `turso auth token` and looks at the exit status only. That command
// prints a credential on success, so its stdout is never read, never logged
// and never placed in the returned error. A non-zero exit means "not logged
// in", which is not an error; an error is returned only when the command could
// not be run at all.
func TursoLoggedIn(ctx context.Context) (bool, error) {
	if !TursoAvailable() {
		return false, fmt.Errorf("%s is not installed", TursoBin)
	}
	out := run(ctx, TursoBin, "auth", "token")
	if out.Err == nil {
		return true, nil
	}
	var exitErr *exec.ExitError
	if errors.As(out.Err, &exitErr) {
		// A refused session is an answer, not a failure.
		return false, nil
	}
	// Deliberately built from Output with its Stdout dropped.
	return false, childError(TursoBin, Output{Stderr: out.Stderr, Err: out.Err})
}

// TursoDatabases lists the databases the logged-in user owns, by name.
//
// `turso db list` prints a table whose first column is the name and whose
// first row is a header. Only the first column of each following row is read;
// the URL column is not a credential but is not needed here either.
func TursoDatabases(ctx context.Context) ([]string, error) {
	if !TursoAvailable() {
		return nil, fmt.Errorf("%s is not installed", TursoBin)
	}
	out := run(ctx, TursoBin, "db", "list")
	if out.Err != nil {
		return nil, childError(TursoBin, Output{Stderr: out.Stderr, Err: out.Err})
	}
	var names []string
	for _, line := range strings.Split(out.Stdout, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		name := fields[0]
		if strings.EqualFold(name, "NAME") {
			// The table header.
			continue
		}
		names = append(names, name)
	}
	return names, nil
}

// TursoCreateToken mints a token scoped to one database.
//
// This is narrower than anything a user would create by hand in the
// dashboard: the token reaches this database and no other. It arrives on the
// child's stdout and becomes a secret.Secret immediately, before any other
// code can see it as a string.
func TursoCreateToken(ctx context.Context, database string) (secret.Secret, error) {
	if err := validateDatabaseName(database); err != nil {
		return secret.Secret{}, err
	}
	if !TursoAvailable() {
		return secret.Secret{}, fmt.Errorf("%s is not installed", TursoBin)
	}
	out := run(ctx, TursoBin, "db", "tokens", "create", database)
	token := secret.New(trimOneNewline(out.Stdout))
	if out.Err != nil {
		return secret.Secret{}, childError(TursoBin, Output{
			Stderr: scrub(out.Stderr, token),
			Err:    out.Err,
		})
	}
	if token.Empty() {
		return secret.Secret{}, fmt.Errorf("%s db tokens create %s printed no token", TursoBin, database)
	}
	return token, nil
}

// TursoDatabaseURL returns the libsql:// URL of a database. A URL is not a
// credential, so it may be printed; it is only ever used as a hint for the
// user's config file.
func TursoDatabaseURL(ctx context.Context, database string) (string, error) {
	if err := validateDatabaseName(database); err != nil {
		return "", err
	}
	if !TursoAvailable() {
		return "", fmt.Errorf("%s is not installed", TursoBin)
	}
	out := run(ctx, TursoBin, "db", "show", database, "--url")
	if out.Err != nil {
		return "", childError(TursoBin, Output{Stderr: out.Stderr, Err: out.Err})
	}
	url := strings.TrimSpace(out.Stdout)
	if url == "" {
		return "", fmt.Errorf("%s db show %s --url printed no url", TursoBin, database)
	}
	return url, nil
}

// validateDatabaseName refuses anything that is not a plain name. A name
// reaches a child's argv, so a value that could be read as a flag or as shell
// text is rejected rather than quoted.
func validateDatabaseName(database string) error {
	if database == "" {
		return errors.New("no database name given")
	}
	if strings.HasPrefix(database, "-") {
		return fmt.Errorf("invalid database name %q: it must not start with a dash", database)
	}
	for _, r := range database {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '-', r == '_':
		default:
			return fmt.Errorf("invalid database name %q: only letters, digits, dashes and underscores are allowed", database)
		}
	}
	return nil
}

// DatabaseFromURL recovers a database name from a Turso URL.
//
// Turso hostnames are `<database>-<organization>.turso.io`, so the name is
// everything before the last dash of the first label. The boolean is false
// whenever that cannot be read confidently — a host that is not Turso's, or a
// label with no dash at all, where the whole label might be the name or might
// not. An uncertain answer is reported as uncertain so the caller can check it
// against `turso db list` instead of guessing.
func DatabaseFromURL(url string) (string, bool) {
	label, ok := tursoHostLabel(url)
	if !ok {
		return "", false
	}
	dash := strings.LastIndex(label, "-")
	if dash <= 0 || dash == len(label)-1 {
		// No dash, or nothing on one side of it: the organization cannot be
		// told apart from the name.
		return "", false
	}
	name := label[:dash]
	// The host label is whatever the configured URL happens to contain, so a
	// name sliced out of it is not automatically a name this package would
	// accept as an argument. Reporting "certain" for one that the very next
	// call would refuse is worse than reporting uncertainty: the caller falls
	// back to `turso db list`, or asks for --database.
	if validateDatabaseName(name) != nil {
		return "", false
	}
	return name, true
}

// MatchDatabaseInURL resolves a Turso URL against a known list of databases.
// It is the reliable path where DatabaseFromURL's heuristic is uncertain,
// because a database name may itself contain dashes. The longest name that the
// host's first label starts with wins.
func MatchDatabaseInURL(url string, databases []string) (string, bool) {
	label, ok := tursoHostLabel(url)
	if !ok {
		return "", false
	}
	best := ""
	for _, name := range databases {
		if name == "" || validateDatabaseName(name) != nil {
			continue
		}
		if label != name && !strings.HasPrefix(label, name+"-") {
			continue
		}
		if len(name) > len(best) {
			best = name
		}
	}
	return best, best != ""
}

// tursoHostLabel returns the first label of a Turso hostname.
func tursoHostLabel(url string) (string, bool) {
	host := strings.TrimSpace(url)
	if host == "" {
		return "", false
	}
	if i := strings.Index(host, "://"); i >= 0 {
		host = host[i+3:]
	}
	if i := strings.IndexAny(host, "/?#"); i >= 0 {
		host = host[:i]
	}
	if i := strings.LastIndex(host, "@"); i >= 0 {
		host = host[i+1:]
	}
	if i := strings.LastIndex(host, ":"); i >= 0 {
		host = host[:i]
	}
	host = strings.ToLower(host)
	if !strings.HasSuffix(host, ".turso.io") {
		return "", false
	}
	label := strings.TrimSuffix(host, ".turso.io")
	if label == "" || strings.Contains(label, ".") {
		return "", false
	}
	return label, true
}
