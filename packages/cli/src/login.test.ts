// `tdo login`, ported from login_test.go.
//
// Every test here installs a fake keychain and a fake provider CLI, so that
// none of them can read or write the developer's real keychain or execute the
// real `turso` binary (CLAUDE.md §1.5). The two fake tokens are obviously
// fake (§1.3), and every test ends by asserting that neither reached stdout
// or stderr.
//
// No store is opened by `tdo login`, so these tests drive `RunWith` directly
// with their own Env rather than going through the SQLite harness: that is
// also what gives them a stdin to pipe a token into and a `stdinIsTTY` to
// turn on, which is the seam Go had as the `loginStdinIsTerminal` package
// variable.

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import * as exit from '@todocloud/core/exit';
import * as providercli from '@todocloud/core/providercli';
import { REDACTED, Secret } from '@todocloud/core/secret';

import { type Env, RunWith } from './app.ts';
import * as keyring from './keyring.ts';
import { forTest, loginCommand } from './login.ts';
import { buffer, type Result } from './testsupport.ts';

/**
 * loginFakeToken is the value every test here pipes in. No test may ever see
 * it in output.
 */
const loginFakeToken = 'FAKE-TOKEN-not-a-real-credential-wxyz';

/** fakeTursoToken is what the fake Turso CLI mints, and equally fake. */
const fakeTursoToken = 'TOKEN_GOES_HERE_turso';

/** FakeKeychain is an in-memory stand-in for the OS keychain. */
interface FakeKeychain {
  backend: string;
  available: boolean;
  setErr?: Error | undefined;
  stored: Map<string, Secret>;
}

/** installKeychain replaces the keychain for the duration of one test. */
function installKeychain(
  t: TestContext,
  init: { backend: string; available?: boolean; setErr?: Error },
): FakeKeychain {
  const k: FakeKeychain = {
    backend: init.backend,
    available: init.available ?? false,
    setErr: init.setErr,
    stored: new Map<string, Secret>(),
  };
  const restore = forTest.installKeychain({
    backend: () => k.backend,
    available: () => k.available,
    get: (account) => {
      if (!k.available) {
        throw keyring.ErrUnavailable;
      }
      const value = k.stored.get(account);
      return { value: value ?? new Secret(''), present: value !== undefined };
    },
    set: (account, value) => {
      if (k.setErr !== undefined) {
        throw k.setErr;
      }
      k.stored.set(account, value);
    },
    delete: (account) => {
      k.stored.delete(account);
    },
  });
  t.after(restore);
  return k;
}

/**
 * FakeTurso is a stand-in for the Turso CLI. No test here runs the real one:
 * that would put the developer's own credentials in the test output.
 */
interface FakeTursoInit {
  installed?: boolean;
  loggedIn?: boolean;
  loginErr?: boolean;
  databases?: string[];
  listErr?: boolean;
  url?: string;
  urlErr?: boolean;
  createErr?: string;
}

interface FakeTurso {
  /** created records the databases a token was minted for. */
  created: string[];
}

/**
 * installTurso drives providercli's own runner seam rather than Go's five
 * per-function variables: the port already routes every child process through
 * `installRunner`, so faking at that level also proves the argv the command
 * would have built — and that no secret is in it.
 */
function installTurso(t: TestContext, init: FakeTursoInit): FakeTurso {
  const f: FakeTurso = { created: [] };
  const restore = forTest.installProviderCLI({
    lookPath: (file: string): string => {
      if (file === providercli.TURSO_BIN && init.installed === true) {
        return '/fake/bin/turso';
      }
      throw new Error(`${file} is not installed`);
    },
    runner: (_signal, name, args): providercli.Output => {
      assert.equal(name, providercli.TURSO_BIN, 'a test reached another provider CLI');
      for (const arg of args) {
        // The rule, asserted rather than assumed: no secret may reach a
        // child's argv (CLAUDE.md §1.6).
        assert.ok(
          !arg.includes(loginFakeToken) && !arg.includes(fakeTursoToken),
          `a token reached argv: ${args.join(' ')}`,
        );
      }
      const line = args.join(' ');
      if (line === 'auth token') {
        if (init.loginErr === true) {
          return { stdout: '', stderr: 'could not reach turso', err: new Error('broken pipe') };
        }
        return init.loggedIn === true
          ? { stdout: 'a-session-token', stderr: '' }
          : { stdout: '', stderr: '', err: new providercli.ExitError(1) };
      }
      if (line === 'db list') {
        if (init.listErr === true) {
          return { stdout: '', stderr: 'db list failed', err: new providercli.ExitError(1) };
        }
        return { stdout: ['NAME', ...(init.databases ?? [])].join('\n') + '\n', stderr: '' };
      }
      if (args[0] === 'db' && args[1] === 'tokens' && args[2] === 'create') {
        if (init.createErr !== undefined) {
          return { stdout: '', stderr: init.createErr, err: new providercli.ExitError(1) };
        }
        f.created.push(args[3] ?? '');
        return { stdout: fakeTursoToken + '\n', stderr: '' };
      }
      if (args[0] === 'db' && args[1] === 'show') {
        if (init.urlErr === true || init.url === undefined) {
          return { stdout: '', stderr: 'no such database', err: new providercli.ExitError(1) };
        }
        return { stdout: init.url + '\n', stderr: '' };
      }
      throw new Error(`the fake turso CLI was asked for ${line}`);
    },
  });
  t.after(restore);
  return f;
}

/** runLogin drives the real command with stdin piped and a fake environment. */
async function runLogin(
  env: Record<string, string>,
  stdin: string,
  opts: { terminal?: boolean },
  ...args: string[]
): Promise<Result> {
  const out = new buffer();
  const err = new buffer();
  const injected: Env = {
    stdout: out,
    stderr: err,
    stdin: { read: (): Promise<string> => Promise.resolve(stdin) },
    // A clean environment: the developer's own TODOCLOUD_* variables and
    // config file must not reach this command.
    getenv: (key: string): string => env[key] ?? '',
    stdinIsTTY: (): boolean => opts.terminal === true,
    // Configuration resolves cloud tokens through the OS keychain; without
    // this seam a test that selects a cloud provider would query the
    // developer's real one.
    keyring: () => ({ value: new Secret(''), present: false }),
  };
  const code = await RunWith(injected, ['tdo', 'login', ...args], [loginCommand]);
  return { code, stdout: out.text, stderr: err.text };
}

/** turso is the default environment: the provider whose token is managed. */
const turso: Record<string, string> = { TODOCLOUD_PROVIDER: 'turso' };

/** assertNoToken is the assertion every test in this file ends with. */
function assertNoToken(res: Result): void {
  assert.ok(!res.stdout.includes(loginFakeToken), `the token reached stdout: ${res.stdout}`);
  assert.ok(!res.stderr.includes(loginFakeToken), `the token reached stderr: ${res.stderr}`);
  assert.ok(
    !res.stdout.includes(fakeTursoToken),
    `the minted token reached stdout: ${res.stdout}`,
  );
  assert.ok(
    !res.stderr.includes(fakeTursoToken),
    `the minted token reached stderr: ${res.stderr}`,
  );
}

/** decodeLine parses one line of JSON from stdout. */
function decodeLine(res: Result): Record<string, unknown> {
  const value: unknown = JSON.parse(res.stdout.trim());
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value), res.stdout);
  return value as Record<string, unknown>;
}

test('login with no backend prints instructions and succeeds', async (t: TestContext) => {
  installKeychain(t, { backend: keyring.BackendNone });
  installTurso(t, {});

  const res = await runLogin(turso, loginFakeToken + '\n', {});
  assert.equal(res.code, 0, res.stderr);
  // Nothing failed, so nothing goes to stdout and no error is rendered.
  assert.equal(res.stdout, '');
  assert.ok(res.stderr.includes(keyring.Placeholder), res.stderr);
  assert.ok(!res.stderr.includes('tdo: warning'), res.stderr);
  assertNoToken(res);
});

test('login with no backend reports not stored in JSON', async (t: TestContext) => {
  installKeychain(t, { backend: keyring.BackendNone });
  installTurso(t, {});

  const res = await runLogin(turso, loginFakeToken + '\n', {}, '--json');
  assert.equal(res.code, 0, res.stderr);
  const got = decodeLine(res);
  assert.equal(got['stored'], false);
  assert.equal(got['backend'], keyring.BackendNone);
  assert.ok(String(got['instructions']).includes(keyring.Placeholder), res.stdout);
  assertNoToken(res);
});

// The macOS fallback: a backend exists and can be read, but this particular
// token cannot be handed to it without exposing it in argv.
test('login degrades instead of failing when writing is unsupported', async (t: TestContext) => {
  installKeychain(t, {
    backend: keyring.BackendKeychain,
    available: true,
    setErr: keyring.ErrWriteUnsupported,
  });
  installTurso(t, {});

  const res = await runLogin(turso, loginFakeToken + '\n', {}, '--json');
  assert.equal(res.code, 0, res.stderr);
  const got = decodeLine(res);
  assert.equal(got['stored'], false);
  assert.notEqual(got['instructions'], undefined);
  assertNoToken(res);
});

test('login stores the token from piped stdin', async (t: TestContext) => {
  const k = installKeychain(t, { backend: keyring.BackendKeychain, available: true });
  installTurso(t, {});

  const res = await runLogin(turso, loginFakeToken + '\n', {}, '--json');
  assert.equal(res.code, 0, res.stderr);
  const got = decodeLine(res);
  assert.equal(got['stored'], true);
  assert.equal(got['provider'], 'turso');
  assert.equal(got['account'], keyring.AccountTursoToken);
  // The value must arrive intact: a trailing newline is the terminator, not
  // part of the token.
  const stored = k.stored.get(keyring.AccountTursoToken);
  assert.notEqual(stored, undefined, 'nothing was stored');
  assert.equal(stored?.reveal(), loginFakeToken);
  assertNoToken(res);
});

test('login names the environment variable the user can now unset', async (t: TestContext) => {
  installKeychain(t, { backend: keyring.BackendKeychain, available: true });
  installTurso(t, {});

  const res = await runLogin(turso, loginFakeToken + '\n', {});
  assert.equal(res.code, 0, res.stderr);
  assert.ok(res.stderr.includes('TODOCLOUD_TURSO_TOKEN'), res.stderr);
  assertNoToken(res);
});

test('login --show never prints the value', async (t: TestContext) => {
  const k = installKeychain(t, { backend: keyring.BackendKeychain, available: true });
  k.stored.set(keyring.AccountTursoToken, new Secret(loginFakeToken));

  const res = await runLogin(turso, '', {}, '--show');
  assert.equal(res.code, 0, res.stderr);
  assert.ok(res.stdout.includes(REDACTED), res.stdout);
  assertNoToken(res);

  const json = await runLogin(turso, '', {}, '--show', '--json');
  const got = decodeLine(json);
  assert.equal(got['present'], true);
  assert.ok(String(got['hint']).startsWith(REDACTED), String(got['hint']));
  assertNoToken(json);
});

test('login --show reports an absent entry', async (t: TestContext) => {
  installKeychain(t, { backend: keyring.BackendKeychain, available: true });

  const res = await runLogin(turso, '', {}, '--show', '--json');
  assert.equal(res.code, 0, res.stderr);
  const got = decodeLine(res);
  assert.equal(got['present'], false);
  assert.equal(got['hint'], '');
});

test('login --remove deletes the entry', async (t: TestContext) => {
  const k = installKeychain(t, { backend: keyring.BackendKeychain, available: true });
  k.stored.set(keyring.AccountTursoToken, new Secret(loginFakeToken));

  const res = await runLogin(turso, '', {}, '--remove', '--yes', '--json');
  assert.equal(res.code, 0, res.stderr);
  const got = decodeLine(res);
  assert.equal(got['removed'], true);
  assert.equal(got['stored'], false);
  assert.equal(k.stored.has(keyring.AccountTursoToken), false, 'the entry survived --remove');
  assertNoToken(res);
});

test('login rejects sqlite as a usage error', async (t: TestContext) => {
  installKeychain(t, { backend: keyring.BackendKeychain, available: true });

  const res = await runLogin(turso, loginFakeToken + '\n', {}, '--provider', 'sqlite');
  assert.equal(res.code, exit.Usage, res.stderr);
  assert.ok(res.stderr.includes('needs no credential'), res.stderr);
  assertNoToken(res);
});

test('login rejects an unknown provider', async (t: TestContext) => {
  installKeychain(t, { backend: keyring.BackendKeychain, available: true });

  const res = await runLogin(turso, loginFakeToken + '\n', {}, '--provider', 'nosuchprovider');
  assert.equal(res.code, exit.Usage, res.stderr);
});

test('login with nothing on stdin is a usage error', async (t: TestContext) => {
  installKeychain(t, { backend: keyring.BackendKeychain, available: true });
  installTurso(t, {});

  const res = await runLogin(turso, '', {});
  assert.equal(res.code, exit.Usage, res.stderr);
  assert.ok(res.stderr.includes('never as a flag'), res.stderr);
});

test('login rejects --show and --remove together', async (t: TestContext) => {
  installKeychain(t, { backend: keyring.BackendKeychain, available: true });

  const res = await runLogin(turso, '', {}, '--show', '--remove');
  assert.equal(res.code, exit.Usage, res.stderr);
});

// The rule, guarded directly: a flag that takes a secret must not exist, so
// the obvious spelling must be rejected as unknown.
test('login has no --token flag', async (t: TestContext) => {
  installKeychain(t, { backend: keyring.BackendKeychain, available: true });

  const res = await runLogin(turso, '', {}, '--token', loginFakeToken);
  assert.notEqual(res.code, 0, '--token was accepted; there must be no flag that takes a secret');
  // An unknown flag is rejected by the dispatcher before this command runs,
  // so the code is the tree's existing one for a parse failure, not this
  // command's choice. What matters here is that the value is refused and
  // never echoed.
  assert.ok(res.stderr.includes('unknown flag'), res.stderr);
  assertNoToken(res);
});

// And the same for every other flag a careless edit might reach for: no flag
// on this command may be a string flag that a user would put a token in.
test('login declares no flag that could carry a secret', () => {
  const cmd = loginCommand(
    // The command's factory only stores the app; building the table needs no
    // environment, and nothing here runs the body.
    { providerName: '', configPath: '' } as unknown as Parameters<typeof loginCommand>[0],
  );
  const secretish = ['token', 'secret', 'password', 'key', 'api-token', 'api_token'];
  for (const name of Object.keys(cmd.flags ?? {})) {
    assert.ok(
      !secretish.includes(name),
      `\`tdo login\` declares --${name}, which would put a credential in argv`,
    );
  }
});

test('login renders a failure through the existing JSON envelope', async (t: TestContext) => {
  installKeychain(t, {
    backend: keyring.BackendKeychain,
    available: true,
    setErr: new Error('the keychain is locked'),
  });
  installTurso(t, {});

  const res = await runLogin(turso, loginFakeToken + '\n', {}, '--json');
  assert.equal(res.code, exit.Config, res.stdout);
  const envelope = decodeLine(res)['error'] as Record<string, unknown>;
  assert.equal(envelope['code'], exit.CodeConfig);
  assertNoToken(res);
});

// ---------------------------------------------------------------------------
// Delegation to the Turso CLI.
// ---------------------------------------------------------------------------

test('login falls back to stdin without the turso CLI', async (t: TestContext) => {
  installKeychain(t, { backend: keyring.BackendKeychain, available: true });
  const f = installTurso(t, {});

  const res = await runLogin(turso, loginFakeToken + '\n', {}, '--json');
  assert.equal(res.code, 0, res.stderr);
  const got = decodeLine(res);
  assert.equal(got['stored'], true);
  assert.equal(got['source'], providercli.SOURCE_STDIN);
  assert.ok(res.stderr.includes('turso auth login'), res.stderr);
  assert.deepEqual(f.created, [], 'an absent CLI minted a token');
  assertNoToken(res);
});

test('login exits 3 when the turso CLI is not logged in', async (t: TestContext) => {
  installKeychain(t, { backend: keyring.BackendKeychain, available: true });
  const f = installTurso(t, { installed: true });

  const res = await runLogin(turso, '', {}, '--json');
  assert.equal(res.code, exit.Config, `${res.stdout}\n${res.stderr}`);
  const envelope = decodeLine(res)['error'] as Record<string, unknown>;
  assert.equal(envelope['code'], exit.CodeConfig);
  assert.ok(String(envelope['message']).includes('turso auth login'), res.stdout);
  assert.deepEqual(f.created, [], 'a logged-out CLI minted a token');
  assertNoToken(res);
});

test('login mints and stores for the one database on the account', async (t: TestContext) => {
  const k = installKeychain(t, { backend: keyring.BackendKeychain, available: true });
  const f = installTurso(t, {
    installed: true,
    loggedIn: true,
    databases: ['my-tasks'],
    url: 'libsql://my-tasks-acme.turso.io',
  });

  const res = await runLogin(turso, '', {}, '--yes', '--json', '--no-save');
  assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
  const got = decodeLine(res);
  for (const [key, want] of Object.entries({
    provider: 'turso',
    account: keyring.AccountTursoToken,
    backend: keyring.BackendKeychain,
    stored: true,
    source: providercli.SOURCE_TURSO_CLI,
    database: 'my-tasks',
  })) {
    assert.equal(got[key], want, `${key} in ${res.stdout}`);
  }
  assert.deepEqual(f.created, ['my-tasks']);
  assert.equal(
    k.stored.get(keyring.AccountTursoToken)?.reveal(),
    fakeTursoToken,
    'the minted token was not stored',
  );
  // The URL hint is advice, so it belongs on stderr and nowhere else.
  assert.ok(res.stderr.includes('libsql://my-tasks-acme.turso.io'), res.stderr);
  assert.ok(!res.stdout.includes('libsql://'), res.stdout);
  assertNoToken(res);
});

test('login refuses to guess among three databases', async (t: TestContext) => {
  installKeychain(t, { backend: keyring.BackendKeychain, available: true });
  const f = installTurso(t, {
    installed: true,
    loggedIn: true,
    databases: ['one', 'two', 'three'],
  });

  const res = await runLogin(turso, '', {}, '--yes');
  assert.equal(res.code, exit.Usage, res.stderr);
  assert.ok(res.stderr.includes('--database'), res.stderr);
  assert.deepEqual(f.created, [], 'a token was minted for a guess');
  assertNoToken(res);
});

test('login mints for the database --database names', async (t: TestContext) => {
  installKeychain(t, { backend: keyring.BackendKeychain, available: true });
  const f = installTurso(t, {
    installed: true,
    loggedIn: true,
    databases: ['one', 'two', 'three'],
    urlErr: true,
  });

  const res = await runLogin(turso, '', {}, '--json', '--yes', '--database', 'two');
  assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
  assert.equal(decodeLine(res)['database'], 'two');
  assert.deepEqual(f.created, ['two']);
  // `turso db show` failed, so the hint is skipped rather than reported.
  assert.ok(!res.stderr.includes('[turso]'), res.stderr);
  assertNoToken(res);
});

// The middle resolution step: the name comes from the URL, with no list call
// at all — the fake refuses `db list` to prove it.
test('login resolves the database from the configured URL', async (t: TestContext) => {
  installKeychain(t, { backend: keyring.BackendKeychain, available: true });
  const f = installTurso(t, {
    installed: true,
    loggedIn: true,
    listErr: true,
    url: 'libsql://my-tasks-acme.turso.io',
  });

  const res = await runLogin(
    { TODOCLOUD_PROVIDER: 'turso', TODOCLOUD_TURSO_URL: 'libsql://my-tasks-acme.turso.io' },
    '',
    {},
    '--yes',
    '--json',
    '--no-save',
  );
  assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
  assert.equal(decodeLine(res)['database'], 'my-tasks');
  assert.deepEqual(f.created, ['my-tasks']);
  assertNoToken(res);
});

// A hostname whose dash split is uncertain is matched against the list.
test('login matches an ambiguous URL against the list', async (t: TestContext) => {
  installKeychain(t, { backend: keyring.BackendKeychain, available: true });
  const f = installTurso(t, {
    installed: true,
    loggedIn: true,
    databases: ['todo', 'notes'],
    url: 'libsql://todo.turso.io',
  });

  const res = await runLogin(
    { TODOCLOUD_PROVIDER: 'turso', TODOCLOUD_TURSO_URL: 'libsql://todo.turso.io' },
    '',
    {},
    '--yes',
    '--json',
    '--no-save',
  );
  assert.equal(res.code, 0, res.stderr);
  assert.equal(decodeLine(res)['database'], 'todo');
  assert.deepEqual(f.created, ['todo']);
  assertNoToken(res);
});

// The rule that matters most here: a token we cannot store safely is dropped,
// never printed.
test('login discards a minted token it cannot store', async (t: TestContext) => {
  installKeychain(t, {
    backend: keyring.BackendKeychain,
    available: true,
    setErr: keyring.ErrWriteUnsupported,
  });
  installTurso(t, {
    installed: true,
    loggedIn: true,
    databases: ['my-tasks'],
    url: 'libsql://my-tasks-acme.turso.io',
  });

  const res = await runLogin(turso, '', {}, '--yes', '--json', '--no-save');
  assert.equal(res.code, 0, res.stderr);
  const got = decodeLine(res);
  assert.equal(got['stored'], false);
  assert.equal(got['backend'], keyring.BackendNone);
  assert.equal(got['source'], providercli.SOURCE_TURSO_CLI);
  assert.ok(
    String(got['instructions']).includes('turso db tokens create my-tasks'),
    String(got['instructions']),
  );
  assertNoToken(res);

  // And the same without --json, where a careless implementation would print
  // the token for the user to copy.
  const human = await runLogin(turso, '', {}, '--yes', '--no-save');
  assert.equal(human.code, 0, human.stderr);
  assert.ok(human.stderr.includes('discarded'), human.stderr);
  assertNoToken(human);
});

test('login reports a failed mint without the token', async (t: TestContext) => {
  installKeychain(t, { backend: keyring.BackendKeychain, available: true });
  installTurso(t, {
    installed: true,
    loggedIn: true,
    databases: ['my-tasks'],
    createErr: 'quota exceeded',
  });

  const res = await runLogin(turso, '', {}, '--yes');
  assert.equal(res.code, exit.Config, res.stderr);
  assert.ok(res.stderr.includes('quota exceeded'), `the child's stderr was dropped: ${res.stderr}`);
  assertNoToken(res);
});

// A config that still names firestore gets told what happened. The provider
// was built and removed (PLAN.md §2), so "unknown provider" would be both
// unhelpful and untrue, and promising a later version would be a lie. Exit 3,
// the config code — one cause reported two ways is a trap for a caller that
// branches on the exit code.
test('login says so for the removed firestore provider', async (t: TestContext) => {
  installKeychain(t, { backend: keyring.BackendKeychain, available: true });

  const res = await runLogin({ TODOCLOUD_PROVIDER: 'firestore' }, '', {}, '--json');
  assert.equal(res.code, exit.Config, `${res.stdout}\n${res.stderr}`);
  for (const want of ['removed', 'docs/providers.md']) {
    assert.ok(res.stdout.includes(want), `${want} is missing from ${res.stdout}`);
  }
});

// SECURITY.md's warning, and also that no provider CLI is consulted for D1 —
// wrangler must never run (CLAUDE.md §1.4).
test('login warns about the account-wide D1 token', async (t: TestContext) => {
  installKeychain(t, { backend: keyring.BackendKeychain, available: true });
  const f = installTurso(t, { installed: true, loggedIn: true, databases: ['x'] });

  const res = await runLogin(
    { TODOCLOUD_PROVIDER: 'd1' },
    loginFakeToken + '\n',
    {},
    '--json',
  );
  assert.equal(res.code, 0, res.stderr);
  const got = decodeLine(res);
  assert.equal(got['stored'], true);
  assert.equal(got['account'], keyring.AccountD1Token);
  // Every stored token reports its source, so a caller does not have to know
  // which providers support CLI delegation to read the shape.
  assert.equal(got['source'], providercli.SOURCE_STDIN);
  assert.ok(res.stderr.includes('every D1 database'), res.stderr);
  assert.ok(!res.stderr.toLowerCase().includes('wrangler'), res.stderr);
  assert.deepEqual(f.created, [], 'd1 reached the turso CLI');
  assertNoToken(res);
});

test('login rejects --database for another provider', async (t: TestContext) => {
  installKeychain(t, { backend: keyring.BackendKeychain, available: true });

  const res = await runLogin({ TODOCLOUD_PROVIDER: 'd1' }, '', {}, '--database', 'x');
  assert.equal(res.code, exit.Usage, res.stderr);
  assert.ok(res.stderr.includes('turso provider only'), res.stderr);
});

// The shapes that must not change: --show and --remove never consult a
// provider CLI.
test('login --show and --remove are unaffected by delegation', async (t: TestContext) => {
  const k = installKeychain(t, { backend: keyring.BackendKeychain, available: true });
  k.stored.set(keyring.AccountTursoToken, new Secret(loginFakeToken));
  const f = installTurso(t, { installed: true, loggedIn: true, databases: ['my-tasks'] });

  const show = await runLogin(turso, '', {}, '--show', '--json');
  const got = decodeLine(show);
  assert.equal(got['present'], true);
  assert.equal(Object.hasOwn(got, 'database'), false, '--show gained a database key');

  const remove = await runLogin(turso, '', {}, '--remove', '--yes', '--json');
  assert.equal(decodeLine(remove)['removed'], true);
  assert.deepEqual(f.created, [], '--show/--remove reached the turso CLI');
  assertNoToken(show);
  assertNoToken(remove);
});

// ---------------------------------------------------------------------------
// The two confirmations.
// ---------------------------------------------------------------------------

test('login --remove without a terminal refuses instead of deleting', async (t: TestContext) => {
  const k = installKeychain(t, { backend: keyring.BackendKeychain, available: true });
  k.stored.set(keyring.AccountTursoToken, new Secret(loginFakeToken));

  const res = await runLogin(turso, '', {}, '--remove');
  assert.equal(res.code, exit.Usage, res.stderr);
  assert.ok(res.stderr.includes('refusing to delete the stored turso token'), res.stderr);
  assert.ok(res.stderr.includes('--yes'), res.stderr);
  assert.ok(
    k.stored.has(keyring.AccountTursoToken),
    'the entry was deleted despite the refusal',
  );
  assertNoToken(res);
});

test('login --remove declined on a terminal deletes nothing', async (t: TestContext) => {
  const k = installKeychain(t, { backend: keyring.BackendKeychain, available: true });
  k.stored.set(keyring.AccountTursoToken, new Secret(loginFakeToken));

  const res = await runLogin(turso, 'n\n', { terminal: true }, '--remove', '--json');
  assert.equal(res.code, 0, `declining is not a failure: ${res.stderr}`);
  const got = decodeLine(res);
  assert.equal(got['removed'], false);
  assert.equal(got['stored'], true);
  assert.ok(
    k.stored.has(keyring.AccountTursoToken),
    'the entry was deleted after the prompt was declined',
  );
  // The prompt itself belongs on stderr, so stdout stays one JSON value.
  assert.ok(res.stderr.includes('It cannot be recovered.'), res.stderr);
  assertNoToken(res);
});

test('login refuses to mint without a terminal, and calls no turso', async (t: TestContext) => {
  const k = installKeychain(t, { backend: keyring.BackendKeychain, available: true });
  const f = installTurso(t, {
    installed: true,
    loggedIn: true,
    databases: ['example'],
    url: 'libsql://example.turso.io',
  });

  // A token on stdin must not be read as a fallback: that would store a
  // different credential than the caller asked for.
  const res = await runLogin(turso, loginFakeToken + '\n', {});
  assert.equal(res.code, exit.Usage, res.stderr);
  assert.ok(
    res.stderr.includes('refusing to mint a new turso token for database "example"'),
    res.stderr,
  );
  assert.ok(res.stderr.includes('--yes'), res.stderr);
  assert.deepEqual(f.created, [], 'the turso CLI was asked to mint a token');
  assert.equal(k.stored.size, 0, 'something was stored despite the refusal');
  assertNoToken(res);
});

test('login declined on a terminal mints nothing', async (t: TestContext) => {
  const k = installKeychain(t, { backend: keyring.BackendKeychain, available: true });
  const f = installTurso(t, {
    installed: true,
    loggedIn: true,
    databases: ['example'],
    url: 'libsql://example.turso.io',
  });

  const res = await runLogin(turso, 'n\n', { terminal: true }, '--json');
  assert.equal(res.code, 0, `declining is not a failure: ${res.stderr}`);
  const got = decodeLine(res);
  for (const [key, want] of Object.entries({
    provider: 'turso',
    account: keyring.AccountTursoToken,
    backend: keyring.BackendKeychain,
    stored: false,
    source: providercli.SOURCE_TURSO_CLI,
    database: 'example',
  })) {
    assert.equal(got[key], want, `${key} in ${res.stdout}`);
  }
  assert.deepEqual(f.created, [], 'a token was minted after the prompt was declined');
  assert.equal(k.stored.size, 0, 'something was stored after the prompt was declined');
  assert.ok(res.stderr.includes('no token was created on your Turso account'), res.stderr);
  assertNoToken(res);
});

// A token typed at a terminal is read from stdin like any other, and the
// prompt that asks for it goes to stderr so that stdout stays machine output.
test('login prompts on stderr and keeps stdout clean on a terminal', async (t: TestContext) => {
  const k = installKeychain(t, { backend: keyring.BackendKeychain, available: true });
  installTurso(t, {});

  const res = await runLogin(
    { TODOCLOUD_PROVIDER: 'd1' },
    loginFakeToken + '\n',
    { terminal: true },
    '--json',
  );
  assert.equal(res.code, 0, res.stderr);
  assert.equal(decodeLine(res)['stored'], true);
  assert.ok(res.stderr.includes('not echoed'), res.stderr);
  assert.equal(k.stored.get(keyring.AccountD1Token)?.reveal(), loginFakeToken);
  assertNoToken(res);
});
