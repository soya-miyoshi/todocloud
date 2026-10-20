package cli

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"

	ucli "github.com/urfave/cli/v3"

	"github.com/soya-miyoshi/todocloud/internal/config"
	"github.com/soya-miyoshi/todocloud/internal/exit"
	"github.com/soya-miyoshi/todocloud/internal/store"
	"github.com/soya-miyoshi/todocloud/internal/store/schema"
)

// version is the released version. It is overridden at link time with
// -ldflags "-X github.com/soya-miyoshi/todocloud/internal/cli.version=v1.2.3".
var version = "0.1.0-dev"

// commit is the source revision, set the same way. It is empty in a plain
// `go build`, and reported as the empty string rather than invented.
var commit = ""

func (a *app) versionCommand() *ucli.Command {
	return &ucli.Command{
		Name:  "version",
		Usage: "print the version of this binary",
		Action: a.action(func(ctx context.Context, cmd *ucli.Command) error {
			if cmd.Args().Len() > 0 {
				return usagef("version takes no arguments")
			}
			if a.out.JSON {
				return a.out.Emit(map[string]any{
					"version": version,
					"commit":  commit,
					"go":      runtime.Version(),
				})
			}
			if commit == "" {
				a.out.Printf("tdo %s (%s)\n", version, runtime.Version())
				return nil
			}
			a.out.Printf("tdo %s (%s, %s)\n", version, commit, runtime.Version())
			return nil
		}),
	}
}

func (a *app) initCommand() *ucli.Command {
	return &ucli.Command{
		Name:  "init",
		Usage: "create the schema in the configured provider",
		Action: a.storeCreateAction(func(ctx context.Context, cmd *ucli.Command, st store.Store) error {
			cfg, err := a.config()
			if err != nil {
				return err
			}
			// Whether this run brought the store into being has to be
			// decided before Init, which is idempotent and afterwards looks
			// the same either way. A caller needs the difference: "I just
			// made an empty list" is not "the list was already here".
			created := false
			if _, err := st.SchemaVersion(ctx); err != nil {
				if !errors.Is(err, store.ErrNotInitialized) {
					return err
				}
				created = true
			}
			if err := st.Init(ctx); err != nil {
				return err
			}
			// Named recorded, not schema: the schema package is in
			// scope here and a shadow would be a trap for the next edit.
			recorded, err := st.SchemaVersion(ctx)
			if err != nil {
				return err
			}
			if a.out.JSON {
				return a.out.Emit(map[string]any{
					"provider":       string(cfg.Provider),
					"schema_version": recorded,
					"initialized":    true,
					"created":        created,
				})
			}
			if created {
				a.out.Printf("created %s at schema version %d\n", st.Describe(), recorded)
				return nil
			}
			a.out.Printf("%s is already initialized at schema version %d\n", st.Describe(), recorded)
			return nil
		}),
	}
}

func (a *app) migrateCommand() *ucli.Command {
	return &ucli.Command{
		Name:  "migrate",
		Usage: "upgrade the store's schema to this binary's version",
		Flags: []ucli.Flag{
			&ucli.BoolFlag{
				Name:  "yes",
				Usage: "confirm a migration of a store that cannot be backed up",
			},
		},
		// The store is opened unchecked: a version this binary refuses to
		// read is exactly the state this command is here to fix.
		Action: a.action(func(ctx context.Context, cmd *ucli.Command) error {
			if cmd.Args().Len() > 0 {
				return usagef("migrate takes no arguments")
			}
			return a.withUncheckedStore(ctx, func(st store.Store) error {
				a.noticeOverriddenStore(st)
				return a.migrate(ctx, st, cmd.Bool("yes"))
			})
		}),
	}
}

// migrate plans the upgrade, says what was saved and what is about to
// happen, asks when there is nothing to fall back on, and only then changes
// the store.
//
// The order matters more than it looks. The backup is taken by the plan,
// before any statement runs, so the path can be printed while the data is
// still as it was; a user watching the next step fail has already been told
// where the copy is.
func (a *app) migrate(ctx context.Context, st store.Store, yes bool) error {
	plan, err := store.PlanMigration(ctx, st)
	if err != nil {
		// A store written by a newer binary arrives here as a
		// VersionError, which is exit 3 and says to upgrade tdo.
		return err
	}

	// The backup exists whether or not the rest of this succeeds, so it is
	// reported before anything else, including before the no-op case can
	// return.
	if plan.BackupPath != "" {
		a.out.Hintf("Backed up %s to %s before migrating.", plan.Store, plan.BackupPath)
	}

	if plan.UpToDate {
		if a.out.JSON {
			return a.out.Emit(migrateJSON(plan, plan.From))
		}
		a.out.Printf("already at schema version %d\n", plan.From)
		return nil
	}

	if plan.Confirm && !yes {
		// No backup could be taken, and a migration cannot be undone. This
		// is the one administrative command with consequences, so it
		// follows `tdo rm --purge`: it prompts a user and refuses a
		// script rather than assuming consent nobody gave.
		if !a.stdinIsTerminal() {
			return usagef("refusing to migrate %s from schema version %d to %d without a terminal to confirm at: %s; pass --yes",
				plan.Store, plan.From, plan.To, plan.Warning)
		}
		a.out.Warnf("%s", plan.Warning)
		ok, err := a.confirm(fmt.Sprintf("Migrate %s from schema version %d to %d?", plan.Store, plan.From, plan.To))
		if err != nil {
			return err
		}
		if !ok {
			// Declining is not a failure; the store was not touched.
			a.out.Hintf("Cancelled; %s was not migrated.", plan.Store)
			if a.out.JSON {
				return a.out.Emit(migrateJSON(plan, plan.From))
			}
			return nil
		}
	}

	if err := st.Migrate(ctx); err != nil {
		return err
	}

	// What the store says afterwards, not what the plan hoped for: a
	// migration that reported success without arriving at the version this
	// binary writes would hand every later command a schema it does not
	// understand.
	reached, err := st.SchemaVersion(ctx)
	if err != nil {
		return err
	}
	if reached != plan.To {
		return fmt.Errorf("%s is at schema version %d after migrating rather than %d; it was not left in the state this tdo expects", plan.Store, reached, plan.To)
	}

	if a.out.JSON {
		return a.out.Emit(migrateJSON(plan, reached))
	}
	a.out.Printf("migrated from schema version %d to %d\n", plan.From, reached)
	return nil
}

// migrateJSON renders the documented shape. from, to and migrated are the
// original three keys and keep their meaning; backup_path and steps were
// added with the migration machinery and are always present, empty when
// there is no backup and no step to run.
func migrateJSON(plan store.MigrationPlan, reached int) map[string]any {
	return map[string]any{
		"from":        plan.From,
		"to":          reached,
		"migrated":    reached != plan.From,
		"backup_path": plan.BackupPath,
		"steps":       stepNames(plan.Steps),
	}
}

// stepNames renders a possibly nil slice as a JSON array rather than null,
// so a caller can iterate it without a nil check.
func stepNames(steps []string) []string {
	if steps == nil {
		return []string{}
	}
	return steps
}

func (a *app) configCommand() *ucli.Command {
	set := a.configSetCommand()
	// A subcommand is not reached by the loop in root() that fixes these two
	// up, so it sets them itself: a bad flag here must exit 2 like everywhere
	// else, and a value holding a comma is one value.
	set.DisableSliceFlagSeparator = true
	set.OnUsageError = onUsageError

	return &ucli.Command{
		Name:     "config",
		Usage:    "print the resolved configuration, with every secret redacted",
		Commands: []*ucli.Command{set},
		Action: a.action(func(ctx context.Context, cmd *ucli.Command) error {
			if cmd.Args().Len() > 0 {
				return usagef("config takes no arguments, or `config set <key> <value>`")
			}
			cfg, err := a.config()
			if err != nil {
				return err
			}
			// Describe is the only rendering of a Config there is: it is
			// redacted by construction, and the struct itself must never be
			// formatted into output.
			described := cfg.Describe()
			if a.out.JSON {
				return a.out.Emit(described)
			}
			keys := make([]string, 0, len(described))
			for k := range described {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				a.out.Printf("%s = %v\n", k, described[k])
			}
			return nil
		}),
	}
}

// configSetCommand writes one setting into the user's config file.
//
// It is the general answer to "tdo told me a line to paste": tdo maintains
// the file itself. What it will not do is write a credential — a key named
// `token`, or any of the other secret-shaped spellings, is refused here and
// again inside the writer, because a token belongs in the OS keychain where
// `tdo login` puts it.
func (a *app) configSetCommand() *ucli.Command {
	return &ucli.Command{
		Name:      "set",
		Usage:     "set one key in your config file, leaving the rest of the file untouched",
		ArgsUsage: "<key> <value>",
		Description: "The key is `table.key` (`turso.url`, `sqlite.path`) or a bare top-level " +
			"key (`provider`). The file is edited in place — comments, blank lines, key " +
			"order and spacing survive — and replaced atomically at mode 0600. tdo writes " +
			"only " + xdgConfigHint + " or the file named by $" + config.EnvConfig + ", never one inside a git " +
			"repository, and never a credential.",
		Action: a.action(func(ctx context.Context, cmd *ucli.Command) error {
			args := cmd.Args().Slice()
			if len(args) != 2 {
				return usagef("config set takes exactly two arguments, a key and a value: `tdo config set turso.url libsql://example.turso.io`")
			}
			table, key, err := config.ParseKey(args[0])
			if err != nil {
				return exit.Usagef(err)
			}
			setting := config.Setting{Table: table, Key: key, Value: args[1]}

			res, err := config.Set(config.WriteOptions{
				Getenv:     a.env.Getenv,
				ConfigPath: a.configPath,
			}, setting)
			if err != nil {
				// A credential is the user's mistake at the command line, so
				// it exits 2 with the command that does the right thing;
				// everything else the writer refuses is a configuration
				// problem, exit 3.
				if errors.Is(err, config.ErrSecretKey) {
					return exit.Usagef(fmt.Errorf("%w; run `tdo login` instead", err))
				}
				return exit.Configf(err)
			}

			if a.out.JSON {
				return a.out.Emit(configSetJSON(res))
			}
			for _, c := range res.Changes {
				switch {
				case !c.Changed:
					a.out.Printf("%s already set to %q in %s\n", c.Name, c.Value, res.Path)
				case c.Added:
					a.out.Printf("set %s = %q in %s (added)\n", c.Name, c.Value, res.Path)
				default:
					a.out.Printf("set %s = %q in %s (was %q)\n", c.Name, c.Value, res.Path, c.Previous)
				}
			}
			if res.Created {
				a.out.Hintf("created %s; keep it out of every git repository, and keep tokens in the OS keychain with `tdo login`.", res.Path)
			}
			return nil
		}),
	}
}

// configSetJSON is the documented shape of `tdo config set --json`.
func configSetJSON(res *config.WriteResult) map[string]any {
	changes := make([]map[string]any, 0, len(res.Changes))
	for _, c := range res.Changes {
		changes = append(changes, map[string]any{
			"key":      c.Name,
			"value":    c.Value,
			"previous": c.Previous,
			"added":    c.Added,
			"changed":  c.Changed,
		})
	}
	return map[string]any{
		"config_file": res.Path,
		"created":     res.Created,
		"wrote":       res.Wrote,
		"changes":     changes,
	}
}

// xdgConfigHint names the canonical config file in help text. config has its
// own copy for its messages; this one is the command layer's, because the
// command layer must not reach into that package for a string.
const xdgConfigHint = "~/.config/todocloud/config.toml"

// check is one line of `tdo doctor` output.
type check struct {
	Name   string `json:"name"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail"`
}

func (a *app) doctorCommand() *ucli.Command {
	return &ucli.Command{
		Name:  "doctor",
		Usage: "check the configuration and the provider, printing nothing secret",
		Action: a.action(func(ctx context.Context, cmd *ucli.Command) error {
			if cmd.Args().Len() > 0 {
				return usagef("doctor takes no arguments")
			}
			checks, state := a.diagnose(ctx)

			ok := true
			for _, c := range checks {
				if !c.OK {
					ok = false
				}
			}

			if a.out.JSON {
				report := map[string]any{"ok": ok, "checks": checks}
				// The same four keys `tdo migrate` reports, so that a
				// caller can read the schema state from either command
				// without a second shape to learn. backup_path is always
				// empty here: planning a migration takes the backup, and a
				// diagnostic must write nothing.
				report["from"] = state.From
				report["to"] = state.To
				report["backup_path"] = ""
				report["steps"] = stepNames(state.Steps)
				if err := a.out.Emit(report); err != nil {
					return err
				}
			} else {
				for _, c := range checks {
					mark := "ok  "
					if !c.OK {
						mark = "FAIL"
					}
					a.out.Printf("%s %-20s %s\n", mark, c.Name, c.Detail)
				}
			}
			if !ok {
				// The report is the output; an error envelope on top of it
				// would contradict the documented shape, so only the exit
				// code carries the failure.
				return silentError{code: exit.Error}
			}
			return nil
		}),
	}
}

// diagnose runs the checks in order and stops as soon as one makes the next
// one meaningless. Nothing it returns may contain a credential: a token is
// reported only through secret.Secret.Hint.
// schemaState is what `tdo doctor` reports about the schema: the version
// the store is at, the version this binary writes, and the steps still
// owed. It is the readable half of a store.MigrationPlan.
//
// It is computed here rather than by calling store.PlanMigration, because
// planning takes a backup — which is right for `tdo migrate` and wrong for
// a diagnostic. `tdo doctor` creates nothing, a backup file included.
type schemaState struct {
	// From is the version recorded in the store, or 0 when it could not be
	// read at all. To is the version this binary writes.
	From int
	To   int
	// Steps names the migrations `tdo migrate` would run, in order.
	Steps []string
}

// pending reports whether `tdo migrate` has work to do.
func (s schemaState) pending() bool { return s.From != s.To }

func (a *app) diagnose(ctx context.Context) ([]check, schemaState) {
	state := schemaState{To: schema.Version}
	cfg, err := a.config()
	if err != nil {
		return []check{{Name: "config", OK: false, Detail: err.Error()}}, state
	}
	// Warnings are advice, not results, so they go to stderr.
	for _, w := range cfg.Warnings {
		a.out.Warnf("%s", w)
	}

	source := cfg.Path
	if source == "" {
		source = "no config file; using defaults and the environment"
	}
	checks := []check{{Name: "config", OK: true, Detail: source}}

	if !cfg.Provider.Implemented() {
		checks = append(checks, check{
			Name:   "provider",
			OK:     false,
			Detail: fmt.Sprintf("provider %q is not implemented in this build", cfg.Provider),
		})
		return checks, state
	}
	checks = append(checks, check{
		Name:   "provider",
		OK:     true,
		Detail: fmt.Sprintf("provider %q", cfg.Provider),
	})

	credentialFailed := false
	if c, ok := credentialCheck(cfg); ok {
		checks = append(checks, c)
		credentialFailed = !c.OK
	}

	// The provider CLI check comes next, and it runs even when the credential
	// check failed: "install the turso CLI and log in" is exactly the advice a
	// user with no token needs.
	checks = append(checks, a.providerCLICheck(ctx, cfg.Provider))
	if credentialFailed {
		return checks, state
	}

	if cfg.Provider == providerSQLite {
		c := directoryCheck(cfg)
		checks = append(checks, c)
		if !c.OK {
			return checks, state
		}
	}

	st, err := a.openStore(false)
	if err != nil {
		return append(checks, check{Name: "ping", OK: false, Detail: err.Error()}), state
	}
	defer st.Close()

	if err := st.Ping(ctx); err != nil {
		detail := err.Error()
		if errors.Is(err, store.ErrNotInitialized) {
			detail = "not initialized; run `tdo init`"
		}
		return append(checks, check{Name: "ping", OK: false, Detail: detail}), state
	}
	checks = append(checks, check{Name: "ping", OK: true, Detail: st.Describe()})

	found, err := st.SchemaVersion(ctx)
	if err != nil {
		return append(checks, check{Name: "schema", OK: false, Detail: err.Error()}), state
	}
	state.From = found
	for _, step := range schema.Pending(found) {
		state.Steps = append(state.Steps, step.Name)
	}
	switch {
	case !state.pending():
		return append(checks, check{Name: "schema", OK: true,
			Detail: fmt.Sprintf("version %d; no migration pending", found)}), state
	case found < state.To:
		return append(checks, check{Name: "schema", OK: false,
			Detail: fmt.Sprintf("store is at version %d, this binary expects %d; a migration is pending, run `tdo migrate`", found, state.To)}), state
	default:
		return append(checks, check{Name: "schema", OK: false,
			Detail: fmt.Sprintf("store is at version %d, newer than this binary's %d; upgrade tdo", found, state.To)}), state
	}
}

// credentialCheck reports whether the provider's token is present, and
// nothing more about it. The second result is false for a provider that needs
// no credential.
func credentialCheck(cfg *config.Config) (check, bool) {
	switch cfg.Provider {
	case config.Provider("turso"):
		hint := cfg.Turso.Token.Hint()
		if hint == "" {
			return check{Name: "credential", OK: false, Detail: "no token; set TODOCLOUD_TURSO_TOKEN"}, true
		}
		return check{Name: "credential", OK: true, Detail: "token present " + hint}, true
	case config.Provider("d1"):
		hint := cfg.D1.Token.Hint()
		if hint == "" {
			return check{Name: "credential", OK: false, Detail: "no token; set TODOCLOUD_D1_TOKEN"}, true
		}
		return check{Name: "credential", OK: true, Detail: "token present " + hint}, true
	default:
		return check{}, false
	}
}

// providerCLICheck reports what is known about the provider's own CLI, and
// only non-secret facts: whether a binary is installed, whether a session
// exists, and where a credentials file lives. It never runs wrangler —
// CLAUDE.md §1.4 forbids it, and a wrangler OAuth token cannot be used by this
// tool anyway — and it never prints a token. A missing CLI is a failed check
// with advice, not a crash.
func (a *app) providerCLICheck(ctx context.Context, provider config.Provider) check {
	const name = "provider_cli"
	switch provider {
	case config.ProviderTurso:
		if !tursoAvailable() {
			return check{Name: name, OK: false, Detail: "the turso CLI is not installed; install it and run `turso auth login`, or set TODOCLOUD_TURSO_TOKEN yourself"}
		}
		loggedIn, err := tursoLoggedIn(ctx)
		if err != nil {
			return check{Name: name, OK: false, Detail: "the turso CLI is installed but could not be asked about its session: " + err.Error()}
		}
		if !loggedIn {
			return check{Name: name, OK: false, Detail: "the turso CLI is installed but not logged in; run `turso auth login`"}
		}
		return check{Name: name, OK: true, Detail: "the turso CLI is installed and logged in"}
	case config.ProviderD1:
		return check{Name: name, OK: true, Detail: "no provider CLI is involved; D1 uses the API token from TODOCLOUD_D1_TOKEN"}
	default:
		return check{Name: name, OK: true, Detail: "no provider CLI is involved; local SQLite is a file on your disk"}
	}
}

// directoryCheck confirms the database file's directory can be written to,
// which is the failure a local user actually hits.
//
// It creates nothing. `tdo doctor` is a diagnostic, and a diagnostic that
// leaves directories behind is how a mistyped path quietly becomes real — so
// when the directory does not exist yet, the nearest existing ancestor is
// probed instead and the check says `tdo init` would create the rest.
func directoryCheck(cfg *config.Config) check {
	const name = "database_directory"
	path, err := config.ExpandPath(cfg.SQLite.Path)
	if err != nil {
		return check{Name: name, OK: false, Detail: err.Error()}
	}
	if path == ":memory:" {
		return check{Name: name, OK: true, Detail: "in-memory database"}
	}

	dir := filepath.Dir(path)
	existing, missing := nearestExistingDir(dir)
	if existing == "" {
		return check{Name: name, OK: false, Detail: fmt.Sprintf("no existing directory above %s", dir)}
	}

	probe, err := os.CreateTemp(existing, ".tdo-write-check-*")
	if err != nil {
		return check{Name: name, OK: false, Detail: fmt.Sprintf("%s is not writable: %v", existing, err)}
	}
	probe.Close()
	os.Remove(probe.Name())

	if missing {
		return check{Name: name, OK: true, Detail: fmt.Sprintf("%s is writable; `tdo init` will create %s", existing, dir)}
	}
	return check{Name: name, OK: true, Detail: dir + " is writable"}
}

// nearestExistingDir walks up from dir to the first directory that exists,
// reporting whether anything below it is missing. It returns an empty string
// when it runs out of ancestors, which means the path is not usable at all.
func nearestExistingDir(dir string) (existing string, missing bool) {
	for current := dir; ; {
		info, err := os.Stat(current)
		if err == nil && info.IsDir() {
			return current, current != dir
		}
		parent := filepath.Dir(current)
		if parent == current {
			return "", true
		}
		current = parent
	}
}
