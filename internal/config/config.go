// Package config resolves the CLI's configuration and credentials.
//
// Values come from, highest priority first: environment variables, the file
// named by $TODOCLOUD_CONFIG, $XDG_CONFIG_HOME/todocloud/config.toml (default
// ~/.config/todocloud/config.toml), and finally built-in defaults. A missing
// file at the default location is not an error; a missing file the user asked
// for by name is.
//
// Credential handling rules this package exists to enforce:
//
//   - A token is resolved from, highest priority first: the environment
//     variable, the OS keychain, and finally the config file — but a file
//     token is loaded only when every guard in resolveToken holds: the file is
//     outside any git repository, it is the XDG config file or the one named
//     by $TODOCLOUD_CONFIG, and it is not group- or world-readable. A refused
//     token is not loaded, is not retained, and raises a loud warning that
//     names the file, the key, the reason and the alternatives; no warning
//     ever contains the value.
//   - Every other secret-shaped key (api_token, secret, password, key) is
//     never loaded: there is exactly one supported spelling, so a near miss is
//     reported rather than silently ignored.
//   - Every token is held in secret.Secret, so no format verb, no JSON
//     encoding and no error message built here can disclose it.
//   - No API in this package accepts a token as a plain string from the
//     command line; there is no flag that carries a secret.
package config

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/soya-miyoshi/todocloud/internal/exit"
	"github.com/soya-miyoshi/todocloud/internal/keyring"
	"github.com/soya-miyoshi/todocloud/internal/secret"
)

// Provider names a storage backend.
type Provider string

// The known providers, in roadmap order.
const (
	ProviderSQLite Provider = "sqlite"
	ProviderTurso  Provider = "turso"
	// ProviderFirestore is recognised but not offered. A Firestore provider
	// was built and then removed (PLAN.md §2); keeping the name means a
	// config file that still says "firestore" gets told what happened
	// instead of "unknown provider".
	ProviderFirestore Provider = "firestore"
	ProviderD1        Provider = "d1"
)

// Environment variable names. Tokens appear here and nowhere else.
const (
	EnvConfig       = "TODOCLOUD_CONFIG"
	EnvProvider     = "TODOCLOUD_PROVIDER"
	EnvSQLitePath   = "TODOCLOUD_SQLITE_PATH"
	EnvTursoURL     = "TODOCLOUD_TURSO_URL"
	EnvTursoToken   = "TODOCLOUD_TURSO_TOKEN"
	EnvD1AccountID  = "TODOCLOUD_D1_ACCOUNT_ID"
	EnvD1DatabaseID = "TODOCLOUD_D1_DATABASE_ID"
	EnvD1Token      = "TODOCLOUD_D1_TOKEN"

	envXDGConfigHome = "XDG_CONFIG_HOME"
	envXDGDataHome   = "XDG_DATA_HOME"
	envHome          = "HOME"
)

// Providers returns every known provider name, in roadmap order.
func Providers() []Provider {
	return []Provider{ProviderSQLite, ProviderTurso, ProviderFirestore, ProviderD1}
}

// Known reports whether p is one of the names in Providers.
func (p Provider) Known() bool {
	for _, q := range Providers() {
		if p == q {
			return true
		}
	}
	return false
}

// Implemented reports whether this binary can actually talk to p. In v0.1 only
// sqlite is implemented; the remaining providers are accepted as names so that
// the error can say which version they ship in.
func (p Provider) Implemented() bool {
	return p == ProviderSQLite || p == ProviderTurso
}

// String implements fmt.Stringer.
func (p Provider) String() string { return string(p) }

// SQLiteConfig configures the local SQLite provider.
type SQLiteConfig struct{ Path string }

// TursoConfig configures the Turso/libSQL provider.
type TursoConfig struct {
	URL   string
	Token secret.Secret
}

// D1Config configures the Cloudflare D1 provider.
type D1Config struct {
	AccountID  string
	DatabaseID string
	Token      secret.Secret
}

// Config is the resolved configuration.
type Config struct {
	Provider Provider
	SQLite   SQLiteConfig
	Turso    TursoConfig
	D1       D1Config

	// Path is the config file that was read, or "" when none was found.
	Path string
	// Origins records where each resolved value came from, keyed by a dotted
	// setting name such as "provider" or "turso.url", with values like
	// "env:TODOCLOUD_PROVIDER", "keyring:keychain",
	// "file:/path/to/config.toml" or "default". A refused file token is never
	// recorded here: an absent token has no origin at all.
	Origins map[string]string
	// fileProvider is what the config file named, whether or not it won.
	fileProvider Provider

	// Warnings holds credential-hygiene problems worth telling the user about
	// (a group- or world-readable config file, a config file inside a git
	// repository, a refused or unsupported credential key, a keychain lookup
	// that failed). They are printed to stderr, never to stdout, and never
	// contain a credential value.
	Warnings []string
}

// Options controls Load.
type Options struct {
	// Getenv defaults to os.Getenv. Tests inject a fake environment.
	Getenv func(string) string
	// ConfigPath overrides the whole config-file search when non-empty. A
	// token in a file reached this way is not loaded: see resolveToken.
	ConfigPath string
	// Keyring looks a token up in the OS keychain by account name. It reports
	// ok=false when there is simply no entry, which is not an error. It
	// defaults to keyringLookup, a thin wrapper over keyring.Get with a short
	// timeout; tests inject a fake so that no test touches a real keychain.
	Keyring func(account string) (secret.Secret, bool, error)
}

// tokenKeyNames are the config-file keys that are assumed to hold a
// credential. Only "token", under a provider table that has one, is ever
// loaded; every other spelling is reported and dropped.
var tokenKeyNames = []string{"token", "api_token", "secret", "password", "key"}

// fileTokenKey is the one supported spelling of a token in the config file.
const fileTokenKey = "token"

// keyringTimeout bounds the OS keychain lookup. A local keychain answers in
// milliseconds; the timeout exists so that a hung helper process cannot wedge
// every command.
const keyringTimeout = 2 * time.Second

// Load resolves the configuration from the environment, the config file and
// the built-in defaults, in that order of priority.
func Load(opts Options) (*Config, error) {
	getenv := opts.Getenv
	if getenv == nil {
		getenv = os.Getenv
	}

	lookup := opts.Keyring
	if lookup == nil {
		lookup = defaultKeyring
	}

	cfg := &Config{Origins: map[string]string{}}

	path, mustExist, err := configFilePath(opts, getenv)
	if err != nil {
		return nil, err
	}

	var file *tomlFile
	if path != "" {
		file, err = readConfigFile(cfg, path, mustExist)
		if err != nil {
			return nil, err
		}
	}
	if file == nil {
		file = &tomlFile{}
	}

	guard := fileTokenGuard(cfg.Path, fileTokenPathAllowed(getenv, cfg.Path))

	// provider: env, then file, then the built-in default. The file's own
	// answer is kept either way, so a caller can tell an environment variable
	// that agrees with the file from one that overrides it — writing to a
	// store the config file does not name is worth saying out loud.
	if v, ok := file.string("", "provider"); ok {
		cfg.fileProvider = Provider(v)
	}
	switch {
	case getenv(EnvProvider) != "":
		cfg.Provider = Provider(getenv(EnvProvider))
		cfg.Origins["provider"] = "env:" + EnvProvider
	default:
		if cfg.fileProvider != "" {
			cfg.Provider = cfg.fileProvider
			cfg.Origins["provider"] = "file:" + cfg.Path
		} else {
			cfg.Provider = ProviderSQLite
			cfg.Origins["provider"] = "default"
		}
	}

	// sqlite.path always resolves, because there is a default.
	if v, origin := resolve(getenv, file, EnvSQLitePath, "sqlite", "path", cfg.Path); v != "" {
		cfg.SQLite.Path = v
		cfg.Origins["sqlite.path"] = origin
	} else {
		cfg.SQLite.Path = defaultSQLitePath(getenv)
		cfg.Origins["sqlite.path"] = "default"
	}

	if v, origin := resolve(getenv, file, EnvTursoURL, "turso", "url", cfg.Path); v != "" {
		cfg.Turso.URL = v
		cfg.Origins["turso.url"] = origin
	}
	if v, origin := resolve(getenv, file, EnvD1AccountID, "d1", "account_id", cfg.Path); v != "" {
		cfg.D1.AccountID = v
		cfg.Origins["d1.account_id"] = origin
	}
	if v, origin := resolve(getenv, file, EnvD1DatabaseID, "d1", "database_id", cfg.Path); v != "" {
		cfg.D1.DatabaseID = v
		cfg.Origins["d1.database_id"] = origin
	}

	// Tokens: the environment, then the OS keychain, then the config file if
	// every guard holds. Firestore has no token: its credentials are a file
	// path, so it is deliberately absent from this list.
	cfg.Turso.Token = resolveToken(cfg, getenv, lookup, file, guard, tokenRequest{
		name:    "turso.token",
		env:     EnvTursoToken,
		account: keyring.AccountTursoToken,
		table:   string(ProviderTurso),
	})
	cfg.D1.Token = resolveToken(cfg, getenv, lookup, file, guard, tokenRequest{
		name:    "d1.token",
		env:     EnvD1Token,
		account: keyring.AccountD1Token,
		table:   string(ProviderD1),
	})

	return cfg, nil
}

// tokenRequest describes one provider token: where it may come from and what
// it is called in each of those places.
type tokenRequest struct {
	// name is the dotted setting name used in Origins, e.g. "turso.token".
	name string
	// env is the environment variable that holds it.
	env string
	// account is the OS keychain account that holds it.
	account string
	// table is the config-file table it may appear in, under the key "token".
	table string
}

// tokenGuard carries the verdict on loading a token from the config file: the
// file either qualifies, or reason says in one sentence why it does not.
type tokenGuard struct {
	allowed bool
	reason  string
}

// xdgConfigHint names the canonical config file in advice to the user. The
// resolved path is environment-dependent, so a message that must read well
// everywhere uses this instead.
const xdgConfigHint = "~/.config/todocloud/config.toml"

// fileTokenGuard decides whether path may supply a token at all, independently
// of which provider asked. All three guards are about the file, not the value:
//
//  1. a file inside a git repository is one `git add -A` away from being
//     published, which is the whole reason tokens were kept out of files;
//  2. only the XDG config file and $TODOCLOUD_CONFIG qualify, because an
//     arbitrary --config path is too easily a repository-relative one;
//  3. a group- or world-readable file is not a safe place for a credential —
//     which only a platform with POSIX file modes can be asked; see
//     fileTokenModeGuard.
func fileTokenGuard(path string, pathAllowed bool) tokenGuard {
	if path == "" {
		return tokenGuard{}
	}
	if dir, ok := repositoryRoot(path); ok {
		return tokenGuard{reason: fmt.Sprintf(
			"the file is inside the git repository at %s, and a config file that holds a token must NEVER sit in a repository: one `git add -A`, one pushed dotfiles repo, and the token is public forever. Move it to %s, outside every repository, with mode 600, and treat this token as exposed — rotate it now.",
			dir, xdgConfigHint)}
	}
	if !pathAllowed {
		return tokenGuard{reason: fmt.Sprintf(
			"a token is read only from %s or the file named by $%s, and this file is neither; an arbitrary --config path is too easily one inside a repository.",
			xdgConfigHint, EnvConfig)}
	}
	return fileTokenModeGuard(path)
}

// resolveToken applies the token precedence for one provider: the environment
// variable, the OS keychain, then the config file subject to guard. A value
// that is not used is not retained, and no warning raised here can contain it.
func resolveToken(cfg *Config, getenv func(string) string, lookup func(string) (secret.Secret, bool, error), file *tomlFile, guard tokenGuard, req tokenRequest) secret.Secret {
	entry, inFile := file.lookup(req.table, fileTokenKey)
	if inFile && entry.kind != kindString {
		inFile = false
	}

	// 1. the environment. The keychain is not consulted at all in this case.
	if v := getenv(req.env); v != "" {
		cfg.Origins[req.name] = "env:" + req.env
		if inFile && !guard.allowed {
			warnRefusedFileToken(cfg, req, entry.line, guard.reason)
		}
		return secret.New(v)
	}

	// 2. the OS keychain, for the selected provider only: looking a token up
	// for a provider this command will not talk to would spend a keychain
	// round trip, and possibly an unlock prompt, on nothing. A failure other
	// than "no entry" is not fatal: it falls through to the config file with a
	// warning that names the backend.
	if lookup != nil && Provider(req.table) == cfg.Provider {
		switch v, ok, err := lookup(req.account); {
		case err != nil:
			cfg.Warnings = append(cfg.Warnings, fmt.Sprintf(
				"WARNING: looking %s up in the OS keychain (backend %s, account %s) failed: %v. Falling back to the config file; set %s in the environment to skip the keychain entirely.",
				req.name, keyring.Backend(), req.account, err, req.env))
		case ok && !v.Empty():
			cfg.Origins[req.name] = "keyring:" + keyring.Backend()
			if inFile && !guard.allowed {
				warnRefusedFileToken(cfg, req, entry.line, guard.reason)
			}
			return v
		}
	}

	// 3. the config file, guarded.
	if !inFile {
		return secret.Secret{}
	}
	if !guard.allowed {
		warnRefusedFileToken(cfg, req, entry.line, guard.reason)
		return secret.Secret{}
	}
	cfg.Origins[req.name] = "file:" + cfg.Path
	return secret.New(entry.str)
}

// warnRefusedFileToken records why a file token was not used and what to do
// instead. The value is never read into the message.
func warnRefusedFileToken(cfg *Config, req tokenRequest, line int, reason string) {
	cfg.Warnings = append(cfg.Warnings, fmt.Sprintf(
		"WARNING: config file %s line %d sets %s, which holds a credential. "+
			"The value was NOT loaded: %s "+
			"Set %s in the environment instead, or run `tdo login`, which stores the token in the OS keychain.",
		cfg.Path, line, req.name, reason, req.env))
}

// defaultKeyring is what Load uses when Options.Keyring is nil. It is a
// variable so that the package's own tests can point it at a fake and no test
// can reach a real keychain by forgetting to set the option.
var defaultKeyring = keyringLookup

// keyringLookup is the default Options.Keyring: keyring.Get with a short
// timeout, so that Load needs neither a context nor a working keychain.
func keyringLookup(account string) (secret.Secret, bool, error) {
	if !keyring.Available() {
		return secret.Secret{}, false, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), keyringTimeout)
	defer cancel()
	v, ok, err := keyring.Get(ctx, account)
	if errors.Is(err, keyring.ErrUnavailable) {
		// No keychain on this machine is an absence, not a failure.
		return secret.Secret{}, false, nil
	}
	return v, ok, err
}

// resolve returns the value of a non-secret setting from the environment or
// the config file, with the origin string that describes where it came from.
func resolve(getenv func(string) string, file *tomlFile, env, table, key, path string) (string, string) {
	if v := getenv(env); v != "" {
		return v, "env:" + env
	}
	if v, ok := file.string(table, key); ok && v != "" {
		return v, "file:" + path
	}
	return "", ""
}

// configFilePath decides which file to read. mustExist is true when the user
// named the file explicitly, in which case a missing file is an error.
func configFilePath(opts Options, getenv func(string) string) (path string, mustExist bool, err error) {
	if opts.ConfigPath != "" {
		return opts.ConfigPath, true, nil
	}
	if v := getenv(EnvConfig); v != "" {
		return v, true, nil
	}
	// Without a home directory there is simply no default file to read; the
	// built-in defaults still apply.
	path, ok := xdgConfigPath(getenv)
	if !ok {
		return "", false, nil
	}
	return path, false, nil
}

// xdgConfigPath returns the canonical config file path, honouring
// XDG_CONFIG_HOME and falling back to ~/.config, and whether it could be
// determined at all.
func xdgConfigPath(getenv func(string) string) (string, bool) {
	dir := getenv(envXDGConfigHome)
	if dir == "" {
		home, err := homeDir(getenv)
		if err != nil {
			return "", false
		}
		dir = filepath.Join(home, ".config")
	}
	return filepath.Join(dir, "todocloud", "config.toml"), true
}

// readConfigFile reads and parses path, recording it on cfg along with any
// credential-hygiene warnings it raises.
func readConfigFile(cfg *Config, path string, mustExist bool) (*tomlFile, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			if mustExist {
				return nil, exit.Configf(fmt.Errorf("config file %s does not exist", path))
			}
			return nil, nil
		}
		return nil, exit.Configf(fmt.Errorf("reading config file %s: %w", path, err))
	}

	file, err := parseTOML(string(data))
	if err != nil {
		return nil, exit.Configf(fmt.Errorf("config file %s: %w", path, err))
	}
	cfg.Path = path

	// The mode and in-a-repository checks are not warnings in their own right:
	// a tokenless config file is not a credential at rest, and warning about
	// one on every invocation is noise on stderr. They feed fileTokenGuard,
	// which refuses a token in such a file and says why.
	checkTokenKeys(cfg, file, path)

	return file, nil
}

// repositoryRoot returns the directory of the git repository path sits in, if
// any. It walks upwards looking for a .git entry, which catches both a normal
// repository and a worktree's .git file.
func repositoryRoot(path string) (string, bool) {
	dir := filepath.Dir(path)
	for {
		if _, err := os.Lstat(filepath.Join(dir, ".git")); err == nil {
			return dir, true
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", false
		}
		dir = parent
	}
}

// fileTokenPathAllowed reports whether path is one of the two locations a
// token may be read from: the XDG config file, or the file named by
// $TODOCLOUD_CONFIG.
func fileTokenPathAllowed(getenv func(string) string, path string) bool {
	if path == "" {
		return false
	}
	if v := getenv(EnvConfig); v != "" && samePath(v, path) {
		return true
	}
	if def, ok := xdgConfigPath(getenv); ok && samePath(def, path) {
		return true
	}
	return false
}

// samePath compares two paths for the purposes of the token guard: by cleaned
// name first, then by identity on disk, so that a symlinked temporary
// directory or a trailing slash does not defeat the check.
func samePath(a, b string) bool {
	if filepath.Clean(a) == filepath.Clean(b) {
		return true
	}
	ai, err := os.Stat(a)
	if err != nil {
		return false
	}
	bi, err := os.Stat(b)
	if err != nil {
		return false
	}
	return os.SameFile(ai, bi)
}

// checkTokenKeys warns about config-file keys that look like credentials. The
// value is not loaded and never appears in the warning.
func checkTokenKeys(cfg *Config, file *tomlFile, path string) {
	for _, e := range file.entries {
		if !isTokenKey(e.key) {
			continue
		}
		if e.key == fileTokenKey && providerHasToken(Provider(e.table)) {
			// The one supported spelling, under a provider that has a token:
			// resolveToken either loads it or refuses it with its own warning.
			continue
		}
		name := e.key
		if e.table != "" {
			name = e.table + "." + e.key
		}
		env := tokenEnvHint(e.table)
		cfg.Warnings = append(cfg.Warnings, fmt.Sprintf(
			"WARNING: config file %s line %d sets %q, which looks like a credential. "+
				"The value was NOT loaded: there is exactly one supported spelling, %q under [turso] or [d1]. "+
				"Set %s in the environment, or run `tdo login` to store the token in the OS keychain, then delete the line — "+
				"the file may now hold a credential at rest, so treat that credential as exposed and consider rotating it.",
			path, e.value.line, name, fileTokenKey, env))
	}
}

// providerHasToken reports whether p takes a bearer token.
func providerHasToken(p Provider) bool {
	return p == ProviderTurso || p == ProviderD1
}

// isTokenKey reports whether key is one of the names assumed to hold a secret.
func isTokenKey(key string) bool {
	k := strings.ToLower(key)
	for _, name := range tokenKeyNames {
		if k == name {
			return true
		}
	}
	return false
}

// tokenEnvHint names the environment variable a token in the given table
// belongs in.
func tokenEnvHint(table string) string {
	switch Provider(table) {
	case ProviderTurso:
		return EnvTursoToken
	case ProviderD1:
		return EnvD1Token
	default:
		return "an environment variable"
	}
}

// FileProvider returns the provider the config file named, and false when the
// file named none. It is how the command layer tells an override apart from an
// environment variable that merely restates the configured provider.
func (c *Config) FileProvider() (Provider, bool) {
	return c.fileProvider, c.fileProvider != ""
}

// Validate checks that the selected provider has everything it needs, and
// returns an exit.Configf error naming the missing environment variable when
// it does not.
func (c *Config) Validate() error {
	if !c.Provider.Known() {
		return exit.Configf(fmt.Errorf("unknown provider %q; valid providers are %s (set %s or provider in the config file)",
			string(c.Provider), providerList(), EnvProvider))
	}
	if !c.Provider.Implemented() {
		// Two different answers, because telling someone to wait for
		// something that is never coming is worse than saying so.
		if c.Provider == ProviderFirestore {
			return exit.Configf(fmt.Errorf("provider %q was removed and is not coming back — see docs/providers.md for why. Move your tasks with `tdo export` on the old store and `tdo import` on a %q or %q one",
				string(c.Provider), string(ProviderSQLite), string(ProviderTurso)))
		}
		return exit.Configf(fmt.Errorf("provider %q is not implemented in this build; it ships in a later version — see docs/providers.md for the roadmap. Use %q or %q for now",
			string(c.Provider), string(ProviderSQLite), string(ProviderTurso)))
	}

	return c.validateProvider()
}

// validateProvider checks the values the selected provider needs, without the
// known/implemented checks Validate makes first. It is separate so that the
// per-value rules of the providers that have not shipped yet are still
// reachable, and testable, before they are wired up.
func (c *Config) validateProvider() error {
	switch c.Provider {
	case ProviderSQLite:
		// A path is always available, because there is a default; it can only
		// fail when it cannot be made absolute.
		path, err := ExpandPath(c.SQLite.Path)
		if err != nil {
			return exit.Configf(fmt.Errorf("sqlite path %q cannot be resolved (set %s): %w", c.SQLite.Path, EnvSQLitePath, err))
		}
		c.SQLite.Path = path
	case ProviderTurso:
		if c.Turso.URL == "" {
			return exit.Configf(fmt.Errorf("provider turso needs a database URL: set %s (or turso.url in the config file)", EnvTursoURL))
		}
		if c.Turso.Token.Empty() {
			return exit.Configf(fmt.Errorf("provider turso needs an auth token: set %s, or run `tdo login` to store it in the OS keychain (a token in the config file is read only from %s, mode 600, outside any git repository)", EnvTursoToken, xdgConfigHint))
		}
	case ProviderD1:
		if c.D1.AccountID == "" {
			return exit.Configf(fmt.Errorf("provider d1 needs an account id: set %s (or d1.account_id in the config file)", EnvD1AccountID))
		}
		if c.D1.DatabaseID == "" {
			return exit.Configf(fmt.Errorf("provider d1 needs a database id: set %s (or d1.database_id in the config file)", EnvD1DatabaseID))
		}
		if c.D1.Token.Empty() {
			return exit.Configf(fmt.Errorf("provider d1 needs an API token: set %s, or run `tdo login` to store it in the OS keychain (a token in the config file is read only from %s, mode 600, outside any git repository)", EnvD1Token, xdgConfigHint))
		}
	}
	return nil
}

// providerList renders the valid provider names for an error message.
func providerList() string {
	names := make([]string, 0, len(Providers()))
	for _, p := range Providers() {
		names = append(names, string(p))
	}
	return strings.Join(names, ", ")
}

// Describe returns a fully redacted view for `tdo config --json`. Token values
// appear only as secret.Secret's hint, never as the value.
func (c *Config) Describe() map[string]any {
	origins := make(map[string]any, len(c.Origins))
	for k, v := range c.Origins {
		origins[k] = v
	}

	warnings := c.Warnings
	if warnings == nil {
		warnings = []string{}
	}

	keys := make([]string, 0, len(c.Origins))
	for k := range c.Origins {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	return map[string]any{
		"provider":    string(c.Provider),
		"implemented": c.Provider.Implemented(),
		"config_file": c.Path,
		"sqlite": map[string]any{
			"path": c.SQLite.Path,
		},
		"turso": map[string]any{
			"url":           c.Turso.URL,
			"token":         c.Turso.Token.Hint(),
			"token_present": !c.Turso.Token.Empty(),
			"token_origin":  c.Origins["turso.token"],
		},
		"d1": map[string]any{
			"account_id":    c.D1.AccountID,
			"database_id":   c.D1.DatabaseID,
			"token":         c.D1.Token.Hint(),
			"token_present": !c.D1.Token.Empty(),
			"token_origin":  c.Origins["d1.token"],
		},
		"keyring": map[string]any{
			"backend":   keyring.Backend(),
			"available": keyring.Available(),
		},
		"origins":      origins,
		"origin_order": keys,
		"warnings":     warnings,
	}
}

// DefaultSQLitePath returns the default local database path, honouring
// XDG_DATA_HOME and falling back to ~/.local/share/todocloud/tasks.db.
func DefaultSQLitePath() string {
	return defaultSQLitePath(os.Getenv)
}

// defaultSQLitePath is DefaultSQLitePath with an injectable environment.
func defaultSQLitePath(getenv func(string) string) string {
	dir := getenv(envXDGDataHome)
	if dir == "" {
		home, err := homeDir(getenv)
		if err != nil {
			// Last resort: a relative path in the working directory. Validate
			// turns it into an absolute one.
			return filepath.Join("todocloud", "tasks.db")
		}
		dir = filepath.Join(home, ".local", "share")
	}
	return filepath.Join(dir, "todocloud", "tasks.db")
}

// ExpandPath expands a leading "~" and returns an absolute path.
func ExpandPath(path string) (string, error) {
	if path == "" {
		return "", errors.New("empty path")
	}
	if path == "~" || strings.HasPrefix(path, "~/") {
		home, err := homeDir(os.Getenv)
		if err != nil {
			return "", err
		}
		path = filepath.Join(home, strings.TrimPrefix(strings.TrimPrefix(path, "~"), "/"))
	} else if strings.HasPrefix(path, "~") {
		return "", fmt.Errorf("cannot expand %q: ~user paths are not supported", path)
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	return abs, nil
}

// homeDir returns the user's home directory, preferring HOME so that a test
// can point it at a temporary directory.
func homeDir(getenv func(string) string) (string, error) {
	if h := getenv(envHome); h != "" {
		return h, nil
	}
	h, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("cannot determine the home directory: %w", err)
	}
	return h, nil
}
