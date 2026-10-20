package config

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// xdgEnv is an environment whose XDG config home is a fresh temporary
// directory, so that no test here can reach the developer's own file. It
// returns the environment and the config path the writer will choose.
func xdgEnv(t *testing.T) (func(string) string, string) {
	t.Helper()
	home := t.TempDir()
	xdg := filepath.Join(home, ".config")
	return fakeEnv(map[string]string{
			envHome:          home,
			envXDGConfigHome: xdg,
		}),
		filepath.Join(xdg, "todocloud", "config.toml")
}

// seed writes body to path, creating its directory, so that a test can start
// from a file the user wrote by hand.
func seed(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("writing %s: %v", path, err)
	}
}

// read returns the file's contents, failing the test when it cannot be read:
// a file the writer replaced must always still be there.
func read(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}
	return string(data)
}

func TestAWriteChangesOnlyTheTargetedLineAndLeavesEverythingElseByteForByte(t *testing.T) {
	getenv, path := xdgEnv(t)
	// Everything a hand-written file has that a naive rewriter would lose: a
	// header comment, odd spacing, a trailing comment, a blank line, a table
	// this build has never heard of and a key this build does not read.
	before := `# my todo configuration
provider   =    "sqlite"      # switched back last week

[sqlite]
path = '~/notes/tasks.db'

[turso]
url = "libsql://old.turso.io"
# the token lives in the keychain

[experimental]
colour = "always"
retries = 3
`
	seed(t, path, before)

	if _, err := Set(WriteOptions{Getenv: getenv}, Setting{Table: "turso", Key: "url", Value: "libsql://example.turso.io"}); err != nil {
		t.Fatalf("Set: %v", err)
	}

	want := strings.Replace(before, `url = "libsql://old.turso.io"`, `url = "libsql://example.turso.io"`, 1)
	if got := read(t, path); got != want {
		t.Fatalf("the file was not preserved\n--- got ---\n%s\n--- want ---\n%s", got, want)
	}
}

func TestAWriteToAFileThatDoesNotExistYetCreatesOneWithACommentHeader(t *testing.T) {
	getenv, path := xdgEnv(t)

	res, err := Set(WriteOptions{Getenv: getenv},
		Setting{Key: "provider", Value: "turso"},
		Setting{Table: "turso", Key: "url", Value: "libsql://example.turso.io"})
	if err != nil {
		t.Fatalf("Set: %v", err)
	}
	if !res.Created || !res.Wrote || res.Path != path {
		t.Fatalf("got created=%v wrote=%v path=%s, want a created file at %s", res.Created, res.Wrote, res.Path, path)
	}

	got := read(t, path)
	if !strings.HasPrefix(got, "# todocloud configuration.") {
		t.Fatalf("a created file should start with the comment header, got:\n%s", got)
	}
	// The real check is that the reader agrees with the writer: this is a
	// file tdo can read back.
	cfg, err := Load(Options{Getenv: getenv})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Provider != ProviderTurso || cfg.Turso.URL != "libsql://example.turso.io" {
		t.Fatalf("the written file reads back as provider=%q url=%q", cfg.Provider, cfg.Turso.URL)
	}
	// The header is a comment block, and the first key must land under it
	// rather than above it.
	if strings.Index(got, "provider") < strings.Index(got, "# todocloud configuration.") {
		t.Fatalf("the first key was written above the header comment:\n%s", got)
	}
}

func TestSettingAKeyThatAlreadyExistsReplacesItsValueInPlace(t *testing.T) {
	getenv, path := xdgEnv(t)
	seed(t, path, "provider = \"sqlite\"\n")

	res, err := Set(WriteOptions{Getenv: getenv}, Setting{Key: "provider", Value: "turso"})
	if err != nil {
		t.Fatalf("Set: %v", err)
	}
	if got := read(t, path); got != "provider = \"turso\"\n" {
		t.Fatalf("got %q", got)
	}
	c := res.Changes[0]
	if c.Added || !c.Changed || c.Previous != "sqlite" {
		t.Fatalf("got %+v, want a change from sqlite", c)
	}
}

func TestSettingAKeyToWhatItAlreadySaysChangesNothingAtAll(t *testing.T) {
	getenv, path := xdgEnv(t)
	before := "provider = 'turso'   # single quotes, deliberately\n"
	seed(t, path, before)

	res, err := Set(WriteOptions{Getenv: getenv}, Setting{Key: "provider", Value: "turso"})
	if err != nil {
		t.Fatalf("Set: %v", err)
	}
	if res.Wrote || res.Changes[0].Changed {
		t.Fatalf("a no-op write touched the file: %+v", res)
	}
	// Including the user's choice of quoting, which carries no meaning but
	// is theirs.
	if got := read(t, path); got != before {
		t.Fatalf("got %q, want %q", got, before)
	}
}

func TestANewKeyJoinsTheExistingTableRatherThanStartingASecondOne(t *testing.T) {
	getenv, path := xdgEnv(t)
	seed(t, path, `provider = "d1"

[d1]
account_id = "00000000-0000-0000-0000-000000000000"

[sqlite]
path = "/tmp/tasks.db"
`)

	if _, err := Set(WriteOptions{Getenv: getenv}, Setting{Table: "d1", Key: "database_id", Value: "11111111-1111-1111-1111-111111111111"}); err != nil {
		t.Fatalf("Set: %v", err)
	}

	want := `provider = "d1"

[d1]
account_id = "00000000-0000-0000-0000-000000000000"
database_id = "11111111-1111-1111-1111-111111111111"

[sqlite]
path = "/tmp/tasks.db"
`
	if got := read(t, path); got != want {
		t.Fatalf("got:\n%s\nwant:\n%s", got, want)
	}
}

func TestANewTableIsAppendedAtTheEndWithABlankLineBeforeIt(t *testing.T) {
	getenv, path := xdgEnv(t)
	seed(t, path, "provider = \"turso\"\n")

	if _, err := Set(WriteOptions{Getenv: getenv}, Setting{Table: "turso", Key: "url", Value: "libsql://example.turso.io"}); err != nil {
		t.Fatalf("Set: %v", err)
	}

	want := "provider = \"turso\"\n\n[turso]\nurl = \"libsql://example.turso.io\"\n"
	if got := read(t, path); got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestATopLevelKeyIsWrittenAboveTheFirstTableWhereTheReaderWillSeeIt(t *testing.T) {
	getenv, path := xdgEnv(t)
	// A top-level key appended at the end of this file would belong to
	// [turso], not to the root: the reader tracks the open table.
	seed(t, path, "[turso]\nurl = \"libsql://example.turso.io\"\n")

	if _, err := Set(WriteOptions{Getenv: getenv}, Setting{Key: "provider", Value: "turso"}); err != nil {
		t.Fatalf("Set: %v", err)
	}

	cfg, err := Load(Options{Getenv: getenv})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Provider != ProviderTurso {
		t.Fatalf("provider reads back as %q; the key landed in the wrong table:\n%s", cfg.Provider, read(t, path))
	}
}

func TestAFailedWriteLeavesTheExistingFileExactlyAsItWas(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root can write into a read-only directory, so there is no failure to observe")
	}
	if runtime.GOOS == "windows" {
		t.Skip("directory permissions do not work this way on windows")
	}
	getenv, path := xdgEnv(t)
	before := "provider = \"sqlite\"\n"
	seed(t, path, before)

	// A directory nothing may create a file in is the cheapest stand-in for
	// every reason the write can fail part-way: what matters is that the old
	// file is neither truncated nor removed.
	dir := filepath.Dir(path)
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatalf("Chmod: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })

	if _, err := Set(WriteOptions{Getenv: getenv}, Setting{Key: "provider", Value: "turso"}); err == nil {
		t.Fatal("writing into a read-only directory should have failed")
	}
	if got := read(t, path); got != before {
		t.Fatalf("the old file was damaged: got %q, want %q", got, before)
	}
	// And no debris is left behind for the next run to trip over.
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("got %d files in %s, want only the config file", len(entries), dir)
	}
}

func TestTheWrittenFileIs0600InA0700DirectoryWhateverTheUmask(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix permission bits do not apply on windows")
	}
	// A permissive umask is exactly the case a mode-sensitive writer must not
	// inherit: the reader refuses a token in a group-readable file, so a file
	// tdo creates must never be one.
	restore, ok := setUmask(0)
	if !ok {
		t.Skip("no umask on this platform")
	}
	t.Cleanup(restore)

	getenv, path := xdgEnv(t)
	if _, err := Set(WriteOptions{Getenv: getenv}, Setting{Key: "provider", Value: "turso"}); err != nil {
		t.Fatalf("Set: %v", err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("config file mode is %04o, want 0600", perm)
	}
	dir, err := os.Stat(filepath.Dir(path))
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if perm := dir.Mode().Perm(); perm != 0o700 {
		t.Fatalf("config directory mode is %04o, want 0700", perm)
	}
}

func TestTheWriterRefusesEveryKeyThatHoldsACredential(t *testing.T) {
	getenv, path := xdgEnv(t)

	// The reader's whole token-key list, not just "token": a future caller
	// must not be able to put a credential in a file under any spelling.
	for _, key := range tokenKeyNames {
		_, err := Set(WriteOptions{Getenv: getenv}, Setting{Table: "turso", Key: key, Value: "TOKEN_GOES_HERE"})
		if !errors.Is(err, ErrSecretKey) {
			t.Fatalf("Set(turso.%s) = %v, want ErrSecretKey", key, err)
		}
		if msg := err.Error(); strings.Contains(msg, "TOKEN_GOES_HERE") {
			t.Fatalf("the refusal quoted the value: %s", msg)
		}
	}
	// A refused key writes nothing at all, not even the file.
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a refused write created %s", path)
	}
}

func TestTheWriterRefusesAFileInsideAGitRepository(t *testing.T) {
	home := t.TempDir()
	// The config file sits at the XDG path, which is allowed — but the whole
	// home directory is a dotfiles repository, which is not. This is the case
	// the guard exists for: a dotfiles repo that gets pushed.
	if err := os.MkdirAll(filepath.Join(home, ".git"), 0o700); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	getenv := fakeEnv(map[string]string{envHome: home})

	_, err := Set(WriteOptions{Getenv: getenv}, Setting{Key: "provider", Value: "turso"})
	var refused *RefusedError
	if !errors.As(err, &refused) {
		t.Fatalf("Set = %v, want a RefusedError", err)
	}
	if !strings.Contains(refused.Reason, "git repository") {
		t.Fatalf("the refusal does not name the reason: %s", refused.Reason)
	}
}

func TestTheWriterRefusesAPathThatIsNeitherTheXDGFileNorTODOCLOUDCONFIG(t *testing.T) {
	getenv, _ := xdgEnv(t)
	elsewhere := filepath.Join(t.TempDir(), "project.toml")

	_, err := Set(WriteOptions{Getenv: getenv, ConfigPath: elsewhere}, Setting{Key: "provider", Value: "turso"})
	var refused *RefusedError
	if !errors.As(err, &refused) {
		t.Fatalf("Set = %v, want a RefusedError", err)
	}
	if _, err := os.Stat(elsewhere); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a refused write created %s", elsewhere)
	}
}

func TestTheWriterWritesTheFileNamedByTODOCLOUDCONFIG(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "todocloud.toml")
	getenv := fakeEnv(map[string]string{envHome: dir, EnvConfig: path})

	if _, err := Set(WriteOptions{Getenv: getenv}, Setting{Key: "provider", Value: "turso"}); err != nil {
		t.Fatalf("Set: %v", err)
	}
	if !strings.Contains(read(t, path), `provider = "turso"`) {
		t.Fatalf("got:\n%s", read(t, path))
	}
}

func TestTheWriterRefusesWhenTheEnvironmentNamesNoHomeAtAll(t *testing.T) {
	// The reader falls back to the process's own home directory here. The
	// writer must not: that fallback is how a test, or an agent with a
	// stripped environment, would reach the developer's real config file.
	_, err := Set(WriteOptions{Getenv: fakeEnv(nil)}, Setting{Key: "provider", Value: "turso"})
	var refused *RefusedError
	if !errors.As(err, &refused) {
		t.Fatalf("Set = %v, want a RefusedError", err)
	}
}

func TestTheWriterRefusesAFileItCannotParse(t *testing.T) {
	getenv, path := xdgEnv(t)
	before := "this is not a config file at all\n"
	seed(t, path, before)

	if _, err := Set(WriteOptions{Getenv: getenv}, Setting{Key: "provider", Value: "turso"}); err == nil {
		t.Fatal("rewriting a file tdo cannot read should have been refused")
	}
	if got := read(t, path); got != before {
		t.Fatalf("the unreadable file was rewritten: %q", got)
	}
}

func TestAValueWithQuotesAndBackslashesSurvivesTheRoundTrip(t *testing.T) {
	getenv, _ := xdgEnv(t)
	value := `/tmp/a "quoted" \ path/tasks.db`

	if _, err := Set(WriteOptions{Getenv: getenv}, Setting{Table: "sqlite", Key: "path", Value: value}); err != nil {
		t.Fatalf("Set: %v", err)
	}
	cfg, err := Load(Options{Getenv: getenv})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.SQLite.Path != value {
		t.Fatalf("sqlite.path reads back as %q, want %q", cfg.SQLite.Path, value)
	}
}

func TestParseKeySplitsADottedNameAndRejectsADeeperOne(t *testing.T) {
	table, key, err := ParseKey("turso.url")
	if err != nil || table != "turso" || key != "url" {
		t.Fatalf(`ParseKey("turso.url") = %q, %q, %v`, table, key, err)
	}
	table, key, err = ParseKey("provider")
	if err != nil || table != "" || key != "provider" {
		t.Fatalf(`ParseKey("provider") = %q, %q, %v`, table, key, err)
	}
	for _, bad := range []string{"a.b.c", "", ".url", "turso.", "turso url", "turso.u rl"} {
		if _, _, err := ParseKey(bad); err == nil {
			t.Fatalf("ParseKey(%q) should have failed", bad)
		}
	}
}
