package cli

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"strings"

	ucli "github.com/urfave/cli/v3"

	"github.com/soya-miyoshi/todocloud/internal/config"
	"github.com/soya-miyoshi/todocloud/internal/exit"
	"github.com/soya-miyoshi/todocloud/internal/keyring"
	"github.com/soya-miyoshi/todocloud/internal/providercli"
	"github.com/soya-miyoshi/todocloud/internal/secret"
)

// The keychain is reached through these indirections rather than called
// directly, so that a test can drive every branch of this command — a machine
// with no backend, an unwritable one, a stored token — without ever touching
// the developer's own keychain.
var (
	keyringBackend   = keyring.Backend
	keyringAvailable = keyring.Available
	keyringGet       = keyring.Get
	keyringSet       = keyring.Set
	keyringDelete    = keyring.Delete
)

// The provider CLIs are reached through the same kind of indirection, so that
// a test can drive an absent turso, a turso that is not logged in and a turso
// that mints a token — without ever executing the real binary, which would put
// the user's own credentials in the test output.
var (
	tursoAvailable   = providercli.TursoAvailable
	tursoLoggedIn    = providercli.TursoLoggedIn
	tursoDatabases   = providercli.TursoDatabases
	tursoCreateToken = providercli.TursoCreateToken
	tursoDatabaseURL = providercli.TursoDatabaseURL
)

// loginStdinIsTerminal is the terminal check the confirmation guards in this
// file go through. It is a variable so that a test can simulate a user at a
// terminal without a real tty; app.stdinIsTerminal is the real answer.
var loginStdinIsTerminal = func(a *app) bool { return a.stdinIsTerminal() }

// loginCommand stores a provider token in the OS keychain.
//
// Two properties shape this command. First, the token is read from stdin and
// only from stdin: there is no flag that takes it, because argv is readable by
// every process on the machine through `ps` and is written to shell history.
// Second, it must work before the store exists — a user logs in before
// `tdo init` — so it never opens the store, and a machine with no keychain is
// not a failure: the user is told the command to run themselves and the
// command exits 0.
func (a *app) loginCommand() *ucli.Command {
	return &ucli.Command{
		Name:  "login",
		Usage: "obtain the provider's credential, delegating to the provider's own CLI where it can",
		Description: "With the Turso CLI installed and logged in, no token is pasted at all: tdo runs " +
			"`turso db tokens create` to mint one scoped to a single database, which is " +
			"narrower than a token created by hand, and stores it in the OS keychain. " +
			"Otherwise, and for Cloudflare " +
			"D1, the token is read from stdin; there is no flag that takes it, because " +
			"argv is visible to other processes and lands in shell history. On a terminal " +
			"the prompt is not echoed; otherwise one line is read with no prompt, which is " +
			"what a script or an agent uses.",
		Flags: []ucli.Flag{
			&ucli.BoolFlag{
				Name:  "remove",
				Usage: "delete the stored token instead of storing one",
			},
			&ucli.BoolFlag{
				Name:  "show",
				Usage: "report whether a token is stored, never its value",
			},
			// A database name is not a secret, so a flag is the right place
			// for it: it only selects which database the Turso CLI mints a
			// token for.
			&ucli.StringFlag{
				Name:  "database",
				Usage: "the Turso database `NAME` to mint a token for",
			},
			// The two paths with effects a caller cannot take back — deleting
			// a stored token, and minting a new one on the user's Turso
			// account — ask first. This is the explicit opt-in, named as in
			// `tdo rm --purge --yes`.
			&ucli.BoolFlag{
				Name:  "yes",
				Usage: "skip the confirmation prompt",
			},
			// What tdo learns while minting — the provider and the database
			// URL — is written to the config file, so there is nothing to
			// paste by hand. A URL is not a credential, and the token is
			// never written to a file. This flag opts out.
			&ucli.BoolFlag{
				Name:  "no-save",
				Usage: "do not write the provider and database URL to your config file",
			},
		},
		Action: a.action(func(ctx context.Context, cmd *ucli.Command) error {
			return a.login(ctx, cmd.Bool("remove"), cmd.Bool("show"), cmd.Bool("yes"), !cmd.Bool("no-save"), cmd.String("database"))
		}),
	}
}

func (a *app) login(ctx context.Context, remove, show, yes, save bool, database string) error {
	if remove && show {
		return usagef("--remove and --show cannot be combined")
	}

	provider, err := a.loginProvider()
	if err != nil {
		return err
	}
	if database != "" {
		if provider != config.ProviderTurso {
			return usagef("--database applies to the turso provider only, not %q", provider)
		}
		if remove || show {
			return usagef("--database cannot be combined with --remove or --show")
		}
	}

	account, err := loginAccount(provider)
	if err != nil {
		return err
	}

	backend := keyringBackend()

	switch {
	case show:
		return a.loginShow(ctx, provider, account, backend)
	case remove:
		return a.loginRemove(ctx, provider, account, backend, yes)
	default:
		return a.loginStore(ctx, provider, account, backend, database, yes, save)
	}
}

// loginProvider resolves which provider's token is being managed. It reads
// the configuration without validating it, because a user who has no token
// yet is exactly the user running this command.
func (a *app) loginProvider() (config.Provider, error) {
	if name := strings.TrimSpace(a.providerName); name != "" {
		return config.Provider(name), nil
	}
	cfg, err := config.Load(config.Options{
		Getenv:     a.env.Getenv,
		ConfigPath: a.configPath,
	})
	if err != nil {
		return "", exit.Configf(err)
	}
	return cfg.Provider, nil
}

// loginAccount maps a provider onto the keychain entry that holds its token.
// A provider that has no token is a usage error, not a silent success.
func loginAccount(provider config.Provider) (string, error) {
	switch provider {
	case config.ProviderTurso:
		return keyring.AccountTursoToken, nil
	case config.ProviderD1:
		return keyring.AccountD1Token, nil
	case config.ProviderSQLite:
		return "", usagef("provider %q needs no credential: local SQLite is a file on your disk, so there is nothing to log in to", provider)
	case config.ProviderFirestore:
		// A removed provider is a configuration problem, exit 3, the same
		// answer every other command gives for it. An agent that branches on
		// the exit code must not see one cause reported two ways.
		return "", exit.Configf(fmt.Errorf("provider %q was removed and is not coming back; see docs/providers.md", provider))
	default:
		return "", usagef("unknown provider %q", provider)
	}
}

// loginShow reports presence and a hint. The value is never rendered: the
// hint comes from secret.Secret.Hint, which is the redaction marker plus at
// most four trailing characters.
func (a *app) loginShow(ctx context.Context, provider config.Provider, account, backend string) error {
	if !keyringAvailable() {
		return a.loginUnavailable(provider, account, "present", false)
	}
	value, present, err := keyringGet(ctx, account)
	if err != nil {
		return exit.Configf(err)
	}
	hint := value.Hint()
	if a.out.JSON {
		return a.out.Emit(map[string]any{
			"provider": string(provider),
			"account":  account,
			"backend":  backend,
			"present":  present,
			"hint":     hint,
		})
	}
	if !present {
		a.out.Printf("no token stored for %s in the %s\n", provider, backend)
		return nil
	}
	a.out.Printf("token stored for %s in the %s: %s\n", provider, backend, hint)
	return nil
}

// loginRemove deletes the stored token. The deletion cannot be undone — the
// token has to be re-minted or re-pasted — so it asks, in the same shape as
// `tdo rm --purge`: on a terminal it prompts, and without one it refuses
// rather than assuming consent.
func (a *app) loginRemove(ctx context.Context, provider config.Provider, account, backend string, yes bool) error {
	if !keyringAvailable() {
		return a.loginUnavailable(provider, account, "removed", false)
	}
	if !yes {
		if !loginStdinIsTerminal(a) {
			return usagef("refusing to delete the stored %s token without a terminal to confirm at; pass --yes", provider)
		}
		ok, err := a.confirm(fmt.Sprintf("Delete the stored %s token from the %s? It cannot be recovered.", provider, backend))
		if err != nil {
			return err
		}
		if !ok {
			// Declining is not a failure; nothing was deleted.
			a.out.Hintf("Cancelled; the stored %s token was left in place.", provider)
			if a.out.JSON {
				return a.out.Emit(map[string]any{
					"provider": string(provider),
					"account":  account,
					"backend":  backend,
					"stored":   true,
					"removed":  false,
				})
			}
			return nil
		}
	}
	if err := keyringDelete(ctx, account); err != nil {
		return exit.Configf(err)
	}
	if a.out.JSON {
		return a.out.Emit(map[string]any{
			"provider": string(provider),
			"account":  account,
			"backend":  backend,
			"stored":   false,
			"removed":  true,
		})
	}
	a.out.Printf("removed the stored %s token from the %s\n", provider, backend)
	return nil
}

func (a *app) loginStore(ctx context.Context, provider config.Provider, account, backend, database string, yes, save bool) error {
	// Delegation first: when the provider's own CLI can mint a credential, it
	// mints a better one than the user would create by hand.
	if provider == config.ProviderTurso {
		if tursoAvailable() {
			return a.loginTurso(ctx, provider, account, backend, database, yes, save)
		}
		a.out.Hintf("the turso CLI is not installed, so tdo cannot mint a token scoped to one database for you.")
		a.out.Hintf("  install it with `brew install tursodatabase/tap/turso`, run `turso auth login`, then `tdo login` again.")
		a.out.Hintf("falling back to reading a token from stdin.")
	}

	if !keyringAvailable() {
		return a.loginUnavailable(provider, account, "stored", false)
	}

	if provider == config.ProviderD1 {
		// SECURITY.md: this is a property of Cloudflare's token model, not of
		// anything tdo does, and the user should know it before they paste.
		a.out.Warnf("a Cloudflare API token cannot be scoped to a single D1 database: the token you are about to paste can read and modify every D1 database in that account. Use an account whose only D1 database is this one, or choose turso instead.")
	}

	token, err := a.readToken(provider)
	if err != nil {
		return err
	}
	if token.Empty() {
		return usagef("no token on stdin: pipe it in or run this on a terminal, never as a flag")
	}

	if err := keyringSet(ctx, account, token); err != nil {
		// An unwritable backend is not a failure of this command: the user is
		// told what to run in their own shell, with their own argv.
		if errors.Is(err, keyring.ErrWriteUnsupported) || errors.Is(err, keyring.ErrUnavailable) {
			return a.loginUnavailable(provider, account, "stored", true)
		}
		return exit.Configf(err)
	}

	if a.out.JSON {
		result := map[string]any{
			"provider": string(provider),
			"account":  account,
			"backend":  backend,
			"stored":   true,
		}
		// Every stored token reports which path produced it, so a caller can
		// tell a pasted token from one a provider CLI minted without knowing
		// which providers support delegation.
		result["source"] = providercli.SourceStdin
		return a.out.Emit(result)
	}
	a.out.Printf("stored the %s token in the %s\n", provider, backend)
	a.out.Hintf("tdo now reads it from the keychain; you can unset the %s environment variable.", tokenEnvName(provider))
	return nil
}

// loginUnavailable degrades honestly: it prints the command the user can run
// themselves to stderr and exits 0, because nothing failed — the user has
// been told what to do. field names the key the caller would have set, so
// that --show and --remove keep their own documented shapes.
func (a *app) loginUnavailable(provider config.Provider, account, field string, hadToken bool) error {
	instructions := keyring.ManualInstructions(account)
	if a.out.JSON {
		return a.out.Emit(map[string]any{
			"provider":     string(provider),
			"account":      account,
			"backend":      keyring.BackendNone,
			field:          false,
			"instructions": instructions,
		})
	}
	if hadToken {
		a.out.Hintf("tdo will not run this for you: the keychain binary on this platform only takes a token as a command-line argument, which would expose it through `ps` and your shell history. Run it yourself, in your own shell:")
	} else {
		a.out.Hintf("no OS keychain is available here, so tdo cannot store a token for you. To store one yourself:")
	}
	a.out.Hintf("  %s", instructions)
	return nil
}

// tokenEnvName is the environment variable the user can now unset. It is
// named, never read.
func tokenEnvName(provider config.Provider) string {
	switch provider {
	case config.ProviderD1:
		return "TODOCLOUD_D1_TOKEN"
	default:
		return "TODOCLOUD_TURSO_TOKEN"
	}
}

// readToken reads the token from stdin and nowhere else. On a terminal it
// prompts on stderr with echo disabled; otherwise it reads one line with no
// prompt, which is the non-interactive contract.
func (a *app) readToken(provider config.Provider) (secret.Secret, error) {
	if a.stdinIsTerminal() {
		fmt.Fprintf(a.env.Stderr, "Token for %s (not echoed): ", provider)
		restore := a.disableEcho()
		defer restore()
		token, err := a.readTokenLine()
		// The user's newline was swallowed by the disabled echo, so the next
		// line of output would otherwise run on from the prompt.
		fmt.Fprintln(a.env.Stderr)
		return token, err
	}
	return a.readTokenLine()
}

// readTokenLine reads one line and trims only the line ending: a token is
// used exactly as given, never silently altered.
func (a *app) readTokenLine() (secret.Secret, error) {
	line, err := bufio.NewReader(a.env.Stdin).ReadString('\n')
	if err != nil && line == "" {
		if errors.Is(err, io.EOF) {
			// No token on stdin at all; the caller turns that into a usage
			// error with advice, not an I/O failure.
			return secret.Secret{}, nil
		}
		return secret.Secret{}, fmt.Errorf("read token from stdin: %w", err)
	}
	line = strings.TrimSuffix(line, "\n")
	line = strings.TrimSuffix(line, "\r")
	return secret.New(line), nil
}

// disableEcho turns terminal echo off by executing stty, and returns the
// function that turns it back on. There is no term package in this module's
// dependency set, and adding a cgo one would break CGO_ENABLED=0 builds.
//
// The returned function is safe to call more than once. It is installed with
// defer and also from a SIGINT handler, so a Ctrl-C at the prompt cannot
// leave the user with an echo-less shell.
func (a *app) disableEcho() func() {
	tty, ok := a.env.Stdin.(*os.File)
	if !ok {
		return func() {}
	}
	if _, err := exec.LookPath("stty"); err != nil {
		// Without stty the token would be echoed. Say so rather than
		// silently showing it on screen.
		a.out.Warnf("stty is not available, so the token will be visible as you type")
		return func() {}
	}
	if err := sttyEcho(tty, "-echo"); err != nil {
		a.out.Warnf("could not disable terminal echo, so the token will be visible as you type")
		return func() {}
	}

	done := make(chan struct{})
	restored := false
	restore := func() {
		if restored {
			return
		}
		restored = true
		close(done)
		_ = sttyEcho(tty, "echo")
	}

	interrupt := make(chan os.Signal, 1)
	signal.Notify(interrupt, os.Interrupt)
	go func() {
		select {
		case <-interrupt:
			_ = sttyEcho(tty, "echo")
		case <-done:
		}
		signal.Stop(interrupt)
	}()

	return restore
}

// sttyEcho runs stty against tty. The mode is a fixed literal, never anything
// derived from input.
func sttyEcho(tty *os.File, mode string) error {
	cmd := exec.Command("stty", mode)
	cmd.Stdin = tty
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

// loginTurso delegates to the Turso CLI. This is the recommended path, and it
// is also the safest one available: `turso db tokens create <database>` mints
// a credential that reaches exactly one database, which is narrower than
// anything a user would create in the dashboard by hand.
//
// The minted token lives only in a secret.Secret between the child's stdout
// and the keychain. If it cannot be stored it is discarded, never printed: a
// token on a terminal is a token in a scrollback buffer.
func (a *app) loginTurso(ctx context.Context, provider config.Provider, account, backend, database string, yes, save bool) error {
	loggedIn, err := tursoLoggedIn(ctx)
	if err != nil {
		return exit.Configf(fmt.Errorf("could not ask the turso CLI whether you are logged in: %w", err))
	}
	if !loggedIn {
		return exit.Configf(errors.New("the turso CLI is installed but not logged in: run `turso auth login`, then `tdo login` again"))
	}

	db, err := a.resolveTursoDatabase(ctx, database)
	if err != nil {
		return err
	}

	// Minting reaches outside this machine: it creates a new token on the
	// user's Turso account. On a terminal that is confirmed first; without
	// one it is refused rather than guessed at, and in particular it does not
	// fall back to reading a token from stdin — that would silently store a
	// different credential than the caller asked for.
	if !yes {
		if !loginStdinIsTerminal(a) {
			return usagef("refusing to mint a new turso token for database %q without a terminal to confirm at; pass --yes", db)
		}
		ok, err := a.confirm(fmt.Sprintf("Create a new token on your Turso account for database %q?", db))
		if err != nil {
			return err
		}
		if !ok {
			// Declining is not a failure: no token was created, so there is
			// nothing to store and nothing to undo.
			a.out.Hintf("Cancelled; no token was created on your Turso account and nothing was stored.")
			if a.out.JSON {
				return a.out.Emit(map[string]any{
					"provider": string(provider),
					"account":  account,
					"backend":  backend,
					"stored":   false,
					"source":   providercli.SourceTursoCLI,
					"database": db,
				})
			}
			return nil
		}
	}

	a.out.Debugf("minting a turso token scoped to database %s", db)
	token, err := tursoCreateToken(ctx, db)
	if err != nil {
		// The error carries the child's exit status and stderr only; its
		// stdout, which is the token, is dropped inside providercli.
		return exit.Configf(fmt.Errorf("mint a token for turso database %q: %w", db, err))
	}

	if !keyringAvailable() {
		return a.loginTursoUnstorable(ctx, provider, account, db, save)
	}
	if err := keyringSet(ctx, account, token); err != nil {
		if errors.Is(err, keyring.ErrWriteUnsupported) || errors.Is(err, keyring.ErrUnavailable) {
			return a.loginTursoUnstorable(ctx, provider, account, db, save)
		}
		return exit.Configf(err)
	}

	// The save happens before the result is rendered, because --json reports
	// in one object both what was stored and what was written.
	written := a.saveTursoConfig(ctx, db, save)

	if a.out.JSON {
		result := map[string]any{
			"provider": string(provider),
			"account":  account,
			"backend":  backend,
			"stored":   true,
			"source":   providercli.SourceTursoCLI,
			"database": db,
		}
		for k, v := range configWriteJSON(written) {
			result[k] = v
		}
		return a.out.Emit(result)
	}
	a.out.Printf("minted a token for the turso database %q with the turso CLI and stored it in the %s\n", db, backend)
	return nil
}

// loginTursoUnstorable handles a token that was minted but cannot be stored.
// It exits 0 — nothing failed, the user has been told what to do — and prints
// no token: the one we minted is dropped, and the user mints their own.
func (a *app) loginTursoUnstorable(ctx context.Context, provider config.Provider, account, db string, save bool) error {
	instructions := fmt.Sprintf(
		"turso db tokens create %s   # then export TODOCLOUD_TURSO_TOKEN with its output", db)
	written := a.saveTursoConfig(ctx, db, save)
	if a.out.JSON {
		result := map[string]any{
			"provider":     string(provider),
			"account":      account,
			"backend":      keyring.BackendNone,
			"stored":       false,
			"source":       providercli.SourceTursoCLI,
			"database":     db,
			"instructions": instructions,
		}
		for k, v := range configWriteJSON(written) {
			result[k] = v
		}
		if err := a.out.Emit(result); err != nil {
			return err
		}
	} else {
		a.out.Hintf("a token was minted but there is no keychain here to store it in, so it has been discarded rather than printed. Mint one yourself and put it in your environment:")
		a.out.Hintf("  %s", instructions)
	}
	return nil
}

// saveTursoConfig records what the mint just established — the provider, and
// the database URL — in the user's config file, so that there is no line to
// paste by hand. A URL is not a credential; the token is not written here or
// anywhere else, and config.Set refuses the key outright.
//
// It returns what it wrote, or nil when nothing was written, and never fails
// the command: the token is already in the keychain, so a config file that
// cannot be written is a missing convenience, not a failed login. In that
// case the lines to paste are printed exactly as they always were.
func (a *app) saveTursoConfig(ctx context.Context, db string, save bool) *config.WriteResult {
	url, err := tursoDatabaseURL(ctx, db)
	if err != nil || url == "" {
		a.out.Debugf("could not read the database url from the turso CLI; skipping the config file")
		return nil
	}

	if !save {
		a.out.Hintf("--no-save: not touching your config file. To configure this database by hand:")
		a.tursoConfigLines(url)
		return nil
	}

	res, err := config.Set(config.WriteOptions{
		Getenv:     a.env.Getenv,
		ConfigPath: a.configPath,
	}, config.Setting{Key: "provider", Value: string(config.ProviderTurso)},
		config.Setting{Table: string(config.ProviderTurso), Key: "url", Value: url})
	if err != nil {
		a.out.Warnf("the token is stored, but your config file was not updated: %v", err)
		a.out.Hintf("add this to your config file, or set the environment variables, yourself:")
		a.tursoConfigLines(url)
		return nil
	}

	a.reportConfigWrite(res)
	return res
}

// tursoConfigLines prints the config-file lines for a database. A URL is not
// a credential, so it may be shown; it goes to stderr because it is advice,
// not this command's result.
func (a *app) tursoConfigLines(url string) {
	a.out.Hintf("  provider = %q", string(config.ProviderTurso))
	a.out.Hintf("  [turso]")
	a.out.Hintf("  url = %q", url)
}

// reportConfigWrite says on stderr which file was written and which keys
// changed. A write the user did not ask for is never silent.
func (a *app) reportConfigWrite(res *config.WriteResult) {
	if res == nil {
		return
	}
	changed := make([]string, 0, len(res.Changes))
	for _, c := range res.Changes {
		if c.Changed {
			changed = append(changed, fmt.Sprintf("%s = %q", c.Name, c.Value))
		}
	}
	if len(changed) == 0 {
		a.out.Hintf("your config file %s already said %s; nothing was changed.", res.Path, configKeyList(res))
		return
	}
	verb := "updated"
	if res.Created {
		verb = "created"
	}
	a.out.Hintf("%s %s: %s", verb, res.Path, strings.Join(changed, ", "))
}

// configKeyList names the keys a write considered, for the message that says
// nothing needed changing.
func configKeyList(res *config.WriteResult) string {
	names := make([]string, 0, len(res.Changes))
	for _, c := range res.Changes {
		names = append(names, c.Name)
	}
	return strings.Join(names, " and ")
}

// configWriteJSON describes a config-file write for `tdo login --json`, or
// reports that none happened. The keys are always present, so a caller never
// has to branch on their absence.
func configWriteJSON(res *config.WriteResult) map[string]any {
	out := map[string]any{
		"config_file":    "",
		"config_written": false,
		"config_keys":    []string{},
	}
	if res == nil {
		return out
	}
	keys := make([]string, 0, len(res.Changes))
	for _, c := range res.Changes {
		if c.Changed {
			keys = append(keys, c.Name)
		}
	}
	out["config_file"] = res.Path
	out["config_written"] = res.Wrote
	out["config_keys"] = keys
	return out
}

// resolveTursoDatabase works out which database to mint for, cheapest source
// first: the flag, then the configured URL, then the account's database list
// when it holds exactly one. Anything else is a usage error, because guessing
// would mint a credential for the wrong database.
func (a *app) resolveTursoDatabase(ctx context.Context, database string) (string, error) {
	if db := strings.TrimSpace(database); db != "" {
		return db, nil
	}

	url := a.configuredTursoURL()
	if url != "" {
		if db, ok := providercli.DatabaseFromURL(url); ok {
			return db, nil
		}
		// The `<database>-<organization>` split is ambiguous for this host —
		// a name may itself contain dashes — so ask the CLI instead of
		// guessing.
		if names, err := tursoDatabases(ctx); err == nil {
			if db, ok := providercli.MatchDatabaseInURL(url, names); ok {
				return db, nil
			}
			if len(names) == 1 {
				return names[0], nil
			}
		}
		return "", usagef("could not tell which turso database %q refers to; pass --database NAME", url)
	}

	names, err := tursoDatabases(ctx)
	if err != nil {
		return "", usagef("could not list your turso databases (%v); pass --database NAME", err)
	}
	switch len(names) {
	case 0:
		return "", usagef("the turso CLI lists no databases; create one with `turso db create NAME`, then pass --database NAME")
	case 1:
		return names[0], nil
	default:
		return "", usagef("you have %d turso databases (%s); pass --database NAME to say which one this token is for",
			len(names), strings.Join(names, ", "))
	}
}

// configuredTursoURL reads the Turso URL without validating the rest of the
// configuration: a user who has no token yet is exactly the user running this
// command, so Validate would reject them.
func (a *app) configuredTursoURL() string {
	cfg, err := config.Load(config.Options{
		Getenv:     a.env.Getenv,
		ConfigPath: a.configPath,
	})
	if err != nil {
		return ""
	}
	return strings.TrimSpace(cfg.Turso.URL)
}
