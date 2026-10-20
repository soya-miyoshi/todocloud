package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/soya-miyoshi/todocloud/internal/exit"
	"github.com/soya-miyoshi/todocloud/internal/keyring"
	"github.com/soya-miyoshi/todocloud/internal/secret"
)

// fakeToken is an obviously fake credential. No test in this repository may
// use anything that could be a real one.
const fakeToken = "TOKEN_GOES_HERE"

// fakeEnv returns a Getenv that reads only from the given map, so that no test
// can see the real environment.
func fakeEnv(vars map[string]string) func(string) string {
	return func(name string) string { return vars[name] }
}

// writeFile writes a config file into dir and returns its path.
func writeFile(t *testing.T, dir, body string) string {
	t.Helper()
	path := filepath.Join(dir, "config.toml")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("writing %s: %v", path, err)
	}
	return path
}

// tokenFile is a config file whose [turso] table carries the one supported
// token spelling. The value is obviously fake.
var tokenFile = fmt.Sprintf(`provider = "turso"

[turso]
url = "libsql://example.turso.io"
token = %q
`, fakeToken)

// writeXDGConfig writes body to the canonical XDG config path under a fresh
// home directory, and returns the home directory and the file path.
func writeXDGConfig(t *testing.T, body string) (home, path string) {
	t.Helper()
	home = t.TempDir()
	dir := filepath.Join(home, ".config", "todocloud")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	return home, writeFile(t, dir, body)
}

// requireFileTokens skips a test whose premise is that a token in the config
// file is loaded. On a platform without POSIX file modes that never happens
// by design — see fileTokenModeGuard — and the refusal has its own test in
// TestLoadRefusesEveryFileTokenWithoutPOSIXModes.
func requireFileTokens(t *testing.T) {
	t.Helper()
	if !FileTokensSupported {
		t.Skipf("a token in a config file is not read on %s", runtime.GOOS)
	}
}

// TestLoadRefusesEveryFileTokenWithoutPOSIXModes is the other half of
// requireFileTokens: where a file token is not supported, the canonical path
// at the strictest mode the platform can set is still refused, and the
// warning sends the user to the environment or the keychain.
func TestLoadRefusesEveryFileTokenWithoutPOSIXModes(t *testing.T) {
	if FileTokensSupported {
		t.Skipf("a token in a config file is read on %s", runtime.GOOS)
	}
	home, path := writeXDGConfig(t, tokenFile)

	cfg, err := Load(Options{
		Getenv:  fakeEnv(map[string]string{"HOME": home}),
		Keyring: noKeyring,
	})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !cfg.Turso.Token.Empty() {
		t.Error("a token was loaded from a config file on a platform without POSIX modes")
	}
	if _, ok := cfg.Origins["turso.token"]; ok {
		t.Error("a refused token was recorded in Origins")
	}
	if len(cfg.Warnings) != 1 {
		t.Fatalf("Warnings = %v, want exactly one", cfg.Warnings)
	}
	for _, want := range []string{path, runtime.GOOS, EnvTursoToken, "tdo login"} {
		if !strings.Contains(cfg.Warnings[0], want) {
			t.Errorf("warning %q does not mention %q", cfg.Warnings[0], want)
		}
	}
	assertNoWarningLeaksTheToken(t, cfg)
}

// TestMain points the package's default keychain lookup at a fake, so that no
// test in this file can reach the real OS keychain even by omitting
// Options.Keyring.
func TestMain(m *testing.M) {
	defaultKeyring = noKeyring
	os.Exit(m.Run())
}

// noKeyring is an Options.Keyring that reports no entry for every account, so
// that a test never reaches a real keychain.
func noKeyring(string) (secret.Secret, bool, error) {
	return secret.Secret{}, false, nil
}

// recordingKeyring returns a Keyring serving the given accounts, and a pointer
// to the list of accounts it was asked for.
func recordingKeyring(entries map[string]string) (func(string) (secret.Secret, bool, error), *[]string) {
	asked := &[]string{}
	return func(account string) (secret.Secret, bool, error) {
		*asked = append(*asked, account)
		v, ok := entries[account]
		if !ok {
			return secret.Secret{}, false, nil
		}
		return secret.New(v), true, nil
	}, asked
}

const exampleFile = `provider = "turso"

[sqlite]
path = "/data/tasks.db"

[turso]
url = "libsql://example.turso.io"

[d1]
account_id = "00000000-0000-0000-0000-000000000000"
database_id = "00000000-0000-0000-0000-000000000000"
`

func TestLoadDefaultsOnly(t *testing.T) {
	home := t.TempDir()
	cfg, err := Load(Options{Getenv: fakeEnv(map[string]string{
		"HOME":            home,
		"XDG_CONFIG_HOME": filepath.Join(home, ".config"),
	})})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Provider != ProviderSQLite {
		t.Errorf("Provider = %q, want sqlite", cfg.Provider)
	}
	if cfg.Path != "" {
		t.Errorf("Path = %q, want empty when no config file exists", cfg.Path)
	}
	wantPath := filepath.Join(home, ".local", "share", "todocloud", "tasks.db")
	if cfg.SQLite.Path != wantPath {
		t.Errorf("SQLite.Path = %q, want %q", cfg.SQLite.Path, wantPath)
	}
	if got := cfg.Origins["provider"]; got != "default" {
		t.Errorf(`Origins["provider"] = %q, want "default"`, got)
	}
	if got := cfg.Origins["sqlite.path"]; got != "default" {
		t.Errorf(`Origins["sqlite.path"] = %q, want "default"`, got)
	}
	if len(cfg.Warnings) != 0 {
		t.Errorf("Warnings = %v, want none", cfg.Warnings)
	}
}

func TestLoadMissingDefaultFileIsNotAnError(t *testing.T) {
	home := t.TempDir()
	if _, err := Load(Options{Getenv: fakeEnv(map[string]string{"HOME": home})}); err != nil {
		t.Fatalf("Load: %v", err)
	}
}

func TestLoadXDGDataHomeHonoured(t *testing.T) {
	home := t.TempDir()
	data := filepath.Join(home, "data")
	cfg, err := Load(Options{Getenv: fakeEnv(map[string]string{
		"HOME":          home,
		"XDG_DATA_HOME": data,
	})})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	want := filepath.Join(data, "todocloud", "tasks.db")
	if cfg.SQLite.Path != want {
		t.Errorf("SQLite.Path = %q, want %q", cfg.SQLite.Path, want)
	}
}

func TestLoadUsesFileWhenEnvIsAbsent(t *testing.T) {
	dir := t.TempDir()
	path := writeFile(t, dir, exampleFile)

	cfg, err := Load(Options{
		Getenv:     fakeEnv(map[string]string{"HOME": dir}),
		ConfigPath: path,
	})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Path != path {
		t.Errorf("Path = %q, want %q", cfg.Path, path)
	}
	if cfg.Provider != ProviderTurso {
		t.Errorf("Provider = %q, want turso", cfg.Provider)
	}
	if cfg.SQLite.Path != "/data/tasks.db" {
		t.Errorf("SQLite.Path = %q, want /data/tasks.db", cfg.SQLite.Path)
	}
	if cfg.Turso.URL != "libsql://example.turso.io" {
		t.Errorf("Turso.URL = %q", cfg.Turso.URL)
	}
	if cfg.D1.AccountID == "" || cfg.D1.DatabaseID == "" {
		t.Errorf("D1 ids not loaded: %+v", cfg.D1)
	}

	fileOrigin := "file:" + path
	for _, key := range []string{"provider", "sqlite.path", "turso.url", "d1.account_id", "d1.database_id"} {
		if got := cfg.Origins[key]; got != fileOrigin {
			t.Errorf("Origins[%q] = %q, want %q", key, got, fileOrigin)
		}
	}
	// No token was in the environment, so no token origin is recorded.
	if _, ok := cfg.Origins["turso.token"]; ok {
		t.Errorf("Origins has a turso.token entry without a token in the environment")
	}
	if !cfg.Turso.Token.Empty() {
		t.Error("Turso.Token is set although no token was in the environment")
	}
}

func TestLoadEnvOverridesFile(t *testing.T) {
	dir := t.TempDir()
	path := writeFile(t, dir, exampleFile)

	cfg, err := Load(Options{
		Getenv: fakeEnv(map[string]string{
			"HOME":          dir,
			EnvProvider:     "d1",
			EnvSQLitePath:   "/env/tasks.db",
			EnvTursoURL:     "libsql://env.example.turso.io",
			EnvTursoToken:   fakeToken,
			EnvD1AccountID:  "11111111-1111-1111-1111-111111111111",
			EnvD1DatabaseID: "22222222-2222-2222-2222-222222222222",
			EnvD1Token:      fakeToken,
		}),
		ConfigPath: path,
	})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if cfg.Provider != ProviderD1 {
		t.Errorf("Provider = %q, want d1", cfg.Provider)
	}
	if cfg.SQLite.Path != "/env/tasks.db" {
		t.Errorf("SQLite.Path = %q", cfg.SQLite.Path)
	}
	if cfg.Turso.URL != "libsql://env.example.turso.io" {
		t.Errorf("Turso.URL = %q", cfg.Turso.URL)
	}
	if cfg.D1.Token.Reveal() != fakeToken {
		t.Error("D1.Token was not read from the environment")
	}

	want := map[string]string{
		"provider":       "env:" + EnvProvider,
		"sqlite.path":    "env:" + EnvSQLitePath,
		"turso.url":      "env:" + EnvTursoURL,
		"turso.token":    "env:" + EnvTursoToken,
		"d1.account_id":  "env:" + EnvD1AccountID,
		"d1.database_id": "env:" + EnvD1DatabaseID,
		"d1.token":       "env:" + EnvD1Token,
	}
	for key, origin := range want {
		if got := cfg.Origins[key]; got != origin {
			t.Errorf("Origins[%q] = %q, want %q", key, got, origin)
		}
	}
}

func TestLoadTodocloudConfigEnvHonoured(t *testing.T) {
	dir := t.TempDir()
	path := writeFile(t, dir, exampleFile)

	cfg, err := Load(Options{Getenv: fakeEnv(map[string]string{
		"HOME":    dir,
		EnvConfig: path,
	})})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Path != path {
		t.Errorf("Path = %q, want %q", cfg.Path, path)
	}
	if cfg.Provider != ProviderTurso {
		t.Errorf("Provider = %q, want turso", cfg.Provider)
	}
}

func TestLoadTodocloudConfigMissingIsAnError(t *testing.T) {
	dir := t.TempDir()
	missing := filepath.Join(dir, "absent.toml")

	_, err := Load(Options{Getenv: fakeEnv(map[string]string{
		"HOME":    dir,
		EnvConfig: missing,
	})})
	if err == nil {
		t.Fatal("Load: expected an error for a missing TODOCLOUD_CONFIG path")
	}
	assertConfigExit(t, err)
	if !strings.Contains(err.Error(), missing) {
		t.Errorf("error %q does not name the missing path", err.Error())
	}
}

func TestLoadOptionsConfigPathMissingIsAnError(t *testing.T) {
	dir := t.TempDir()
	missing := filepath.Join(dir, "absent.toml")

	_, err := Load(Options{
		Getenv:     fakeEnv(map[string]string{"HOME": dir}),
		ConfigPath: missing,
	})
	if err == nil {
		t.Fatal("Load: expected an error for a missing ConfigPath")
	}
	assertConfigExit(t, err)
}

func TestLoadXDGConfigHomeHonoured(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, "xdgconfig", "todocloud")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	path := writeFile(t, dir, exampleFile)

	cfg, err := Load(Options{Getenv: fakeEnv(map[string]string{
		"HOME":            home,
		"XDG_CONFIG_HOME": filepath.Join(home, "xdgconfig"),
	})})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Path != path {
		t.Errorf("Path = %q, want %q", cfg.Path, path)
	}
	if got := cfg.Origins["provider"]; got != "file:"+path {
		t.Errorf(`Origins["provider"] = %q, want file:%s`, got, path)
	}
}

func TestLoadDefaultHomeConfigPathHonoured(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, ".config", "todocloud")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	path := writeFile(t, dir, exampleFile)

	cfg, err := Load(Options{Getenv: fakeEnv(map[string]string{"HOME": home})})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Path != path {
		t.Errorf("Path = %q, want %q", cfg.Path, path)
	}
}

func TestLoadParseErrorIsAConfigError(t *testing.T) {
	dir := t.TempDir()
	path := writeFile(t, dir, "provider = \"sqlite\nbroken")

	_, err := Load(Options{
		Getenv:     fakeEnv(map[string]string{"HOME": dir}),
		ConfigPath: path,
	})
	if err == nil {
		t.Fatal("Load: expected a parse error")
	}
	assertConfigExit(t, err)
	if !strings.Contains(err.Error(), "line 1:") {
		t.Errorf("error %q does not carry a line number", err.Error())
	}
}

// TestLoadIgnoresTokenShapedKeys is the central credential-hygiene test: a
// token in a config file must not be loaded, and its value must not appear in
// the warning that tells the user to move it.
func TestLoadIgnoresTokenShapedKeys(t *testing.T) {
	keys := []struct {
		table string
		key   string
		env   string
	}{
		{"turso", "token", EnvTursoToken},
		{"d1", "api_token", EnvD1Token},
		{"turso", "secret", EnvTursoToken},
		{"d1", "password", EnvD1Token},
	}

	for _, k := range keys {
		t.Run(k.table+"."+k.key, func(t *testing.T) {
			dir := t.TempDir()
			body := fmt.Sprintf("provider = \"sqlite\"\n\n[%s]\n%s = %q\n", k.table, k.key, fakeToken)
			path := writeFile(t, dir, body)

			cfg, err := Load(Options{
				Getenv:     fakeEnv(map[string]string{"HOME": dir}),
				ConfigPath: path,
			})
			if err != nil {
				t.Fatalf("Load: %v", err)
			}

			if !cfg.Turso.Token.Empty() || !cfg.D1.Token.Empty() {
				t.Error("a token from the config file was loaded; tokens must come from the environment only")
			}
			if len(cfg.Warnings) != 1 {
				t.Fatalf("Warnings = %v, want exactly one", cfg.Warnings)
			}
			w := cfg.Warnings[0]
			if strings.Contains(w, fakeToken) {
				t.Fatal("the warning contains the credential value")
			}
			for _, want := range []string{path, "line 4", k.key, k.env} {
				if !strings.Contains(w, want) {
					t.Errorf("warning %q does not mention %q", w, want)
				}
			}
		})
	}
}

func TestLoadRefusesAFileTokenOnAGroupOrWorldReadableFile(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("file modes are not meaningful on windows")
	}
	home, path := writeXDGConfig(t, tokenFile)
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatalf("Chmod: %v", err)
	}

	cfg, err := Load(Options{
		Getenv:  fakeEnv(map[string]string{"HOME": home}),
		Keyring: noKeyring,
	})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !cfg.Turso.Token.Empty() {
		t.Error("a token was loaded from a group- or world-readable file")
	}
	if _, ok := cfg.Origins["turso.token"]; ok {
		t.Error("a refused token was recorded in Origins")
	}
	if !hasWarning(cfg.Warnings, "chmod 600 "+path) {
		t.Errorf("Warnings = %v, want the chmod 600 advice", cfg.Warnings)
	}
	assertNoWarningLeaksTheToken(t, cfg)
}

// TestLoadDoesNotWarnAboutATokenlessFile pins the rule that the mode and
// in-a-repository checks are about a credential at rest: a config file with
// nothing secret in it must not make every command print a warning.
func TestLoadDoesNotWarnAboutATokenlessFile(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("file modes are not meaningful on windows")
	}
	t.Run("group readable", func(t *testing.T) {
		home, path := writeXDGConfig(t, exampleFile)
		if err := os.Chmod(path, 0o644); err != nil {
			t.Fatalf("Chmod: %v", err)
		}
		cfg, err := Load(Options{
			Getenv:  fakeEnv(map[string]string{"HOME": home}),
			Keyring: noKeyring,
		})
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		if len(cfg.Warnings) != 0 {
			t.Errorf("Warnings = %v, want none for a tokenless file", cfg.Warnings)
		}
	})

	t.Run("inside a repository", func(t *testing.T) {
		home := t.TempDir()
		if err := os.MkdirAll(filepath.Join(home, ".git"), 0o700); err != nil {
			t.Fatalf("MkdirAll: %v", err)
		}
		dir := filepath.Join(home, ".config", "todocloud")
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatalf("MkdirAll: %v", err)
		}
		writeFile(t, dir, exampleFile)
		cfg, err := Load(Options{
			Getenv:  fakeEnv(map[string]string{"HOME": home}),
			Keyring: noKeyring,
		})
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		if len(cfg.Warnings) != 0 {
			t.Errorf("Warnings = %v, want none for a tokenless file", cfg.Warnings)
		}
	})
}

func TestLoadDoesNotWarnOnPrivateFile(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("file modes are not meaningful on windows")
	}
	dir := t.TempDir()
	path := writeFile(t, dir, exampleFile)
	if err := os.Chmod(path, 0o600); err != nil {
		t.Fatalf("Chmod: %v", err)
	}

	cfg, err := Load(Options{
		Getenv:     fakeEnv(map[string]string{"HOME": dir}),
		ConfigPath: path,
	})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if hasWarning(cfg.Warnings, "chmod 600") {
		t.Errorf("Warnings = %v, want no mode warning", cfg.Warnings)
	}
}

func TestLoadRefusesAFileTokenInsideARepository(t *testing.T) {
	home := t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, ".git"), 0o700); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	dir := filepath.Join(home, ".config", "todocloud")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	path := writeFile(t, dir, tokenFile)

	cfg, err := Load(Options{
		Getenv:  fakeEnv(map[string]string{"HOME": home}),
		Keyring: noKeyring,
	})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !cfg.Turso.Token.Empty() {
		t.Error("a token was loaded from a config file inside a git repository")
	}
	if _, ok := cfg.Origins["turso.token"]; ok {
		t.Error("a refused token was recorded in Origins")
	}
	if len(cfg.Warnings) != 1 {
		t.Fatalf("Warnings = %v, want exactly one", cfg.Warnings)
	}
	w := cfg.Warnings[0]
	for _, want := range []string{path, "line 5", "turso.token", "git repository", "NEVER", "rotate it", EnvTursoToken, "tdo login"} {
		if !strings.Contains(w, want) {
			t.Errorf("warning %q does not mention %q", w, want)
		}
	}
	assertNoWarningLeaksTheToken(t, cfg)
}

func TestLoadDoesNotWarnOutsideARepository(t *testing.T) {
	dir := t.TempDir()
	path := writeFile(t, dir, exampleFile)

	cfg, err := Load(Options{
		Getenv:     fakeEnv(map[string]string{"HOME": dir}),
		ConfigPath: path,
	})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if hasWarning(cfg.Warnings, "git repository") {
		t.Errorf("Warnings = %v, want no repository warning", cfg.Warnings)
	}
}

func TestValidate(t *testing.T) {
	tests := []struct {
		name    string
		cfg     Config
		wantErr string
	}{
		{
			name: "sqlite with the default path",
			cfg:  Config{Provider: ProviderSQLite, SQLite: SQLiteConfig{Path: "/data/tasks.db"}},
		},
		{
			name:    "sqlite with an unexpandable path",
			cfg:     Config{Provider: ProviderSQLite, SQLite: SQLiteConfig{Path: "~other/tasks.db"}},
			wantErr: EnvSQLitePath,
		},
		{
			name:    "unknown provider",
			cfg:     Config{Provider: Provider("postgres")},
			wantErr: "unknown provider",
		},
		{
			name: "turso with a url and a token is valid",
			cfg:  Config{Provider: ProviderTurso, Turso: TursoConfig{URL: "libsql://example.turso.io", Token: secret.New(fakeToken)}},
		},
		{
			name:    "turso without a url",
			cfg:     Config{Provider: ProviderTurso, Turso: TursoConfig{Token: secret.New(fakeToken)}},
			wantErr: EnvTursoURL,
		},
		{
			name:    "turso without a token",
			cfg:     Config{Provider: ProviderTurso, Turso: TursoConfig{URL: "libsql://example.turso.io"}},
			wantErr: EnvTursoToken,
		},
		{
			name:    "firestore is not in this build",
			cfg:     Config{Provider: ProviderFirestore},
			wantErr: "docs/providers.md",
		},
		{
			name:    "d1 is not implemented yet",
			cfg:     Config{Provider: ProviderD1},
			wantErr: "docs/providers.md",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := tt.cfg
			err := cfg.Validate()
			if tt.wantErr == "" {
				if err != nil {
					t.Fatalf("Validate: unexpected error: %v", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("Validate: expected an error mentioning %q", tt.wantErr)
			}
			assertConfigExit(t, err)
			if !strings.Contains(err.Error(), tt.wantErr) {
				t.Errorf("error %q does not mention %q", err.Error(), tt.wantErr)
			}
		})
	}
}

func TestValidateUnknownProviderListsTheValidNames(t *testing.T) {
	cfg := Config{Provider: Provider("postgres")}
	err := cfg.Validate()
	if err == nil {
		t.Fatal("Validate: expected an error")
	}
	for _, p := range Providers() {
		if !strings.Contains(err.Error(), string(p)) {
			t.Errorf("error %q does not list provider %q", err.Error(), p)
		}
	}
}

func TestValidateExpandsTheSQLitePath(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	cfg := Config{Provider: ProviderSQLite, SQLite: SQLiteConfig{Path: "~/.local/share/todocloud/tasks.db"}}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("Validate: %v", err)
	}
	want := filepath.Join(home, ".local", "share", "todocloud", "tasks.db")
	if cfg.SQLite.Path != want {
		t.Errorf("SQLite.Path = %q, want %q", cfg.SQLite.Path, want)
	}
}

// validateMissing exercises the per-provider required values. The providers
// are not implemented in v0.1, so the per-value checks are driven directly.
func TestValidateMissingValuesNameTheEnvironmentVariable(t *testing.T) {
	tests := []struct {
		name    string
		cfg     Config
		wantEnv string
	}{
		{
			name:    "turso without a url",
			cfg:     Config{Provider: ProviderTurso, Turso: TursoConfig{Token: secret.New(fakeToken)}},
			wantEnv: EnvTursoURL,
		},
		{
			name:    "turso without a token",
			cfg:     Config{Provider: ProviderTurso, Turso: TursoConfig{URL: "libsql://example.turso.io"}},
			wantEnv: EnvTursoToken,
		},
		{
			name:    "d1 without an account id",
			cfg:     Config{Provider: ProviderD1, D1: D1Config{DatabaseID: "x", Token: secret.New(fakeToken)}},
			wantEnv: EnvD1AccountID,
		},
		{
			name:    "d1 without a database id",
			cfg:     Config{Provider: ProviderD1, D1: D1Config{AccountID: "x", Token: secret.New(fakeToken)}},
			wantEnv: EnvD1DatabaseID,
		},
		{
			name:    "d1 without a token",
			cfg:     Config{Provider: ProviderD1, D1: D1Config{AccountID: "x", DatabaseID: "y"}},
			wantEnv: EnvD1Token,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := tt.cfg
			err := cfg.validateProvider()
			if err == nil {
				t.Fatalf("validateProvider: expected an error naming %s", tt.wantEnv)
			}
			assertConfigExit(t, err)
			if !strings.Contains(err.Error(), tt.wantEnv) {
				t.Errorf("error %q does not name %s", err.Error(), tt.wantEnv)
			}
			if strings.Contains(err.Error(), fakeToken) {
				t.Error("the error contains a credential value")
			}
		})
	}
}

// TestTokenNeverLeaks is the test the whole package exists for.
func TestTokenNeverLeaks(t *testing.T) {
	dir := t.TempDir()
	body := fmt.Sprintf("provider = \"turso\"\n\n[turso]\nurl = \"libsql://example.turso.io\"\ntoken = %q\n", fakeToken)
	path := writeFile(t, dir, body)

	cfg, err := Load(Options{
		Getenv: fakeEnv(map[string]string{
			"HOME":        dir,
			EnvTursoToken: fakeToken,
			EnvD1Token:    fakeToken,
		}),
		ConfigPath: path,
	})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Turso.Token.Reveal() != fakeToken {
		t.Fatal("the token from the environment was not loaded")
	}

	renderings := map[string]string{
		"%v":               fmt.Sprintf("%v", cfg),
		"%+v":              fmt.Sprintf("%+v", cfg),
		"%#v":              fmt.Sprintf("%#v", cfg),
		"%v on the value":  fmt.Sprintf("%v", *cfg),
		"%+v on the value": fmt.Sprintf("%+v", *cfg),
		"%#v on the value": fmt.Sprintf("%#v", *cfg),
	}

	configJSON, err := json.Marshal(cfg)
	if err != nil {
		t.Fatalf("json.Marshal(cfg): %v", err)
	}
	renderings["json.Marshal(cfg)"] = string(configJSON)

	describeJSON, err := json.Marshal(cfg.Describe())
	if err != nil {
		t.Fatalf("json.Marshal(cfg.Describe()): %v", err)
	}
	renderings["json.Marshal(cfg.Describe())"] = string(describeJSON)

	for i, w := range cfg.Warnings {
		renderings[fmt.Sprintf("Warnings[%d]", i)] = w
	}
	if len(cfg.Warnings) == 0 {
		t.Error("expected a warning about the token-shaped key in the config file")
	}

	for name, text := range renderings {
		if strings.Contains(text, fakeToken) {
			t.Errorf("%s discloses the token", name)
		}
		if !strings.Contains(text, secret.Redacted) && (name == "%v" || name == "%+v") {
			t.Errorf("%s does not show the redaction marker: %s", name, text)
		}
	}

	// Describe exposes the hint and nothing more.
	turso, ok := cfg.Describe()["turso"].(map[string]any)
	if !ok {
		t.Fatal(`Describe()["turso"] is not a map`)
	}
	if turso["token"] != cfg.Turso.Token.Hint() {
		t.Errorf(`Describe()["turso"]["token"] = %v, want the secret hint`, turso["token"])
	}
}

func TestDescribeRedactedWhenNoTokenIsSet(t *testing.T) {
	cfg := &Config{Provider: ProviderSQLite, SQLite: SQLiteConfig{Path: "/data/tasks.db"}, Origins: map[string]string{"provider": "default"}}
	d := cfg.Describe()
	if d["provider"] != "sqlite" {
		t.Errorf(`Describe()["provider"] = %v`, d["provider"])
	}
	if d["implemented"] != true {
		t.Errorf(`Describe()["implemented"] = %v, want true`, d["implemented"])
	}
	turso := d["turso"].(map[string]any)
	if turso["token"] != "" {
		t.Errorf("an unset token renders as %q, want the empty string", turso["token"])
	}
	if _, err := json.Marshal(d); err != nil {
		t.Fatalf("json.Marshal(Describe()): %v", err)
	}
}

func TestProviders(t *testing.T) {
	want := []Provider{ProviderSQLite, ProviderTurso, ProviderFirestore, ProviderD1}
	got := Providers()
	if len(got) != len(want) {
		t.Fatalf("Providers() = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("Providers()[%d] = %q, want %q", i, got[i], want[i])
		}
	}
	if !ProviderSQLite.Implemented() {
		t.Error("sqlite must be implemented")
	}
	if !ProviderTurso.Implemented() {
		t.Error("turso must be implemented")
	}
	// D1 is still a name this binary recognises but cannot open, so that the
	// error can say which version it ships in rather than "unknown provider".
	for _, p := range []Provider{ProviderFirestore, ProviderD1} {
		if p.Implemented() {
			t.Errorf("provider %q must not report as implemented yet", p)
		}
	}
}

func TestExpandPath(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	got, err := ExpandPath("~/tasks.db")
	if err != nil {
		t.Fatalf("ExpandPath: %v", err)
	}
	if want := filepath.Join(home, "tasks.db"); got != want {
		t.Errorf("ExpandPath(~/tasks.db) = %q, want %q", got, want)
	}

	got, err = ExpandPath("~")
	if err != nil {
		t.Fatalf("ExpandPath: %v", err)
	}
	if got != home {
		t.Errorf("ExpandPath(~) = %q, want %q", got, home)
	}

	got, err = ExpandPath("tasks.db")
	if err != nil {
		t.Fatalf("ExpandPath: %v", err)
	}
	if !filepath.IsAbs(got) {
		t.Errorf("ExpandPath(tasks.db) = %q, want an absolute path", got)
	}

	if _, err := ExpandPath(""); err == nil {
		t.Error("ExpandPath(\"\"): expected an error")
	}
	if _, err := ExpandPath("~other/tasks.db"); err == nil {
		t.Error("ExpandPath(~other/...): expected an error")
	}
}

func TestDefaultSQLitePath(t *testing.T) {
	data := t.TempDir()
	t.Setenv("XDG_DATA_HOME", data)
	want := filepath.Join(data, "todocloud", "tasks.db")
	if got := DefaultSQLitePath(); got != want {
		t.Errorf("DefaultSQLitePath() = %q, want %q", got, want)
	}
}

// TestLoadLoadsAFileTokenFromTheXDGPath is the positive case for the guarded
// file token: the canonical path, mode 600, outside any repository.
func TestLoadLoadsAFileTokenFromTheXDGPath(t *testing.T) {
	requireFileTokens(t)
	home, path := writeXDGConfig(t, tokenFile)

	cfg, err := Load(Options{
		Getenv:  fakeEnv(map[string]string{"HOME": home}),
		Keyring: noKeyring,
	})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Turso.Token.Reveal() != fakeToken {
		t.Fatal("the token in the XDG config file was not loaded")
	}
	if got, want := cfg.Origins["turso.token"], "file:"+path; got != want {
		t.Errorf(`Origins["turso.token"] = %q, want %q`, got, want)
	}
	if len(cfg.Warnings) != 0 {
		t.Errorf("Warnings = %v, want none", cfg.Warnings)
	}
}

func TestLoadRefusesAFileTokenOutsideTheXDGPath(t *testing.T) {
	dir := t.TempDir()
	path := writeFile(t, dir, tokenFile)

	cfg, err := Load(Options{
		Getenv:     fakeEnv(map[string]string{"HOME": dir}),
		ConfigPath: path,
		Keyring:    noKeyring,
	})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !cfg.Turso.Token.Empty() {
		t.Error("a token was loaded from a file named with --config")
	}
	if _, ok := cfg.Origins["turso.token"]; ok {
		t.Error("a refused token was recorded in Origins")
	}
	if len(cfg.Warnings) != 1 {
		t.Fatalf("Warnings = %v, want exactly one", cfg.Warnings)
	}
	for _, want := range []string{path, EnvConfig, EnvTursoToken, "tdo login"} {
		if !strings.Contains(cfg.Warnings[0], want) {
			t.Errorf("warning %q does not mention %q", cfg.Warnings[0], want)
		}
	}
	assertNoWarningLeaksTheToken(t, cfg)
}

func TestLoadAcceptsAFileTokenViaTodocloudConfig(t *testing.T) {
	requireFileTokens(t)
	dir := t.TempDir()
	path := writeFile(t, dir, tokenFile)

	cfg, err := Load(Options{
		Getenv:  fakeEnv(map[string]string{"HOME": dir, EnvConfig: path}),
		Keyring: noKeyring,
	})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Turso.Token.Reveal() != fakeToken {
		t.Fatalf("the token in $%s was not loaded (warnings: %v)", EnvConfig, cfg.Warnings)
	}
	if got, want := cfg.Origins["turso.token"], "file:"+path; got != want {
		t.Errorf(`Origins["turso.token"] = %q, want %q`, got, want)
	}
}

func TestLoadTokenPrecedence(t *testing.T) {
	const keychainToken = "KEYCHAIN_TOKEN_GOES_HERE"

	t.Run("env beats keychain and file", func(t *testing.T) {
		home, _ := writeXDGConfig(t, tokenFile)
		lookup, asked := recordingKeyring(map[string]string{keyring.AccountTursoToken: keychainToken})

		cfg, err := Load(Options{
			Getenv:  fakeEnv(map[string]string{"HOME": home, EnvTursoToken: fakeToken}),
			Keyring: lookup,
		})
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		if cfg.Turso.Token.Reveal() != fakeToken {
			t.Error("the environment variable did not win")
		}
		if got, want := cfg.Origins["turso.token"], "env:"+EnvTursoToken; got != want {
			t.Errorf(`Origins["turso.token"] = %q, want %q`, got, want)
		}
		for _, account := range *asked {
			if account == keyring.AccountTursoToken {
				t.Error("the keychain was consulted although the environment supplied the token")
			}
		}
	})

	t.Run("keychain beats file", func(t *testing.T) {
		requireFileTokens(t)
		home, _ := writeXDGConfig(t, tokenFile)
		lookup, asked := recordingKeyring(map[string]string{keyring.AccountTursoToken: keychainToken})

		cfg, err := Load(Options{
			Getenv:  fakeEnv(map[string]string{"HOME": home}),
			Keyring: lookup,
		})
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		if cfg.Turso.Token.Reveal() != keychainToken {
			t.Error("the keychain entry did not win over the config file")
		}
		if got := cfg.Origins["turso.token"]; !strings.HasPrefix(got, "keyring:") {
			t.Errorf(`Origins["turso.token"] = %q, want a keyring: origin`, got)
		}
		if len(*asked) == 0 {
			t.Error("the keychain was not consulted although the environment was empty")
		}
		if len(cfg.Warnings) != 0 {
			t.Errorf("Warnings = %v, want none for a keychain hit", cfg.Warnings)
		}
	})

	t.Run("keychain is not consulted for sqlite", func(t *testing.T) {
		home := t.TempDir()
		lookup, asked := recordingKeyring(nil)

		cfg, err := Load(Options{
			Getenv:  fakeEnv(map[string]string{"HOME": home}),
			Keyring: lookup,
		})
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		if cfg.Provider != ProviderSQLite {
			t.Fatalf("Provider = %q, want sqlite", cfg.Provider)
		}
		if len(*asked) != 0 {
			t.Errorf("the keychain was consulted (%v) although sqlite has no token", *asked)
		}
	})
}

func TestLoadKeyringMissIsSilent(t *testing.T) {
	requireFileTokens(t)
	home, path := writeXDGConfig(t, tokenFile)

	cfg, err := Load(Options{
		Getenv:  fakeEnv(map[string]string{"HOME": home}),
		Keyring: noKeyring,
	})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got, want := cfg.Origins["turso.token"], "file:"+path; got != want {
		t.Errorf(`Origins["turso.token"] = %q, want %q`, got, want)
	}
	if len(cfg.Warnings) != 0 {
		t.Errorf("Warnings = %v, want none for a keychain miss", cfg.Warnings)
	}
}

func TestLoadKeyringErrorFallsThroughToTheFile(t *testing.T) {
	requireFileTokens(t)
	home, path := writeXDGConfig(t, tokenFile)
	failure := errors.New("the keychain helper exited with status 1")

	cfg, err := Load(Options{
		Getenv: fakeEnv(map[string]string{"HOME": home}),
		Keyring: func(string) (secret.Secret, bool, error) {
			return secret.Secret{}, false, failure
		},
	})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Turso.Token.Reveal() != fakeToken {
		t.Error("a keychain failure did not fall through to the config file")
	}
	if got, want := cfg.Origins["turso.token"], "file:"+path; got != want {
		t.Errorf(`Origins["turso.token"] = %q, want %q`, got, want)
	}
	if !hasWarning(cfg.Warnings, failure.Error()) {
		t.Errorf("Warnings = %v, want one naming the keychain failure", cfg.Warnings)
	}
	if !hasWarning(cfg.Warnings, keyring.Backend()) {
		t.Errorf("Warnings = %v, want one naming the keychain backend", cfg.Warnings)
	}
	assertNoWarningLeaksTheToken(t, cfg)
}

func TestValidateMissingTokenMentionsTheKeychain(t *testing.T) {
	for _, tt := range []struct {
		name string
		cfg  Config
		env  string
	}{
		{"turso", Config{Provider: ProviderTurso, Turso: TursoConfig{URL: "libsql://example.turso.io"}}, EnvTursoToken},
		{"d1", Config{Provider: ProviderD1, D1: D1Config{AccountID: "x", DatabaseID: "y"}}, EnvD1Token},
	} {
		t.Run(tt.name, func(t *testing.T) {
			cfg := tt.cfg
			err := cfg.validateProvider()
			if err == nil {
				t.Fatal("validateProvider: expected an error")
			}
			for _, want := range []string{tt.env, "tdo login"} {
				if !strings.Contains(err.Error(), want) {
					t.Errorf("error %q does not mention %q", err.Error(), want)
				}
			}
		})
	}
}

func TestDescribeReportsTokenOriginsAndTheKeychain(t *testing.T) {
	requireFileTokens(t)
	home, path := writeXDGConfig(t, tokenFile)

	cfg, err := Load(Options{
		Getenv:  fakeEnv(map[string]string{"HOME": home, EnvD1Token: fakeToken}),
		Keyring: noKeyring,
	})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	d := cfg.Describe()
	turso := d["turso"].(map[string]any)
	if turso["token_present"] != true {
		t.Errorf(`Describe()["turso"]["token_present"] = %v, want true`, turso["token_present"])
	}
	if turso["token_origin"] != "file:"+path {
		t.Errorf(`Describe()["turso"]["token_origin"] = %v, want file:%s`, turso["token_origin"], path)
	}
	if turso["token"] != cfg.Turso.Token.Hint() {
		t.Errorf(`Describe()["turso"]["token"] = %v, want the secret hint`, turso["token"])
	}
	d1 := d["d1"].(map[string]any)
	if d1["token_origin"] != "env:"+EnvD1Token {
		t.Errorf(`Describe()["d1"]["token_origin"] = %v`, d1["token_origin"])
	}
	kr, ok := d["keyring"].(map[string]any)
	if !ok {
		t.Fatal(`Describe()["keyring"] is not a map`)
	}
	if kr["backend"] != keyring.Backend() {
		t.Errorf(`Describe()["keyring"]["backend"] = %v, want %q`, kr["backend"], keyring.Backend())
	}
	if kr["available"] != keyring.Available() {
		t.Errorf(`Describe()["keyring"]["available"] = %v`, kr["available"])
	}
	// The keys the CLI and docs/agents.md already depend on are still there.
	for _, key := range []string{"provider", "implemented", "config_file", "sqlite", "turso", "d1", "origins", "origin_order", "warnings"} {
		if _, ok := d[key]; !ok {
			t.Errorf("Describe() lost the %q key", key)
		}
	}
	if _, err := json.Marshal(d); err != nil {
		t.Fatalf("json.Marshal(Describe()): %v", err)
	}
}

// TestFileAndKeyringTokensNeverLeak is TestTokenNeverLeaks for the two new
// sources: a token loaded from the config file and one from the keychain.
func TestFileAndKeyringTokensNeverLeak(t *testing.T) {
	requireFileTokens(t)
	const keychainToken = "KEYCHAIN_TOKEN_GOES_HERE"
	// provider d1 so that the keychain is consulted for the d1 token, while
	// the turso token still comes from the file.
	home, _ := writeXDGConfig(t, strings.Replace(tokenFile, `provider = "turso"`, `provider = "d1"`, 1))

	cfg, err := Load(Options{
		Getenv: fakeEnv(map[string]string{"HOME": home}),
		Keyring: func(account string) (secret.Secret, bool, error) {
			if account == keyring.AccountD1Token {
				return secret.New(keychainToken), true, nil
			}
			return secret.Secret{}, false, nil
		},
	})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Turso.Token.Reveal() != fakeToken {
		t.Fatal("the file token was not loaded")
	}
	if cfg.D1.Token.Reveal() != keychainToken {
		t.Fatal("the keychain token was not loaded")
	}

	describeJSON, err := json.Marshal(cfg.Describe())
	if err != nil {
		t.Fatalf("json.Marshal(cfg.Describe()): %v", err)
	}
	configJSON, err := json.Marshal(cfg)
	if err != nil {
		t.Fatalf("json.Marshal(cfg): %v", err)
	}

	renderings := map[string]string{
		"%v":                           fmt.Sprintf("%v", cfg),
		"%+v":                          fmt.Sprintf("%+v", cfg),
		"%#v":                          fmt.Sprintf("%#v", cfg),
		"%v on the value":              fmt.Sprintf("%v", *cfg),
		"%+v on the value":             fmt.Sprintf("%+v", *cfg),
		"%#v on the value":             fmt.Sprintf("%#v", *cfg),
		"json.Marshal(cfg)":            string(configJSON),
		"json.Marshal(cfg.Describe())": string(describeJSON),
	}
	for i, w := range cfg.Warnings {
		renderings[fmt.Sprintf("Warnings[%d]", i)] = w
	}
	for key, origin := range cfg.Origins {
		renderings["Origins["+key+"]"] = origin
	}

	for name, text := range renderings {
		for _, token := range []string{fakeToken, keychainToken} {
			if strings.Contains(text, token) {
				t.Errorf("%s discloses a token", name)
			}
		}
	}
}

// assertNoWarningLeaksTheToken checks that no warning carries the value.
func assertNoWarningLeaksTheToken(t *testing.T, cfg *Config) {
	t.Helper()
	for i, w := range cfg.Warnings {
		if strings.Contains(w, fakeToken) {
			t.Errorf("Warnings[%d] discloses the credential value", i)
		}
	}
}

// assertConfigExit asserts that err maps onto exit code 3.
func assertConfigExit(t *testing.T, err error) {
	t.Helper()
	code, name := exit.Classify(err)
	if code != exit.Config || name != exit.CodeConfig {
		t.Errorf("exit.Classify(%v) = (%d, %q), want (%d, %q)", err, code, name, exit.Config, exit.CodeConfig)
	}
}

// hasWarning reports whether any warning contains substr.
func hasWarning(warnings []string, substr string) bool {
	for _, w := range warnings {
		if strings.Contains(w, substr) {
			return true
		}
	}
	return false
}
