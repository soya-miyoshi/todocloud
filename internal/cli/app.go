// Package cli is the command layer: the flag tree, the store construction and
// the mapping from a failure onto one of the fixed exit codes.
//
// Everything a command needs is reached through an app value, which holds the
// injected environment. That indirection is what lets the tests drive the real
// command tree with captured streams and a controlled environment instead of
// touching the user's own configuration or state directory.
package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	ucli "github.com/urfave/cli/v3"

	"github.com/soya-miyoshi/todocloud/internal/config"
	"github.com/soya-miyoshi/todocloud/internal/exit"
	"github.com/soya-miyoshi/todocloud/internal/keyring"
	"github.com/soya-miyoshi/todocloud/internal/output"
	"github.com/soya-miyoshi/todocloud/internal/secret"
	"github.com/soya-miyoshi/todocloud/internal/store"
	"github.com/soya-miyoshi/todocloud/internal/store/sqlite"
	"github.com/soya-miyoshi/todocloud/internal/store/turso"
)

// Env is everything the command layer reads from outside the process
// arguments. The zero value means the real process environment.
type Env struct {
	Stdout io.Writer
	Stderr io.Writer
	Stdin  io.Reader
	// Getenv reads an environment variable. Tests supply a closed-over map so
	// that a developer's own TODOCLOUD_* variables cannot change a result.
	Getenv func(string) string
}

func (e *Env) normalize() {
	if e.Stdout == nil {
		e.Stdout = os.Stdout
	}
	if e.Stderr == nil {
		e.Stderr = os.Stderr
	}
	if e.Stdin == nil {
		e.Stdin = os.Stdin
	}
	if e.Getenv == nil {
		e.Getenv = os.Getenv
	}
}

// app carries the state shared by every command.
type app struct {
	env Env
	out output.Printer

	// configPath and provider mirror the global flags of the same name.
	configPath   string
	providerName string

	// cfg caches the resolved configuration, and warned records that its
	// warnings have already been printed, so a command that opens the store
	// twice does not repeat them.
	cfg    *config.Config
	warned bool

	// unknownCommand records the name urfave could not resolve, so that a
	// mistyped command exits 2 like any other usage error instead of printing
	// a help topic and exiting 1.
	unknownCommand string
}

// silentError carries an exit code without a message. `tdo doctor` uses it to
// report a failed check through its own documented JSON shape rather than
// through the error envelope.
type silentError struct{ code int }

func (e silentError) Error() string { return "" }

// Run executes the CLI against the real process streams and environment and
// returns the process exit code.
func Run(ctx context.Context, args []string) int {
	return RunWith(ctx, Env{}, args)
}

// RunWith executes the CLI against env. It never panics on a command failure
// and never calls os.Exit, so a test can assert on the code it returns.
func RunWith(ctx context.Context, env Env, args []string) int {
	env.normalize()

	a := &app{env: env}
	// The renderer has to know about --json before the flags are parsed,
	// because a parse failure must still produce the documented envelope.
	a.out = output.Printer{
		Out:   env.Stdout,
		Err:   env.Stderr,
		JSON:  hasFlag(args, "json"),
		Debug: hasFlag(args, "debug"),
	}

	err := a.root().Run(ctx, args)
	if a.unknownCommand != "" {
		err = exit.Usagef(fmt.Errorf("unknown command %q; run `tdo --help` for the list", a.unknownCommand))
	}
	if err == nil {
		return exit.OK
	}

	var silent silentError
	if errors.As(err, &silent) {
		return silent.code
	}

	code, jsonCode := exit.Classify(err)
	a.out.Fail(jsonCode, err)
	return code
}

// onUsageError turns a flag-parsing failure into a usage error, so that
// `tdo add --nope` exits 2 as docs/agents.md promises rather than 1.
func onUsageError(_ context.Context, cmd *ucli.Command, err error, _ bool) error {
	if err == nil {
		return nil
	}
	if cmd != nil && cmd.Name != "" {
		return exit.Usagef(fmt.Errorf("%s: %w", cmd.Name, err))
	}
	return exit.Usagef(err)
}

// hasFlag reports whether a boolean global flag appears anywhere in args. It
// is a pre-parse peek, used only to decide how a parse error is rendered.
func hasFlag(args []string, name string) bool {
	for _, arg := range args {
		if arg == "--"+name || arg == "-"+name {
			return true
		}
		if arg == "--" {
			return false
		}
	}
	return false
}

// globalFlags are accepted before and after the subcommand: urfave/cli v3
// applies a non-Local flag to every subcommand's flag set, sharing one value.
func (a *app) globalFlags() []ucli.Flag {
	return []ucli.Flag{
		&ucli.BoolFlag{
			Name:  "json",
			Usage: "write machine-readable JSON on stdout",
		},
		&ucli.BoolFlag{
			Name:  "debug",
			Usage: "write diagnostics to stderr (never a credential)",
		},
		&ucli.StringFlag{
			Name:  "config",
			Usage: "read configuration from `PATH` instead of the default",
		},
		&ucli.StringFlag{
			Name:  "provider",
			Usage: "override the configured provider `NAME`",
		},
	}
}

// root builds the command tree.
func (a *app) root() *ucli.Command {
	commands := []*ucli.Command{
		// Capture and the inbox.
		a.addCommand(),
		a.inboxCommand(),
		// Looking at things.
		a.listCommand(),
		a.showCommand(),
		a.nextCommand(),
		a.serveCommand(),
	}
	// done, undone, drop, hold, unhold, flag, unflag, defer, due and mv are
	// one family: they change a single property of each item they are given,
	// and they read in the help where a user looks for them.
	commands = append(commands, a.markCommands()...)
	commands = append(commands, []*ucli.Command{
		// Editing and removal.
		a.editCommand(),
		a.removeCommand(),
		// Structure.
		a.projectCommand(),
		a.folderCommand(),
		// Repetition, review and saved queries.
		a.repeatCommand(),
		a.seriesCommand(),
		a.reviewCommand(),
		a.perspectiveCommand(),
		// Administration.
		a.initCommand(),
		a.migrateCommand(),
		a.configCommand(),
		a.loginCommand(),
		a.doctorCommand(),
		a.exportCommand(),
		a.importCommand(),
		a.versionCommand(),
	}...)
	// A repeated flag must not also split on commas: `--set plan={"a":1,"b":2}`
	// and `--where title=a,b` are single values. The one flag that does take a
	// list, --tag, splits itself in parseTags.
	for _, c := range commands {
		c.DisableSliceFlagSeparator = true
		// A bad flag is the user's mistake at the command line, so it must
		// exit 2 like every other usage error. urfave reports it as a plain
		// error, which would otherwise be classified as a generic failure.
		c.OnUsageError = onUsageError
	}

	return &ucli.Command{
		Name:                  "tdo",
		Usage:                 "keep a todo list in a database you own",
		Version:               version,
		HideVersion:           true,
		Flags:                 a.globalFlags(),
		Reader:                a.env.Stdin,
		Writer:                a.env.Stdout,
		ErrWriter:             a.env.Stderr,
		EnableShellCompletion: false,
		// The default handler prints the error and calls os.Exit; this layer
		// renders the error itself and returns a code to main instead.
		ExitErrHandler:            func(context.Context, *ucli.Command, error) {},
		DisableSliceFlagSeparator: true,
		OnUsageError:              onUsageError,
		CommandNotFound: func(_ context.Context, _ *ucli.Command, name string) {
			a.unknownCommand = name
		},
		Commands: commands,
	}
}

// globals copies the global flag values onto the app. Every action calls it
// first, so `tdo ls --json` and `tdo --json ls` behave identically.
func (a *app) globals(cmd *ucli.Command) {
	root := cmd.Root()
	a.out.JSON = root.Bool("json")
	a.out.Debug = root.Bool("debug")
	a.configPath = root.String("config")
	a.providerName = root.String("provider")
}

// usagef returns a usage error, which exits with code 2.
func usagef(format string, args ...any) error {
	return exit.Usagef(fmt.Errorf(format, args...))
}

// config resolves the configuration once per process, applying the --provider
// override and printing any warnings to stderr.
func (a *app) config() (*config.Config, error) {
	if a.cfg != nil {
		return a.cfg, nil
	}
	cfg, err := config.Load(config.Options{
		Getenv:     a.env.Getenv,
		ConfigPath: a.configPath,
		Keyring:    configKeyringLookup,
	})
	if err != nil {
		return nil, exit.Configf(err)
	}
	if a.providerName != "" {
		cfg.Provider = config.Provider(strings.TrimSpace(a.providerName))
		if cfg.Origins == nil {
			cfg.Origins = map[string]string{}
		}
		cfg.Origins["provider"] = "flag:--provider"
	}
	if err := cfg.Validate(); err != nil {
		return nil, exit.Configf(err)
	}
	if !a.warned {
		for _, w := range cfg.Warnings {
			a.out.Warnf("%s", w)
		}
		a.warned = true
	}
	a.cfg = cfg
	return cfg, nil
}

// configKeyringLookup is the seam through which configuration resolves a token
// from the OS keychain. It exists so a test can replace it: without it, a test
// that runs with a cloud provider selected would query the developer's real
// keychain, which CLAUDE.md §1.5 forbids and which would make the result
// depend on the machine.
var configKeyringLookup = func(account string) (secret.Secret, bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), keyringTimeout)
	defer cancel()
	return keyring.Get(ctx, account)
}

// keyringTimeout bounds the keychain lookup, so a wedged helper cannot hang
// every command.
const keyringTimeout = 2 * time.Second

// The providers this build can open. They are compared as values rather than
// imported as constants so that the command layer holds no provider-specific
// type.
const (
	providerSQLite = config.Provider("sqlite")
	providerTurso  = config.Provider("turso")
)

// openStore resolves the configuration and opens the configured provider.
// The caller closes the store.
//
// create says whether this command is allowed to bring the store into being.
// Only `tdo init` passes true: a command that merely reads must not leave a
// directory tree and an empty database behind when the path is a typo, because
// an empty task list is indistinguishable from the real one.
func (a *app) openStore(create bool) (store.Store, error) {
	cfg, err := a.config()
	if err != nil {
		return nil, err
	}
	if !cfg.Provider.Implemented() {
		return nil, exit.Configf(fmt.Errorf("provider %q is not implemented in this build", cfg.Provider))
	}
	switch cfg.Provider {
	case providerSQLite:
		path, err := config.ExpandPath(cfg.SQLite.Path)
		if err != nil {
			return nil, exit.Configf(err)
		}
		a.out.Debugf("opening sqlite store at %s", path)
		open := sqlite.OpenExisting
		if create {
			open = sqlite.Open
		}
		st, err := open(path)
		if err != nil {
			// An uninitialized store is a configuration problem, and
			// exit.Classify reads the sentinel through the wrapper.
			return nil, exit.Providerf(err)
		}
		return st, nil
	case providerTurso:
		// The URL names a database that already exists on the user's Turso
		// account. Nothing here creates or deletes one: `tdo init` creates
		// the schema inside it, and that is the whole of what create means
		// for a remote provider.
		tc := turso.Config{URL: cfg.Turso.URL, Token: cfg.Turso.Token}
		open := turso.OpenExisting
		if create {
			open = turso.Open
		}
		st, err := open(tc)
		if err != nil {
			return nil, exit.Providerf(err)
		}
		// Describe() is the credential-free form; the configured URL is not
		// logged, because a URL is the one place a token has historically
		// been smuggled into a log line.
		a.out.Debugf("opened %s", st.Describe())
		return st, nil
	default:
		return nil, exit.Configf(fmt.Errorf("unknown provider %q", cfg.Provider))
	}
}

// providerOverride explains how the provider was selected when the choice did
// not come from the config file, and returns the empty string when it did.
//
// Writing to the wrong store is the failure mode that matters when a provider
// can be switched: the tasks are not lost, but they are somewhere the user is
// not looking. A command that writes therefore says where it wrote whenever
// something ambient or one-off picked the store.
func (a *app) providerOverride() string {
	if a.cfg == nil {
		return ""
	}
	origin := a.cfg.Origins["provider"]
	switch {
	case origin == "" || origin == "default" || strings.HasPrefix(origin, "file:"):
		// The configured store, chosen deliberately. Nothing to announce.
		return ""
	case strings.HasPrefix(origin, "flag:"):
		return "--provider selected it for this command only"
	}

	// An environment variable that merely restates the configured provider is
	// not an override, and on a machine with no config file the environment
	// *is* the configuration. Only a disagreement is worth a line on stderr.
	named, ok := a.cfg.FileProvider()
	if !ok || named == a.cfg.Provider {
		return ""
	}
	return fmt.Sprintf("%s overrides the %q named in %s", config.EnvProvider, named, a.cfg.Path)
}

// noticeOverriddenStore tells the user, on stderr, that this write is going
// somewhere other than the configured store.
func (a *app) noticeOverriddenStore(st store.Store) {
	if why := a.providerOverride(); why != "" {
		a.out.Warnf("writing to %s: %s", st.Describe(), why)
	}
}

// withStore opens the store, confirms it holds the schema this binary
// understands, runs fn and closes the store. A close failure is only
// reported when fn itself succeeded, so the real cause is never hidden.
//
// The schema check is the preamble every ordinary command runs. Without it a
// binary can query a schema it does not understand, and the failure modes
// are a raw engine error at best and a quietly wrong answer at worst — a
// listing missing the rows a column it has never heard of would have
// matched. It costs nothing worth counting: the sqlite provider reads one
// row of a one-row table, and the turso provider answers from the probe
// OpenExisting already made.
func (a *app) withStore(ctx context.Context, fn func(st store.Store) error) error {
	return a.withStoreOpened(ctx, false, true, fn)
}

// withUncheckedStore opens the store without the version check, for the two
// commands whose job is the mismatch itself: `tdo init`, which may be
// looking at a store that has no schema at all, and `tdo migrate`, which
// exists precisely to fix a version the check would refuse.
func (a *app) withUncheckedStore(ctx context.Context, fn func(st store.Store) error) error {
	return a.withStoreOpened(ctx, false, false, fn)
}

// withCreatedStore is withStore for `tdo init`, the one command that may
// create the store it opens.
func (a *app) withCreatedStore(ctx context.Context, fn func(st store.Store) error) error {
	return a.withStoreOpened(ctx, true, false, fn)
}

func (a *app) withStoreOpened(ctx context.Context, create, check bool, fn func(st store.Store) error) error {
	st, err := a.openStore(create)
	if err != nil {
		return err
	}
	if check {
		// A mismatch is reported before anything else happens, and the
		// store is closed rather than used: both directions are exit 3,
		// with the advice that applies — migrate, or upgrade tdo.
		if err := store.CheckSchema(ctx, st); err != nil {
			st.Close()
			return err
		}
	}
	runErr := fn(st)
	closeErr := st.Close()
	if runErr != nil {
		return runErr
	}
	if closeErr != nil {
		return exit.Providerf(closeErr)
	}
	return nil
}

// action adapts a command body to urfave/cli, reading the global flags first.
func (a *app) action(fn func(ctx context.Context, cmd *ucli.Command) error) ucli.ActionFunc {
	return func(ctx context.Context, cmd *ucli.Command) error {
		a.globals(cmd)
		return fn(ctx, cmd)
	}
}

// storeAction is the same for a command that needs the store.
func (a *app) storeAction(fn func(ctx context.Context, cmd *ucli.Command, st store.Store) error) ucli.ActionFunc {
	return a.action(func(ctx context.Context, cmd *ucli.Command) error {
		return a.withStore(ctx, func(st store.Store) error {
			return fn(ctx, cmd, st)
		})
	})
}

// storeCreateAction is storeWriteAction for `tdo init`, which is allowed to
// create the store. The notice about an overridden provider matters most here,
// since this is the command that can bring a second store into existence.
func (a *app) storeCreateAction(fn func(ctx context.Context, cmd *ucli.Command, st store.Store) error) ucli.ActionFunc {
	return a.action(func(ctx context.Context, cmd *ucli.Command) error {
		// The guard sits ahead of withCreatedStore so that a stray argument
		// is refused before a store is brought into being: `tdo init junk`
		// must not leave a database behind on its way to exit 2.
		if cmd.Args().Len() > 0 {
			return usagef("%s takes no arguments", cmd.Name)
		}
		return a.withCreatedStore(ctx, func(st store.Store) error {
			a.noticeOverriddenStore(st)
			return fn(ctx, cmd, st)
		})
	})
}

// storeWriteAction is storeAction for a command that changes the store. It
// names the store first when the provider was overridden, so a stale
// TODOCLOUD_PROVIDER or a mistyped --provider cannot quietly redirect a write.
func (a *app) storeWriteAction(fn func(ctx context.Context, cmd *ucli.Command, st store.Store) error) ucli.ActionFunc {
	return a.action(func(ctx context.Context, cmd *ucli.Command) error {
		return a.withStore(ctx, func(st store.Store) error {
			a.noticeOverriddenStore(st)
			return fn(ctx, cmd, st)
		})
	})
}
