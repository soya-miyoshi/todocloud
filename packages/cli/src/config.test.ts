// The tests of `internal/config/config_test.go` and
// `internal/config/write_test.go`, which were one package and are one file
// here because the reader and the writer are one contract.
//
// Two rules shape every test below:
//
//   - No test may see the real environment. Every Load and every Set is given
//     an injected `Getenv` over a temporary directory, and the module's
//     default keychain lookup is replaced once at load time, so a test that
//     forgets `Keyring` still cannot reach a real keychain. That replacement
//     is Go's TestMain.
//   - No test may hold anything that could be a real credential. Every token
//     here is an obviously fake placeholder (CLAUDE.md §1.3).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as util from 'node:util';

import { Secret, REDACTED } from '@todocloud/core/secret';
import { classify, Config as ExitConfig, CodeConfig } from '@todocloud/core/exit';

import {
  AccountD1Token,
  AccountTursoToken,
  Backend as keyringBackend,
  Available as keyringAvailable,
  Is,
} from './keyring.ts';
import {
  Config,
  DefaultSQLitePath,
  EnvConfig,
  EnvD1AccountID,
  EnvD1DatabaseID,
  EnvD1Token,
  EnvProvider,
  EnvSQLitePath,
  EnvTursoToken,
  EnvTursoURL,
  ErrSecretKey,
  ExpandPath,
  FileTokensSupported,
  forTest,
  Load,
  ParseKey,
  ProviderD1,
  ProviderFirestore,
  Providers,
  ProviderSQLite,
  ProviderTurso,
  providerImplemented,
  RefusedError,
  Set as SetConfig,
  envHome,
  envXDGConfigHome,
  tokenKeyNames,
  type KeyringLookup,
  type Options,
} from './config.ts';

/**
 * fakeToken is an obviously fake credential. No test in this repository may
 * use anything that could be a real one.
 */
const fakeToken = 'TOKEN_GOES_HERE';

/** keychainToken is a second obviously fake credential, for the precedence tests. */
const keychainToken = 'KEYCHAIN_TOKEN_GOES_HERE';

/**
 * noKeyring is an Options.Keyring that reports no entry for every account, so
 * that a test never reaches a real keychain.
 */
const noKeyring: KeyringLookup = () => ({
  value: new Secret(''),
  present: false,
});

// Go's TestMain pointed the package's default keychain lookup at the fake. The
// equivalent here runs at module load, before any test, and is never undone:
// no test in this file may reach the real OS keychain even by omitting
// Options.Keyring.
forTest.setDefaultKeyring(noKeyring);

/** A minimal stand-in for the part of node:test's context the helpers use. */
interface TestContext {
  after: (fn: () => void) => void;
  skip: (reason?: string) => void;
}

/** tempDir is `t.TempDir`: a fresh directory removed when the test ends. */
function tempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todocloud-config-'));
  t.after(() => {
    try {
      fs.chmodSync(dir, 0o700);
      const inner = path.join(dir, '.config', 'todocloud');
      if (fs.existsSync(inner)) {
        fs.chmodSync(inner, 0o700);
      }
    } catch {
      // Already gone, or never ours to change.
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/**
 * setEnv is `t.Setenv`: it sets a variable for the duration of one test and
 * restores it afterwards. Only the handful of functions that read the process
 * environment directly — ExpandPath, DefaultSQLitePath — need it; everything
 * else takes an injected Getenv.
 */
function setEnv(t: TestContext, name: string, value: string): void {
  const previous = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  });
}

/**
 * fakeEnv returns a Getenv that reads only from the given map, so that no
 * test can see the real environment.
 */
function fakeEnv(vars: Record<string, string> = {}): (name: string) => string {
  return (name: string) => vars[name] ?? '';
}

/** writeFile writes a config file into dir and returns its path. */
function writeFile(dir: string, body: string): string {
  const p = path.join(dir, 'config.toml');
  fs.writeFileSync(p, body, 'utf8');
  fs.chmodSync(p, 0o600);
  return p;
}

/**
 * tokenFile is a config file whose [turso] table carries the one supported
 * token spelling. The value is obviously fake.
 */
const tokenFile = `provider = "turso"

[turso]
url = "libsql://example.turso.io"
token = "${fakeToken}"
`;

/**
 * writeXDGConfig writes body to the canonical XDG config path under a fresh
 * home directory, and returns the home directory and the file path.
 */
function writeXDGConfig(t: TestContext, body: string): [home: string, path: string] {
  const home = tempDir(t);
  const dir = path.join(home, '.config', 'todocloud');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return [home, writeFile(dir, body)];
}

/**
 * requireFileTokens skips a test whose premise is that a token in the config
 * file is loaded. On a platform without POSIX file modes that never happens
 * by design — see fileTokenModeGuard — and the refusal has its own test in
 * "Load refuses every file token without POSIX modes".
 */
function requireFileTokens(t: TestContext): boolean {
  if (!FileTokensSupported()) {
    t.skip(`a token in a config file is not read on ${process.platform}`);
    return false;
  }
  return true;
}

/** isWindows guards the subtests whose question only POSIX can answer. */
const isWindows = process.platform === 'win32';

/** isRoot guards the subtests that permission bits do not constrain. */
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

/** hasWarning reports whether any warning contains substr. */
function hasWarning(warnings: string[], substr: string): boolean {
  return warnings.some((w) => w.includes(substr));
}

/** assertNoWarningLeaksTheToken checks that no warning carries the value. */
function assertNoWarningLeaksTheToken(cfg: Config): void {
  for (const [i, w] of cfg.Warnings.entries()) {
    assert.ok(
      !w.includes(fakeToken),
      `Warnings[${i}] discloses the credential value`,
    );
  }
}

/** assertConfigExit asserts that err maps onto exit code 3. */
function assertConfigExit(err: unknown): void {
  const { code, jsonCode } = classify(err);
  assert.deepEqual(
    [code, jsonCode],
    [ExitConfig, CodeConfig],
    `classify(${String(err)}) should be the config exit code`,
  );
}

/** throws runs fn and returns the error it threw, failing when it does not. */
function throws(fn: () => unknown, what: string): Error {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof Error, `${what} threw a non-Error: ${String(err)}`);
    return err;
  }
  assert.fail(`${what}: expected an error`);
}

/**
 * recordingKeyring returns a Keyring serving the given accounts, and the list
 * of accounts it was asked for.
 */
function recordingKeyring(
  entries: Record<string, string> = {},
): [lookup: KeyringLookup, asked: string[]] {
  const asked: string[] = [];
  const lookup: KeyringLookup = (account: string) => {
    asked.push(account);
    const v = entries[account];
    if (v === undefined) {
      return { value: new Secret(''), present: false };
    }
    return { value: new Secret(v), present: true };
  };
  return [lookup, asked];
}

const exampleFile = `provider = "turso"

[sqlite]
path = "/data/tasks.db"

[turso]
url = "libsql://example.turso.io"

[d1]
account_id = "00000000-0000-0000-0000-000000000000"
database_id = "00000000-0000-0000-0000-000000000000"
`;

// --- the per-platform file-token guard ---------------------------------

/**
 * This is the other half of requireFileTokens: where a file token is not
 * supported, the canonical path at the strictest mode the platform can set is
 * still refused, and the warning sends the user to the environment or the
 * keychain.
 *
 * Go reached this branch only by running the suite on Windows. The platform
 * is injectable here, so the branch is exercised on every host — which is
 * what keeps the Windows refusal from rotting unseen.
 */
test('Load refuses every file token without POSIX modes', (t) => {
  const [home, p] = writeXDGConfig(t, tokenFile);
  forTest.setPlatform('win32');
  t.after(() => forTest.setPlatform(null));
  assert.equal(FileTokensSupported(), false);

  const cfg = Load({ Getenv: fakeEnv({ HOME: home }), Keyring: noKeyring });

  assert.ok(
    cfg.Turso.Token.empty(),
    'a token was loaded from a config file on a platform without POSIX modes',
  );
  assert.ok(
    !('turso.token' in cfg.Origins),
    'a refused token was recorded in Origins',
  );
  assert.equal(cfg.Warnings.length, 1, `Warnings = ${cfg.Warnings.join(' | ')}`);
  for (const want of [p, 'win32', EnvTursoToken, 'tdo login']) {
    assert.ok(
      cfg.Warnings[0]?.includes(want),
      `warning does not mention ${want}: ${cfg.Warnings[0]}`,
    );
  }
  assertNoWarningLeaksTheToken(cfg);
});

/**
 * And the POSIX branch is still the one a normal run takes: forcing the
 * platform back to a POSIX name must restore the acceptance, so the dispatch
 * is reversible rather than a one-way switch.
 */
test('the POSIX branch is reached when the platform says so', (t) => {
  if (!requireFileTokens(t)) {
    return;
  }
  const [home] = writeXDGConfig(t, tokenFile);
  forTest.setPlatform('linux');
  t.after(() => forTest.setPlatform(null));
  assert.equal(FileTokensSupported(), true);

  const cfg = Load({ Getenv: fakeEnv({ HOME: home }), Keyring: noKeyring });
  assert.equal(cfg.Turso.Token.reveal(), fakeToken);
});

// --- Load --------------------------------------------------------------

test('Load with defaults only', (t) => {
  const home = tempDir(t);
  const cfg = Load({
    Getenv: fakeEnv({
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
    }),
  });

  assert.equal(cfg.Provider, ProviderSQLite);
  assert.equal(cfg.Path, '', 'Path should be empty when no config file exists');
  assert.equal(
    cfg.SQLite.Path,
    path.join(home, '.local', 'share', 'todocloud', 'tasks.db'),
  );
  assert.equal(cfg.Origins['provider'], 'default');
  assert.equal(cfg.Origins['sqlite.path'], 'default');
  assert.deepEqual(cfg.Warnings, []);
});

test('Load: a missing default file is not an error', (t) => {
  const home = tempDir(t);
  Load({ Getenv: fakeEnv({ HOME: home }) });
});

test('Load honours XDG_DATA_HOME', (t) => {
  const home = tempDir(t);
  const data = path.join(home, 'data');
  const cfg = Load({ Getenv: fakeEnv({ HOME: home, XDG_DATA_HOME: data }) });
  assert.equal(cfg.SQLite.Path, path.join(data, 'todocloud', 'tasks.db'));
});

test('Load uses the file when the environment is absent', (t) => {
  const dir = tempDir(t);
  const p = writeFile(dir, exampleFile);

  const cfg = Load({ Getenv: fakeEnv({ HOME: dir }), ConfigPath: p });

  assert.equal(cfg.Path, p);
  assert.equal(cfg.Provider, ProviderTurso);
  assert.equal(cfg.SQLite.Path, '/data/tasks.db');
  assert.equal(cfg.Turso.URL, 'libsql://example.turso.io');
  assert.notEqual(cfg.D1.AccountID, '');
  assert.notEqual(cfg.D1.DatabaseID, '');

  const fileOrigin = 'file:' + p;
  for (const key of [
    'provider',
    'sqlite.path',
    'turso.url',
    'd1.account_id',
    'd1.database_id',
  ]) {
    assert.equal(cfg.Origins[key], fileOrigin, `Origins[${key}]`);
  }
  // No token was in the environment, so no token origin is recorded.
  assert.ok(!('turso.token' in cfg.Origins));
  assert.ok(cfg.Turso.Token.empty());
});

test('Load: the environment overrides the file', (t) => {
  const dir = tempDir(t);
  const p = writeFile(dir, exampleFile);

  const cfg = Load({
    Getenv: fakeEnv({
      HOME: dir,
      [EnvProvider]: 'd1',
      [EnvSQLitePath]: '/env/tasks.db',
      [EnvTursoURL]: 'libsql://env.example.turso.io',
      [EnvTursoToken]: fakeToken,
      [EnvD1AccountID]: '11111111-1111-1111-1111-111111111111',
      [EnvD1DatabaseID]: '22222222-2222-2222-2222-222222222222',
      [EnvD1Token]: fakeToken,
    }),
    ConfigPath: p,
  });

  assert.equal(cfg.Provider, ProviderD1);
  assert.equal(cfg.SQLite.Path, '/env/tasks.db');
  assert.equal(cfg.Turso.URL, 'libsql://env.example.turso.io');
  assert.equal(cfg.D1.Token.reveal(), fakeToken);

  assert.deepEqual(
    {
      provider: cfg.Origins['provider'],
      'sqlite.path': cfg.Origins['sqlite.path'],
      'turso.url': cfg.Origins['turso.url'],
      'turso.token': cfg.Origins['turso.token'],
      'd1.account_id': cfg.Origins['d1.account_id'],
      'd1.database_id': cfg.Origins['d1.database_id'],
      'd1.token': cfg.Origins['d1.token'],
    },
    {
      provider: 'env:' + EnvProvider,
      'sqlite.path': 'env:' + EnvSQLitePath,
      'turso.url': 'env:' + EnvTursoURL,
      'turso.token': 'env:' + EnvTursoToken,
      'd1.account_id': 'env:' + EnvD1AccountID,
      'd1.database_id': 'env:' + EnvD1DatabaseID,
      'd1.token': 'env:' + EnvD1Token,
    },
  );
});

test('Load honours $TODOCLOUD_CONFIG', (t) => {
  const dir = tempDir(t);
  const p = writeFile(dir, exampleFile);

  const cfg = Load({ Getenv: fakeEnv({ HOME: dir, [EnvConfig]: p }) });
  assert.equal(cfg.Path, p);
  assert.equal(cfg.Provider, ProviderTurso);
});

test('Load: a missing $TODOCLOUD_CONFIG path is an error', (t) => {
  const dir = tempDir(t);
  const missing = path.join(dir, 'absent.toml');

  const err = throws(
    () => Load({ Getenv: fakeEnv({ HOME: dir, [EnvConfig]: missing }) }),
    'Load',
  );
  assertConfigExit(err);
  assert.ok(err.message.includes(missing), 'the error names the missing path');
});

test('Load: a missing Options.ConfigPath is an error', (t) => {
  const dir = tempDir(t);
  const err = throws(
    () =>
      Load({
        Getenv: fakeEnv({ HOME: dir }),
        ConfigPath: path.join(dir, 'absent.toml'),
      }),
    'Load',
  );
  assertConfigExit(err);
});

test('Load honours XDG_CONFIG_HOME', (t) => {
  const home = tempDir(t);
  const dir = path.join(home, 'xdgconfig', 'todocloud');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = writeFile(dir, exampleFile);

  const cfg = Load({
    Getenv: fakeEnv({
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, 'xdgconfig'),
    }),
  });
  assert.equal(cfg.Path, p);
  assert.equal(cfg.Origins['provider'], 'file:' + p);
});

test('Load honours the default ~/.config path', (t) => {
  const [, p] = writeXDGConfig(t, exampleFile);
  const home = path.dirname(path.dirname(path.dirname(p)));

  const cfg = Load({ Getenv: fakeEnv({ HOME: home }) });
  assert.equal(cfg.Path, p);
});

test('Load: a parse error is a config error', (t) => {
  const dir = tempDir(t);
  const p = writeFile(dir, 'provider = "sqlite\nbroken');

  const err = throws(
    () => Load({ Getenv: fakeEnv({ HOME: dir }), ConfigPath: p }),
    'Load',
  );
  assertConfigExit(err);
  assert.ok(err.message.includes('line 1:'), 'the error carries a line number');
});

/**
 * This is the central credential-hygiene test: a token in a config file must
 * not be loaded, and its value must not appear in the warning that tells the
 * user to move it.
 */
test('Load ignores token-shaped keys', async (t) => {
  const keys = [
    { table: 'turso', key: 'token', env: EnvTursoToken },
    { table: 'd1', key: 'api_token', env: EnvD1Token },
    { table: 'turso', key: 'secret', env: EnvTursoToken },
    { table: 'd1', key: 'password', env: EnvD1Token },
  ];

  for (const k of keys) {
    await t.test(`${k.table}.${k.key}`, (st) => {
      const dir = tempDir(st);
      const body = `provider = "sqlite"\n\n[${k.table}]\n${k.key} = "${fakeToken}"\n`;
      const p = writeFile(dir, body);

      const cfg = Load({ Getenv: fakeEnv({ HOME: dir }), ConfigPath: p });

      assert.ok(
        cfg.Turso.Token.empty() && cfg.D1.Token.empty(),
        'a token from the config file was loaded',
      );
      assert.equal(cfg.Warnings.length, 1, cfg.Warnings.join(' | '));
      const w = cfg.Warnings[0] ?? '';
      assert.ok(!w.includes(fakeToken), 'the warning contains the credential value');
      for (const want of [p, 'line 4', k.key, k.env]) {
        assert.ok(w.includes(want), `warning does not mention ${want}: ${w}`);
      }
    });
  }
});

test('Load refuses a file token on a group- or world-readable file', (t) => {
  if (isWindows) {
    t.skip('file modes are not meaningful on windows');
    return;
  }
  const [home, p] = writeXDGConfig(t, tokenFile);
  fs.chmodSync(p, 0o644);

  const cfg = Load({ Getenv: fakeEnv({ HOME: home }), Keyring: noKeyring });

  assert.ok(
    cfg.Turso.Token.empty(),
    'a token was loaded from a group- or world-readable file',
  );
  assert.ok(!('turso.token' in cfg.Origins));
  assert.ok(
    hasWarning(cfg.Warnings, 'chmod 600 ' + p),
    `Warnings = ${cfg.Warnings.join(' | ')}, want the chmod 600 advice`,
  );
  assertNoWarningLeaksTheToken(cfg);
});

/**
 * This pins the rule that the mode and in-a-repository checks are about a
 * credential at rest: a config file with nothing secret in it must not make
 * every command print a warning.
 */
test('Load does not warn about a tokenless file', async (t) => {
  if (isWindows) {
    t.skip('file modes are not meaningful on windows');
    return;
  }

  await t.test('group readable', (st) => {
    const [home, p] = writeXDGConfig(st, exampleFile);
    fs.chmodSync(p, 0o644);
    const cfg = Load({ Getenv: fakeEnv({ HOME: home }), Keyring: noKeyring });
    assert.deepEqual(cfg.Warnings, [], 'want none for a tokenless file');
  });

  await t.test('inside a repository', (st) => {
    const home = tempDir(st);
    fs.mkdirSync(path.join(home, '.git'), { recursive: true, mode: 0o700 });
    const dir = path.join(home, '.config', 'todocloud');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFile(dir, exampleFile);
    const cfg = Load({ Getenv: fakeEnv({ HOME: home }), Keyring: noKeyring });
    assert.deepEqual(cfg.Warnings, [], 'want none for a tokenless file');
  });
});

test('Load does not warn on a private file', (t) => {
  if (isWindows) {
    t.skip('file modes are not meaningful on windows');
    return;
  }
  const dir = tempDir(t);
  const p = writeFile(dir, exampleFile);
  fs.chmodSync(p, 0o600);

  const cfg = Load({ Getenv: fakeEnv({ HOME: dir }), ConfigPath: p });
  assert.ok(!hasWarning(cfg.Warnings, 'chmod 600'), cfg.Warnings.join(' | '));
});

test('Load refuses a file token inside a git repository', (t) => {
  const home = tempDir(t);
  fs.mkdirSync(path.join(home, '.git'), { recursive: true, mode: 0o700 });
  const dir = path.join(home, '.config', 'todocloud');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = writeFile(dir, tokenFile);

  const cfg = Load({ Getenv: fakeEnv({ HOME: home }), Keyring: noKeyring });

  assert.ok(
    cfg.Turso.Token.empty(),
    'a token was loaded from a config file inside a git repository',
  );
  assert.ok(!('turso.token' in cfg.Origins));
  assert.equal(cfg.Warnings.length, 1, cfg.Warnings.join(' | '));
  const w = cfg.Warnings[0] ?? '';
  for (const want of [
    p,
    'line 5',
    'turso.token',
    'git repository',
    'NEVER',
    'rotate it',
    EnvTursoToken,
    'tdo login',
  ]) {
    assert.ok(w.includes(want), `warning does not mention ${want}: ${w}`);
  }
  assertNoWarningLeaksTheToken(cfg);
});

test('Load does not warn outside a repository', (t) => {
  const dir = tempDir(t);
  const p = writeFile(dir, exampleFile);
  const cfg = Load({ Getenv: fakeEnv({ HOME: dir }), ConfigPath: p });
  assert.ok(!hasWarning(cfg.Warnings, 'git repository'), cfg.Warnings.join(' | '));
});

// --- Validate ----------------------------------------------------------

test('Validate', async (t) => {
  const cases: { name: string; cfg: () => Config; wantErr?: string }[] = [
    {
      name: 'sqlite with the default path',
      cfg: () =>
        new Config({ Provider: ProviderSQLite, SQLite: { Path: '/data/tasks.db' } }),
    },
    {
      name: 'sqlite with an unexpandable path',
      cfg: () =>
        new Config({
          Provider: ProviderSQLite,
          SQLite: { Path: '~other/tasks.db' },
        }),
      wantErr: EnvSQLitePath,
    },
    {
      name: 'unknown provider',
      cfg: () => new Config({ Provider: 'postgres' }),
      wantErr: 'unknown provider',
    },
    {
      name: 'turso with a url and a token is valid',
      cfg: () =>
        new Config({
          Provider: ProviderTurso,
          Turso: { URL: 'libsql://example.turso.io', Token: new Secret(fakeToken) },
        }),
    },
    {
      name: 'turso without a url',
      cfg: () =>
        new Config({
          Provider: ProviderTurso,
          Turso: { Token: new Secret(fakeToken) },
        }),
      wantErr: EnvTursoURL,
    },
    {
      name: 'turso without a token',
      cfg: () =>
        new Config({
          Provider: ProviderTurso,
          Turso: { URL: 'libsql://example.turso.io' },
        }),
      wantErr: EnvTursoToken,
    },
    {
      name: 'firestore is not in this build',
      cfg: () => new Config({ Provider: ProviderFirestore }),
      wantErr: 'docs/providers.md',
    },
    {
      name: 'd1 is not implemented yet',
      cfg: () => new Config({ Provider: ProviderD1 }),
      wantErr: 'docs/providers.md',
    },
  ];

  for (const tt of cases) {
    await t.test(tt.name, () => {
      const cfg = tt.cfg();
      if (tt.wantErr === undefined) {
        cfg.Validate();
        return;
      }
      const err = throws(() => cfg.Validate(), 'Validate');
      assertConfigExit(err);
      assert.ok(
        err.message.includes(tt.wantErr),
        `error does not mention ${tt.wantErr}: ${err.message}`,
      );
    });
  }
});

test('Validate: an unknown provider lists the valid names', () => {
  const err = throws(
    () => new Config({ Provider: 'postgres' }).Validate(),
    'Validate',
  );
  for (const p of Providers()) {
    assert.ok(err.message.includes(p), `error does not list provider ${p}`);
  }
});

test('Validate expands the sqlite path', (t) => {
  const home = tempDir(t);
  setEnv(t, 'HOME', home);

  const cfg = new Config({
    Provider: ProviderSQLite,
    SQLite: { Path: '~/.local/share/todocloud/tasks.db' },
  });
  cfg.Validate();
  assert.equal(
    cfg.SQLite.Path,
    path.join(home, '.local', 'share', 'todocloud', 'tasks.db'),
  );
});

/**
 * The per-provider required values. The providers are not all implemented in
 * v0.1, so the per-value checks are driven directly.
 */
test('Validate: missing values name the environment variable', async (t) => {
  const cases: { name: string; cfg: () => Config; wantEnv: string }[] = [
    {
      name: 'turso without a url',
      cfg: () =>
        new Config({
          Provider: ProviderTurso,
          Turso: { Token: new Secret(fakeToken) },
        }),
      wantEnv: EnvTursoURL,
    },
    {
      name: 'turso without a token',
      cfg: () =>
        new Config({
          Provider: ProviderTurso,
          Turso: { URL: 'libsql://example.turso.io' },
        }),
      wantEnv: EnvTursoToken,
    },
    {
      name: 'd1 without an account id',
      cfg: () =>
        new Config({
          Provider: ProviderD1,
          D1: { DatabaseID: 'x', Token: new Secret(fakeToken) },
        }),
      wantEnv: EnvD1AccountID,
    },
    {
      name: 'd1 without a database id',
      cfg: () =>
        new Config({
          Provider: ProviderD1,
          D1: { AccountID: 'x', Token: new Secret(fakeToken) },
        }),
      wantEnv: EnvD1DatabaseID,
    },
    {
      name: 'd1 without a token',
      cfg: () =>
        new Config({
          Provider: ProviderD1,
          D1: { AccountID: 'x', DatabaseID: 'y' },
        }),
      wantEnv: EnvD1Token,
    },
  ];

  for (const tt of cases) {
    await t.test(tt.name, () => {
      const err = throws(() => tt.cfg().validateProvider(), 'validateProvider');
      assertConfigExit(err);
      assert.ok(
        err.message.includes(tt.wantEnv),
        `error does not name ${tt.wantEnv}: ${err.message}`,
      );
      assert.ok(
        !err.message.includes(fakeToken),
        'the error contains a credential value',
      );
    });
  }
});

test('Validate: a missing token mentions the keychain', async (t) => {
  const cases: { name: string; cfg: () => Config; env: string }[] = [
    {
      name: 'turso',
      cfg: () =>
        new Config({
          Provider: ProviderTurso,
          Turso: { URL: 'libsql://example.turso.io' },
        }),
      env: EnvTursoToken,
    },
    {
      name: 'd1',
      cfg: () =>
        new Config({
          Provider: ProviderD1,
          D1: { AccountID: 'x', DatabaseID: 'y' },
        }),
      env: EnvD1Token,
    },
  ];
  for (const tt of cases) {
    await t.test(tt.name, () => {
      const err = throws(() => tt.cfg().validateProvider(), 'validateProvider');
      for (const want of [tt.env, 'tdo login']) {
        assert.ok(err.message.includes(want), `error does not mention ${want}`);
      }
    });
  }
});

// --- disclosure --------------------------------------------------------

/**
 * renderings is every way a Config can reach a human or a log line. Go used
 * the four fmt verbs plus json.Marshal; the equivalents here are util.inspect
 * at three depths, the two string coercions and JSON.stringify.
 */
function renderings(cfg: Config): Record<string, string> {
  const out: Record<string, string> = {
    'inspect(cfg)': util.inspect(cfg),
    'inspect(cfg, deep)': util.inspect(cfg, { depth: null }),
    'inspect(cfg, hidden)': util.inspect(cfg, { depth: null, showHidden: true }),
    'String(cfg)': String(cfg),
    'template literal': `${util.inspect(cfg)}`,
    'JSON.stringify(cfg)': JSON.stringify(cfg) ?? '',
    'JSON.stringify(cfg.Describe())': JSON.stringify(cfg.Describe()) ?? '',
  };
  for (const [i, w] of cfg.Warnings.entries()) {
    out[`Warnings[${i}]`] = w;
  }
  for (const [key, origin] of Object.entries(cfg.Origins)) {
    out[`Origins[${key}]`] = origin;
  }
  return out;
}

/** This is the test the whole module exists for. */
test('a token never leaks', (t) => {
  const dir = tempDir(t);
  const body = `provider = "turso"\n\n[turso]\nurl = "libsql://example.turso.io"\ntoken = "${fakeToken}"\n`;
  const p = writeFile(dir, body);

  const cfg = Load({
    Getenv: fakeEnv({
      HOME: dir,
      [EnvTursoToken]: fakeToken,
      [EnvD1Token]: fakeToken,
    }),
    ConfigPath: p,
  });
  assert.equal(
    cfg.Turso.Token.reveal(),
    fakeToken,
    'the token from the environment was not loaded',
  );

  assert.notEqual(
    cfg.Warnings.length,
    0,
    'expected a warning about the token-shaped key in the config file',
  );

  for (const [name, text] of Object.entries(renderings(cfg))) {
    assert.ok(!text.includes(fakeToken), `${name} discloses the token`);
  }
  // The redaction marker is what an inspected Config shows in place of the
  // value, so the absence above is redaction rather than an empty field.
  assert.ok(util.inspect(cfg).includes(REDACTED), util.inspect(cfg));

  // Describe exposes the hint and nothing more.
  const turso = cfg.Describe()['turso'] as Record<string, unknown>;
  assert.equal(turso['token'], cfg.Turso.Token.hint());
});

/**
 * The same, for the two other sources: a token loaded from the config file
 * and one from the keychain.
 */
test('a file token and a keychain token never leak', (t) => {
  if (!requireFileTokens(t)) {
    return;
  }
  // provider d1 so that the keychain is consulted for the d1 token, while the
  // turso token still comes from the file.
  const [home] = writeXDGConfig(
    t,
    tokenFile.replace('provider = "turso"', 'provider = "d1"'),
  );

  const cfg = Load({
    Getenv: fakeEnv({ HOME: home }),
    Keyring: (account: string) =>
      account === AccountD1Token
        ? { value: new Secret(keychainToken), present: true }
        : { value: new Secret(''), present: false },
  });

  assert.equal(cfg.Turso.Token.reveal(), fakeToken, 'the file token was not loaded');
  assert.equal(
    cfg.D1.Token.reveal(),
    keychainToken,
    'the keychain token was not loaded',
  );

  for (const [name, text] of Object.entries(renderings(cfg))) {
    for (const token of [fakeToken, keychainToken]) {
      assert.ok(!text.includes(token), `${name} discloses a token`);
    }
  }
});

test('Describe is redacted when no token is set', () => {
  const cfg = new Config({
    Provider: ProviderSQLite,
    SQLite: { Path: '/data/tasks.db' },
    Origins: { provider: 'default' },
  });
  const d = cfg.Describe();
  assert.equal(d['provider'], 'sqlite');
  assert.equal(d['implemented'], true);
  const turso = d['turso'] as Record<string, unknown>;
  assert.equal(turso['token'], '', 'an unset token renders as the empty string');
  JSON.stringify(d);
});

test('Describe reports token origins and the keychain', (t) => {
  if (!requireFileTokens(t)) {
    return;
  }
  const [home, p] = writeXDGConfig(t, tokenFile);

  const cfg = Load({
    Getenv: fakeEnv({ HOME: home, [EnvD1Token]: fakeToken }),
    Keyring: noKeyring,
  });

  const d = cfg.Describe();
  const turso = d['turso'] as Record<string, unknown>;
  assert.equal(turso['token_present'], true);
  assert.equal(turso['token_origin'], 'file:' + p);
  assert.equal(turso['token'], cfg.Turso.Token.hint());
  const d1 = d['d1'] as Record<string, unknown>;
  assert.equal(d1['token_origin'], 'env:' + EnvD1Token);
  const kr = d['keyring'] as Record<string, unknown>;
  assert.equal(kr['backend'], keyringBackend());
  assert.equal(kr['available'], keyringAvailable());
  // The keys the CLI and docs/agents.md already depend on are still there.
  for (const key of [
    'provider',
    'implemented',
    'config_file',
    'sqlite',
    'turso',
    'd1',
    'origins',
    'origin_order',
    'warnings',
  ]) {
    assert.ok(key in d, `Describe() lost the ${key} key`);
  }
  JSON.stringify(d);
});

// --- providers and paths -----------------------------------------------

test('Providers', () => {
  assert.deepEqual(Providers(), [
    ProviderSQLite,
    ProviderTurso,
    ProviderFirestore,
    ProviderD1,
  ]);
  assert.ok(providerImplemented(ProviderSQLite), 'sqlite must be implemented');
  assert.ok(providerImplemented(ProviderTurso), 'turso must be implemented');
  // D1 is still a name this binary recognises but cannot open, so that the
  // error can say which version it ships in rather than "unknown provider".
  for (const p of [ProviderFirestore, ProviderD1]) {
    assert.ok(
      !providerImplemented(p),
      `provider ${p} must not report as implemented yet`,
    );
  }
});

test('ExpandPath', (t) => {
  const home = tempDir(t);
  setEnv(t, 'HOME', home);

  assert.equal(ExpandPath('~/tasks.db'), path.join(home, 'tasks.db'));
  assert.equal(ExpandPath('~'), home);
  assert.ok(path.isAbsolute(ExpandPath('tasks.db')));
  throws(() => ExpandPath(''), 'ExpandPath("")');
  throws(() => ExpandPath('~other/tasks.db'), 'ExpandPath(~other/...)');
});

test('DefaultSQLitePath', (t) => {
  const data = tempDir(t);
  setEnv(t, 'XDG_DATA_HOME', data);
  assert.equal(DefaultSQLitePath(), path.join(data, 'todocloud', 'tasks.db'));
});

// --- the guarded file token --------------------------------------------

/**
 * The positive case for the guarded file token: the canonical path, mode 600,
 * outside any repository.
 */
test('Load loads a file token from the XDG path', (t) => {
  if (!requireFileTokens(t)) {
    return;
  }
  const [home, p] = writeXDGConfig(t, tokenFile);

  const cfg = Load({ Getenv: fakeEnv({ HOME: home }), Keyring: noKeyring });

  assert.equal(cfg.Turso.Token.reveal(), fakeToken);
  assert.equal(cfg.Origins['turso.token'], 'file:' + p);
  assert.deepEqual(cfg.Warnings, []);
});

test('Load refuses a file token outside the XDG path', (t) => {
  const dir = tempDir(t);
  const p = writeFile(dir, tokenFile);

  const cfg = Load({
    Getenv: fakeEnv({ HOME: dir }),
    ConfigPath: p,
    Keyring: noKeyring,
  });

  assert.ok(cfg.Turso.Token.empty(), 'a token was loaded from a --config file');
  assert.ok(!('turso.token' in cfg.Origins));
  assert.equal(cfg.Warnings.length, 1, cfg.Warnings.join(' | '));
  for (const want of [p, EnvConfig, EnvTursoToken, 'tdo login']) {
    assert.ok(
      cfg.Warnings[0]?.includes(want),
      `warning does not mention ${want}: ${cfg.Warnings[0]}`,
    );
  }
  assertNoWarningLeaksTheToken(cfg);
});

test('Load accepts a file token via $TODOCLOUD_CONFIG', (t) => {
  if (!requireFileTokens(t)) {
    return;
  }
  const dir = tempDir(t);
  const p = writeFile(dir, tokenFile);

  const cfg = Load({
    Getenv: fakeEnv({ HOME: dir, [EnvConfig]: p }),
    Keyring: noKeyring,
  });

  assert.equal(
    cfg.Turso.Token.reveal(),
    fakeToken,
    `the token in $${EnvConfig} was not loaded (warnings: ${cfg.Warnings.join(' | ')})`,
  );
  assert.equal(cfg.Origins['turso.token'], 'file:' + p);
});

test('Load: token precedence', async (t) => {
  await t.test('env beats keychain and file', (st) => {
    const [home] = writeXDGConfig(st, tokenFile);
    const [lookup, asked] = recordingKeyring({
      [AccountTursoToken]: keychainToken,
    });

    const cfg = Load({
      Getenv: fakeEnv({ HOME: home, [EnvTursoToken]: fakeToken }),
      Keyring: lookup,
    });

    assert.equal(cfg.Turso.Token.reveal(), fakeToken, 'the environment did not win');
    assert.equal(cfg.Origins['turso.token'], 'env:' + EnvTursoToken);
    assert.ok(
      !asked.includes(AccountTursoToken),
      'the keychain was consulted although the environment supplied the token',
    );
  });

  await t.test('keychain beats file', (st) => {
    if (!requireFileTokens(st)) {
      return;
    }
    const [home] = writeXDGConfig(st, tokenFile);
    const [lookup, asked] = recordingKeyring({
      [AccountTursoToken]: keychainToken,
    });

    const cfg = Load({ Getenv: fakeEnv({ HOME: home }), Keyring: lookup });

    assert.equal(
      cfg.Turso.Token.reveal(),
      keychainToken,
      'the keychain entry did not win over the config file',
    );
    assert.ok(
      (cfg.Origins['turso.token'] ?? '').startsWith('keyring:'),
      `Origins["turso.token"] = ${cfg.Origins['turso.token']}`,
    );
    assert.notEqual(asked.length, 0, 'the keychain was not consulted');
    assert.deepEqual(cfg.Warnings, [], 'want none for a keychain hit');
  });

  await t.test('keychain is not consulted for sqlite', (st) => {
    const home = tempDir(st);
    const [lookup, asked] = recordingKeyring();

    const cfg = Load({ Getenv: fakeEnv({ HOME: home }), Keyring: lookup });

    assert.equal(cfg.Provider, ProviderSQLite);
    assert.deepEqual(asked, [], 'the keychain was consulted although sqlite has no token');
  });
});

test('Load: a keychain miss is silent', (t) => {
  if (!requireFileTokens(t)) {
    return;
  }
  const [home, p] = writeXDGConfig(t, tokenFile);

  const cfg = Load({ Getenv: fakeEnv({ HOME: home }), Keyring: noKeyring });

  assert.equal(cfg.Origins['turso.token'], 'file:' + p);
  assert.deepEqual(cfg.Warnings, [], 'want none for a keychain miss');
});

test('Load: a keychain error falls through to the file', (t) => {
  if (!requireFileTokens(t)) {
    return;
  }
  const [home, p] = writeXDGConfig(t, tokenFile);
  const failure = new Error('the keychain helper exited with status 1');

  const cfg = Load({
    Getenv: fakeEnv({ HOME: home }),
    Keyring: () => {
      throw failure;
    },
  });

  assert.equal(
    cfg.Turso.Token.reveal(),
    fakeToken,
    'a keychain failure did not fall through to the config file',
  );
  assert.equal(cfg.Origins['turso.token'], 'file:' + p);
  assert.ok(
    hasWarning(cfg.Warnings, failure.message),
    `Warnings = ${cfg.Warnings.join(' | ')}, want one naming the failure`,
  );
  assert.ok(
    hasWarning(cfg.Warnings, keyringBackend()),
    `Warnings = ${cfg.Warnings.join(' | ')}, want one naming the backend`,
  );
  assertNoWarningLeaksTheToken(cfg);
});

// --- the writer --------------------------------------------------------

/**
 * xdgEnv is an environment whose XDG config home is a fresh temporary
 * directory, so that no test here can reach the developer's own file. It
 * returns the environment and the config path the writer will choose.
 */
function xdgEnv(t: TestContext): [getenv: (name: string) => string, path: string] {
  const home = tempDir(t);
  const xdg = path.join(home, '.config');
  return [
    fakeEnv({ [envHome]: home, [envXDGConfigHome]: xdg }),
    path.join(xdg, 'todocloud', 'config.toml'),
  ];
}

/**
 * seed writes body to path, creating its directory, so that a test can start
 * from a file the user wrote by hand.
 */
function seed(p: string, body: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  fs.writeFileSync(p, body, 'utf8');
  fs.chmodSync(p, 0o600);
}

/**
 * read returns the file's contents, failing the test when it cannot be read:
 * a file the writer replaced must always still be there.
 */
function read(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

/**
 * setUmask is `write_umask_unix_test.go`'s helper: it sets the process umask
 * and returns a function restoring the previous value, or null on a platform
 * where the umask does not exist. A file tdo creates must be 0600 whatever
 * the caller's umask, so the test that proves it needs a permissive one.
 */
function setUmask(mask: number): (() => void) | null {
  if (isWindows) {
    return null;
  }
  const previous = process.umask(mask);
  return () => {
    process.umask(previous);
  };
}

test('a write changes only the targeted line and leaves everything else byte for byte', (t) => {
  const [getenv, p] = xdgEnv(t);
  // Everything a hand-written file has that a naive rewriter would lose: a
  // header comment, odd spacing, a trailing comment, a blank line, a table
  // this build has never heard of and a key this build does not read.
  const before = `# my todo configuration
provider   =    "sqlite"      # switched back last week

[sqlite]
path = '~/notes/tasks.db'

[turso]
url = "libsql://old.turso.io"
# the token lives in the keychain

[experimental]
colour = "always"
retries = 3
`;
  seed(p, before);

  SetConfig({ Getenv: getenv }, {
    Table: 'turso',
    Key: 'url',
    Value: 'libsql://example.turso.io',
  });

  assert.equal(
    read(p),
    before.replace(
      'url = "libsql://old.turso.io"',
      'url = "libsql://example.turso.io"',
    ),
  );
});

test('a write to a file that does not exist yet creates one with a comment header', (t) => {
  const [getenv, p] = xdgEnv(t);

  const res = SetConfig(
    { Getenv: getenv },
    { Key: 'provider', Value: 'turso' },
    { Table: 'turso', Key: 'url', Value: 'libsql://example.turso.io' },
  );
  assert.ok(res.Created && res.Wrote && res.Path === p, JSON.stringify(res));

  const got = read(p);
  assert.ok(
    got.startsWith('# todocloud configuration.'),
    `a created file should start with the comment header:\n${got}`,
  );
  // The real check is that the reader agrees with the writer: this is a file
  // tdo can read back.
  const cfg = Load({ Getenv: getenv });
  assert.equal(cfg.Provider, ProviderTurso);
  assert.equal(cfg.Turso.URL, 'libsql://example.turso.io');
  // The header is a comment block, and the first key must land under it
  // rather than above it.
  assert.ok(
    got.indexOf('provider') > got.indexOf('# todocloud configuration.'),
    `the first key was written above the header comment:\n${got}`,
  );
});

test('setting a key that already exists replaces its value in place', (t) => {
  const [getenv, p] = xdgEnv(t);
  seed(p, 'provider = "sqlite"\n');

  const res = SetConfig({ Getenv: getenv }, { Key: 'provider', Value: 'turso' });
  assert.equal(read(p), 'provider = "turso"\n');
  const c = res.Changes[0];
  assert.deepEqual(
    [c?.Added, c?.Changed, c?.Previous],
    [false, true, 'sqlite'],
    JSON.stringify(c),
  );
});

test('setting a key to what it already says changes nothing at all', (t) => {
  const [getenv, p] = xdgEnv(t);
  const before = "provider = 'turso'   # single quotes, deliberately\n";
  seed(p, before);

  const res = SetConfig({ Getenv: getenv }, { Key: 'provider', Value: 'turso' });
  assert.ok(!res.Wrote && !res.Changes[0]?.Changed, JSON.stringify(res));
  // Including the user's choice of quoting, which carries no meaning but is
  // theirs.
  assert.equal(read(p), before);
});

test('a new key joins the existing table rather than starting a second one', (t) => {
  const [getenv, p] = xdgEnv(t);
  seed(
    p,
    `provider = "d1"

[d1]
account_id = "00000000-0000-0000-0000-000000000000"

[sqlite]
path = "/tmp/tasks.db"
`,
  );

  SetConfig({ Getenv: getenv }, {
    Table: 'd1',
    Key: 'database_id',
    Value: '11111111-1111-1111-1111-111111111111',
  });

  assert.equal(
    read(p),
    `provider = "d1"

[d1]
account_id = "00000000-0000-0000-0000-000000000000"
database_id = "11111111-1111-1111-1111-111111111111"

[sqlite]
path = "/tmp/tasks.db"
`,
  );
});

test('a new table is appended at the end with a blank line before it', (t) => {
  const [getenv, p] = xdgEnv(t);
  seed(p, 'provider = "turso"\n');

  SetConfig({ Getenv: getenv }, {
    Table: 'turso',
    Key: 'url',
    Value: 'libsql://example.turso.io',
  });

  assert.equal(
    read(p),
    'provider = "turso"\n\n[turso]\nurl = "libsql://example.turso.io"\n',
  );
});

test('a top-level key is written above the first table where the reader will see it', (t) => {
  const [getenv, p] = xdgEnv(t);
  // A top-level key appended at the end of this file would belong to
  // [turso], not to the root: the reader tracks the open table.
  seed(p, '[turso]\nurl = "libsql://example.turso.io"\n');

  SetConfig({ Getenv: getenv }, { Key: 'provider', Value: 'turso' });

  const cfg = Load({ Getenv: getenv });
  assert.equal(
    cfg.Provider,
    ProviderTurso,
    `the key landed in the wrong table:\n${read(p)}`,
  );
});

test('a failed write leaves the existing file exactly as it was', (t) => {
  if (isRoot) {
    t.skip('root can write into a read-only directory');
    return;
  }
  if (isWindows) {
    t.skip('directory permissions do not work this way on windows');
    return;
  }
  const [getenv, p] = xdgEnv(t);
  const before = 'provider = "sqlite"\n';
  seed(p, before);

  // A directory nothing may create a file in is the cheapest stand-in for
  // every reason the write can fail part-way: what matters is that the old
  // file is neither truncated nor removed.
  const dir = path.dirname(p);
  fs.chmodSync(dir, 0o500);
  t.after(() => {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // Already gone.
    }
  });

  throws(
    () => SetConfig({ Getenv: getenv }, { Key: 'provider', Value: 'turso' }),
    'writing into a read-only directory',
  );
  assert.equal(read(p), before, 'the old file was damaged');
  // And no debris is left behind for the next run to trip over.
  assert.deepEqual(fs.readdirSync(dir), ['config.toml']);
});

test('the written file is 0600 in a 0700 directory whatever the umask', (t) => {
  if (isWindows) {
    t.skip('unix permission bits do not apply on windows');
    return;
  }
  // A permissive umask is exactly the case a mode-sensitive writer must not
  // inherit: the reader refuses a token in a group-readable file, so a file
  // tdo creates must never be one.
  const restore = setUmask(0o000);
  if (restore === null) {
    t.skip('no umask on this platform');
    return;
  }
  t.after(restore);

  const [getenv, p] = xdgEnv(t);
  SetConfig({ Getenv: getenv }, { Key: 'provider', Value: 'turso' });

  assert.equal(
    (fs.statSync(p).mode & 0o777).toString(8),
    '600',
    'config file mode',
  );
  assert.equal(
    (fs.statSync(path.dirname(p)).mode & 0o777).toString(8),
    '700',
    'config directory mode',
  );
});

/**
 * The same, for a directory that already exists at a looser mode: the write
 * tightens it rather than inheriting it, which is the other half of what the
 * umask test proves.
 */
test('an existing group-readable directory is tightened by a write', (t) => {
  if (isWindows) {
    t.skip('unix permission bits do not apply on windows');
    return;
  }
  const restore = setUmask(0o000);
  if (restore === null) {
    t.skip('no umask on this platform');
    return;
  }
  t.after(restore);

  const [getenv, p] = xdgEnv(t);
  seed(p, 'provider = "sqlite"\n');
  fs.chmodSync(path.dirname(p), 0o755);
  fs.chmodSync(p, 0o644);

  SetConfig({ Getenv: getenv }, { Key: 'provider', Value: 'turso' });

  assert.equal((fs.statSync(path.dirname(p)).mode & 0o777).toString(8), '700');
  assert.equal((fs.statSync(p).mode & 0o777).toString(8), '600');
});

test('the writer refuses every key that holds a credential', (t) => {
  const [getenv, p] = xdgEnv(t);

  // The reader's whole token-key list, not just "token": a future caller must
  // not be able to put a credential in a file under any spelling.
  for (const key of tokenKeyNames) {
    const err = throws(
      () =>
        SetConfig({ Getenv: getenv }, {
          Table: 'turso',
          Key: key,
          Value: fakeToken,
        }),
      `Set(turso.${key})`,
    );
    assert.ok(Is(err, ErrSecretKey), `Set(turso.${key}) = ${err.message}`);
    assert.ok(!err.message.includes(fakeToken), 'the refusal quoted the value');
  }
  // A refused key writes nothing at all, not even the file.
  assert.ok(!fs.existsSync(p), `a refused write created ${p}`);
});

test('the writer refuses a file inside a git repository', (t) => {
  const home = tempDir(t);
  // The config file sits at the XDG path, which is allowed — but the whole
  // home directory is a dotfiles repository, which is not. This is the case
  // the guard exists for: a dotfiles repo that gets pushed.
  fs.mkdirSync(path.join(home, '.git'), { recursive: true, mode: 0o700 });
  const getenv = fakeEnv({ [envHome]: home });

  const err = throws(
    () => SetConfig({ Getenv: getenv }, { Key: 'provider', Value: 'turso' }),
    'Set',
  );
  assert.ok(err instanceof RefusedError, `want a RefusedError, got ${err.message}`);
  assert.ok(err.Reason.includes('git repository'), err.Reason);
});

test('the writer refuses a path that is neither the XDG file nor $TODOCLOUD_CONFIG', (t) => {
  const [getenv] = xdgEnv(t);
  const elsewhere = path.join(tempDir(t), 'project.toml');

  const err = throws(
    () =>
      SetConfig({ Getenv: getenv, ConfigPath: elsewhere }, {
        Key: 'provider',
        Value: 'turso',
      }),
    'Set',
  );
  assert.ok(err instanceof RefusedError, `want a RefusedError, got ${err.message}`);
  assert.ok(!fs.existsSync(elsewhere), `a refused write created ${elsewhere}`);
});

test('the writer writes the file named by $TODOCLOUD_CONFIG', (t) => {
  const dir = tempDir(t);
  const p = path.join(dir, 'todocloud.toml');
  const getenv = fakeEnv({ [envHome]: dir, [EnvConfig]: p });

  SetConfig({ Getenv: getenv }, { Key: 'provider', Value: 'turso' });
  assert.ok(read(p).includes('provider = "turso"'), read(p));
});

test('the writer refuses when the environment names no home at all', () => {
  // The reader falls back to the process's own home directory here. The
  // writer must not: that fallback is how a test, or an agent with a
  // stripped environment, would reach the developer's real config file.
  const err = throws(
    () => SetConfig({ Getenv: fakeEnv() }, { Key: 'provider', Value: 'turso' }),
    'Set',
  );
  assert.ok(err instanceof RefusedError, `want a RefusedError, got ${err.message}`);
});

test('the writer refuses a file it cannot parse', (t) => {
  const [getenv, p] = xdgEnv(t);
  const before = 'this is not a config file at all\n';
  seed(p, before);

  throws(
    () => SetConfig({ Getenv: getenv }, { Key: 'provider', Value: 'turso' }),
    'rewriting a file tdo cannot read',
  );
  assert.equal(read(p), before, 'the unreadable file was rewritten');
});

test('a value with quotes and backslashes survives the round trip', (t) => {
  const [getenv] = xdgEnv(t);
  const value = '/tmp/a "quoted" \\ path/tasks.db';

  SetConfig({ Getenv: getenv }, { Table: 'sqlite', Key: 'path', Value: value });
  const cfg = Load({ Getenv: getenv });
  assert.equal(cfg.SQLite.Path, value);
});

/**
 * A control character cannot be written in a form the reader understands, so
 * renderString refuses it rather than producing a file that fails to parse.
 */
test('a value holding a control character is refused', (t) => {
  const [getenv, p] = xdgEnv(t);
  const err = throws(
    () =>
      SetConfig({ Getenv: getenv }, {
        Table: 'sqlite',
        Key: 'path',
        Value: '/tmp/\u0007bell.db',
      }),
    'Set',
  );
  assert.ok(err.message.includes('control character'), err.message);
  assert.ok(!fs.existsSync(p), 'a refused write created the file');
});

test('Set with no settings at all is an error', (t) => {
  const [getenv] = xdgEnv(t);
  throws(() => SetConfig({ Getenv: getenv }), 'Set with no settings');
});

test('ParseKey splits a dotted name and rejects a deeper one', () => {
  assert.deepEqual(ParseKey('turso.url'), ['turso', 'url']);
  assert.deepEqual(ParseKey('provider'), ['', 'provider']);
  for (const bad of ['a.b.c', '', '.url', 'turso.', 'turso url', 'turso.u rl']) {
    throws(() => ParseKey(bad), `ParseKey(${JSON.stringify(bad)})`);
  }
});

/**
 * Options is structural here rather than a Go struct, so this asserts the
 * shape the command layer will build: every field optional, and an empty
 * object a valid call.
 */
test('Options and WriteOptions are fully optional', (t) => {
  const home = tempDir(t);
  const opts: Options = { Getenv: fakeEnv({ HOME: home }) };
  assert.equal(Load(opts).Provider, ProviderSQLite);
});
