// `tdo version`, `init`, `migrate`, `config`, `config set` and `doctor`.
//
// Ported from config_write_test.go (everything but its two `tdo login`
// tests, which are in login.test.ts), doctor_nocreate_test.go, the
// administrative half of schema_mismatch_test.go, and the two doctor cases of
// login_test.go.
//
// Nothing here reaches the developer's own configuration: every environment
// is injected and every XDG path is under a temporary directory.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';

import * as exit from '@todocloud/core/exit';
import * as providercli from '@todocloud/core/providercli';
import { Secret } from '@todocloud/core/secret';
import * as schema from '@todocloud/core/store/schema';
import { DatabaseSync } from 'node:sqlite';

import {
  configCommand,
  doctorCommand,
  initCommand,
  migrateCommand,
  providerCLICheck,
  versionCommand,
  forTest as adminForTest,
} from './admin.ts';
import { App, type Env, RunWith } from './app.ts';
import { forTest as loginForTest } from './login.ts';
import { type Harness, newHarness, buffer, type Result } from './testsupport.ts';

/** The five administrative commands. */
const admin = [versionCommand, initCommand, migrateCommand, configCommand, doctorCommand];

function harness(t: TestContext): Promise<Harness> {
  return newHarness(t, admin);
}

/**
 * configEnv is a complete, fake environment whose XDG config home is a fresh
 * temporary directory. No test in this file can reach the developer's own
 * config file: every path it writes is under a temporary directory of its
 * own.
 */
function configEnv(
  t: TestContext,
  extra: Record<string, string> = {},
): { env: Record<string, string>; path: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tdo-admin-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const xdg = path.join(home, '.config');
  return {
    env: { HOME: home, XDG_CONFIG_HOME: xdg, ...extra },
    path: path.join(xdg, 'todocloud', 'config.toml'),
  };
}

/** runIn drives the administrative commands against env, with stdin piped. */
async function runIn(
  env: Record<string, string>,
  stdin: string,
  ...args: string[]
): Promise<Result> {
  const out = new buffer();
  const err = new buffer();
  const injected: Env = {
    stdout: out,
    stderr: err,
    stdin: { read: (): Promise<string> => Promise.resolve(stdin) },
    getenv: (key: string): string => env[key] ?? '',
    stdinIsTTY: (): boolean => false,
    keyring: () => ({ value: new Secret(''), present: false }),
  };
  const code = await RunWith(injected, ['tdo', ...args], admin);
  return { code, stdout: out.text, stderr: err.text };
}

/**
 * installNoTurso makes the turso CLI unreachable, so that a developer who
 * happens to have it installed does not have their own credentials driven by
 * these tests (CLAUDE.md §1.5).
 */
function installNoTurso(t: TestContext): void {
  t.after(
    loginForTest.installProviderCLI({
      lookPath: (file: string): string => {
        throw new Error(`${file} is not installed`);
      },
      runner: (): providercli.Output => {
        throw new Error('a test reached a real provider CLI');
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// version
// ---------------------------------------------------------------------------

test('version names the binary and the runtime', async (t: TestContext) => {
  const h = await harness(t);
  // The engine is read from the runtime actually running this suite, not
  // hardcoded: it runs under both Node and Bun, and Bun reports a Node
  // version in `process.versions.node`, so pinning `node` would have passed
  // there for the wrong reason — which is exactly what it did until the
  // runtime string started naming the engine first.
  const bun = process.versions['bun'];
  const engine = bun !== undefined && bun !== '' ? `bun ${bun}` : `node ${process.versions.node}`;
  const literal = engine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const human = await h.mustRun('version');
  assert.match(human.stdout, new RegExp(`^tdo \\S+ \\(${literal}`));

  const obj = h.decode(await h.mustRun('version', '--json'));
  assert.ok(String(obj['version']).length > 0);
  assert.equal(typeof obj['commit'], 'string');
  assert.match(String(obj['runtime']), new RegExp(`^${literal}`));
});

// The version comes from this package's own manifest, which is where a Node
// package's version lives. It used to come from TODOCLOUD_VERSION with a
// hardcoded fallback, which the release had to fake twice over — by rewriting
// the SEA's boot shim and by regex-patching the emitted admin.js. Asserting
// the manifest is the source is what keeps either from coming back.
test('version reads this package manifest, and TODOCLOUD_VERSION overrides it', (t: TestContext) => {
  const manifest = JSON.parse(fs.readFileSync(adminForTest.manifestPath, 'utf8')) as {
    version: string;
  };
  const had = process.env['TODOCLOUD_VERSION'];
  t.after(() => {
    if (had === undefined) delete process.env['TODOCLOUD_VERSION'];
    else process.env['TODOCLOUD_VERSION'] = had;
  });

  delete process.env['TODOCLOUD_VERSION'];
  assert.equal(adminForTest.readVersion(), manifest.version);

  // An obviously fake value: this asserts the precedence, not a release.
  process.env['TODOCLOUD_VERSION'] = '9.9.9-forced';
  assert.equal(adminForTest.readVersion(), '9.9.9-forced');

  // An empty variable is not an override. `FOO= tdo version` is a mistake,
  // not a request to report the empty string as this binary's version.
  process.env['TODOCLOUD_VERSION'] = '';
  assert.equal(adminForTest.readVersion(), manifest.version);
});

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

test('init creates the store, and says so only the first time', async (t: TestContext) => {
  const h = await harness(t);
  // The harness already created the schema, so a fresh path is used here.
  const fresh = path.join(h.dir, 'nested', 'fresh.db');
  h.env['TODOCLOUD_SQLITE_PATH'] = fresh;

  const first = h.decode(await h.mustRun('init', '--json'));
  assert.equal(first['created'], true);
  assert.equal(first['initialized'], true);
  assert.equal(first['schema_version'], schema.Version);
  assert.equal(first['provider'], 'sqlite');

  // init is idempotent, and afterwards the store looks the same either way:
  // "I just made an empty list" is not "the list was already here".
  const second = h.decode(await h.mustRun('init', '--json'));
  assert.equal(second['created'], false);
  assert.equal(second['initialized'], true);

  const human = await h.mustRun('init');
  assert.match(human.stdout, /already initialized at schema version/);
});

// ---------------------------------------------------------------------------
// migrate
// ---------------------------------------------------------------------------

test('migrate on an up-to-date store reports the version and changes nothing', async (t: TestContext) => {
  const h = await harness(t);
  const obj = h.decode(await h.mustRun('migrate', '--json'));
  assert.equal(obj['from'], schema.Version);
  assert.equal(obj['to'], schema.Version);
  assert.equal(obj['migrated'], false);
  // The keys are always present, so a caller never branches on their absence.
  assert.equal(obj['backup_path'], '');
  assert.deepEqual(obj['steps'], []);

  const human = await h.mustRun('migrate');
  assert.match(human.stdout, /already at schema version/);
});

// The store is opened unchecked: a version this binary refuses to read is
// exactly the state this command is here to fix. A local provider can be
// backed up, so there is nothing to confirm.
test('migrate upgrades a store written by an older tdo', async (t: TestContext) => {
  const h = await harness(t);
  const older = schema.Version - 1;
  // The version marker is written down to the older one, which is what an
  // older binary would have left behind. It is done with the driver rather
  // than through a command, because no command may record a version it does
  // not write.
  const db = new DatabaseSync(h.db);
  try {
    db.prepare(`UPDATE meta SET value = ? WHERE key = ?`).run(
      BigInt(older),
      schema.MetaKey,
    );
  } finally {
    db.close();
  }

  const obj = h.decode(await h.mustRun('migrate', '--json'));
  assert.equal(obj['from'], older);
  assert.equal(obj['to'], schema.Version);
  assert.equal(obj['migrated'], true);
  assert.deepEqual(obj['steps'], schema.pending(older).map((step) => step.name));
  // A local store can be backed up, so there is nothing to confirm — and the
  // path is printed while the data is still as it was.
  assert.ok(String(obj['backup_path']).length > 0, 'a local store is backed up first');
  assert.ok(fs.existsSync(String(obj['backup_path'])), 'the backup it named is not there');
});

// A store written by a newer binary is exit 3 with the advice that applies:
// upgrade tdo, because this one cannot know what the newer schema means.
test('migrate refuses a store from the future', async (t: TestContext) => {
  const h = await harness(t);
  const db = new DatabaseSync(h.db);
  try {
    db.prepare(`UPDATE meta SET value = ? WHERE key = ?`).run(
      BigInt(schema.Version + 1),
      schema.MetaKey,
    );
  } finally {
    db.close();
  }

  const res = await h.run('migrate', '--json');
  assert.equal(res.code, exit.Config, `${res.stdout}${res.stderr}`);
  assert.match(res.stdout, /upgrade tdo/);
});

// ---------------------------------------------------------------------------
// config, and config set
// ---------------------------------------------------------------------------

test('config set creates the file and the next command reads what it wrote', async (t: TestContext) => {
  const { env, path: file } = configEnv(t);

  const res = await runIn(env, '', 'config', 'set', 'turso.url', 'libsql://example.turso.io');
  assert.equal(res.code, 0, `${res.stdout}${res.stderr}`);
  assert.match(res.stdout, /\(added\)/);
  assert.ok(fs.readFileSync(file, 'utf8').includes('libsql://example.turso.io'));
  // Mode 0600: a config file is the one place a token may ever live.
  //
  // Not a question Windows can answer: it has no POSIX mode, reports 0666 for
  // anything that is not read-only, and the protection there is the ACL on
  // the user's profile directory. The other permission assertions in this
  // tree are guarded the same way (`config.test.ts`, `shortref.test.ts`).
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }

  // Setting it again changes nothing and says so.
  const again = await runIn(env, '', 'config', 'set', 'turso.url', 'libsql://example.turso.io');
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /already set to/);
});

test('config set --json reports the file and every change', async (t: TestContext) => {
  const { env, path: file } = configEnv(t);

  const res = await runIn(env, '', 'config', 'set', 'provider', 'turso', '--json');
  assert.equal(res.code, 0, res.stderr);
  const obj: Record<string, unknown> = JSON.parse(res.stdout.trim());
  assert.equal(obj['config_file'], file);
  assert.equal(obj['created'], true);
  assert.equal(obj['wrote'], true);
  const changes = obj['changes'] as Record<string, unknown>[];
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.['key'], 'provider');
  assert.equal(changes[0]?.['value'], 'turso');
  assert.equal(changes[0]?.['added'], true);
  assert.equal(changes[0]?.['changed'], true);
  assert.equal(changes[0]?.['previous'], '');
});

// A token belongs in the OS keychain where `tdo login` puts it. The refusal
// is exit 2 — the user's mistake at the command line — and it names the
// command that does the right thing.
test('config set refuses a token and points at login', async (t: TestContext) => {
  const { env, path: file } = configEnv(t);

  for (const key of ['turso.token', 'd1.api_token', 'turso.secret', 'd1.password']) {
    const res = await runIn(env, '', 'config', 'set', key, 'TOKEN_GOES_HERE');
    assert.equal(res.code, exit.Usage, `${key}: exit ${res.code}\n${res.stderr}`);
    assert.match(res.stderr, /tdo login/);
    // And the value must not have been written anywhere.
    assert.ok(!res.stdout.includes('TOKEN_GOES_HERE'), res.stdout);
    assert.ok(!fs.existsSync(file), 'a refused write created the config file');
  }
});

test('config with no arguments prints the resolved configuration', async (t: TestContext) => {
  const { env } = configEnv(t, { TODOCLOUD_PROVIDER: 'sqlite' });
  installNoTurso(t);

  const human = await runIn(env, '', 'config');
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /^config_file = /m);
  assert.match(human.stdout, /^provider = sqlite$/m);

  const obj: Record<string, unknown> = JSON.parse(
    (await runIn(env, '', 'config', '--json')).stdout.trim(),
  );
  assert.equal(obj['provider'], 'sqlite');
  // Describe is redacted by construction: a token appears only as a hint.
  const turso = obj['turso'] as Record<string, unknown>;
  assert.equal(turso['token_present'], false);
  assert.equal(turso['token'], '');
});

// A token reaching `tdo config` output would be a leak wherever that output
// lands — a scrollback, a screenshot, an issue — and the docs promise the
// output is safe to paste.
test('config never prints a token it resolved', async (t: TestContext) => {
  const fake = 'FAKE-TOKEN-not-a-real-credential-wxyz';
  const { env } = configEnv(t, {
    TODOCLOUD_PROVIDER: 'turso',
    TODOCLOUD_TURSO_URL: 'libsql://example.turso.io',
    TODOCLOUD_TURSO_TOKEN: fake,
  });
  installNoTurso(t);

  for (const args of [['config'], ['config', '--json']]) {
    const res = await runIn(env, '', ...args);
    assert.equal(res.code, 0, res.stderr);
    assert.ok(!res.stdout.includes(fake), `the token reached stdout: ${res.stdout}`);
    assert.ok(!res.stderr.includes(fake), `the token reached stderr: ${res.stderr}`);
    assert.match(res.stdout, /\[REDACTED\]#/);
  }
});

// The same under --debug, which is held to the same standard as normal
// output (CLAUDE.md §1.7).
test('--debug output carries no token either', async (t: TestContext) => {
  const fake = 'FAKE-TOKEN-not-a-real-credential-wxyz';
  const { env } = configEnv(t, {
    TODOCLOUD_PROVIDER: 'turso',
    TODOCLOUD_TURSO_URL: 'libsql://example.turso.io',
    TODOCLOUD_TURSO_TOKEN: fake,
  });
  installNoTurso(t);

  const res = await runIn(env, '', 'config', '--debug');
  assert.ok(!res.stdout.includes(fake), res.stdout);
  assert.ok(!res.stderr.includes(fake), res.stderr);
});

// A command that takes no arguments must say so rather than discard them, and
// `init`'s guard has to run before the store is created.
test('an argumentless command refuses a stray argument', async (t: TestContext) => {
  for (const args of [
    ['config', 'junk'],
    ['doctor', 'junk'],
    ['version', 'junk'],
    ['init', 'junk'],
    ['migrate', 'junk'],
  ]) {
    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdo-stray-'));
    const db = path.join(dbDir, 'tasks.db');
    const { env, path: file } = configEnv(t, {
      TODOCLOUD_PROVIDER: 'sqlite',
      TODOCLOUD_SQLITE_PATH: db,
    });
    installNoTurso(t);
    const res = await runIn(env, '', ...args);
    assert.equal(
      res.code,
      exit.Usage,
      `${args.join(' ')}: exit ${res.code}\n${res.stdout}${res.stderr}`,
    );
    assert.ok(!fs.existsSync(file), `${args.join(' ')} wrote the config file`);
    assert.ok(!fs.existsSync(db), `${args.join(' ')} created the store`);
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

test('doctor reports a healthy store and exits 0', async (t: TestContext) => {
  const h = await harness(t);
  installNoTurso(t);

  const res = await h.mustRun('doctor', '--json');
  const obj = h.decode(res);
  assert.equal(obj['ok'], true, res.stdout);
  assert.equal(obj['from'], schema.Version);
  assert.equal(obj['to'], schema.Version);
  // Planning a migration takes the backup, and a diagnostic must write
  // nothing — so this key is always empty here.
  assert.equal(obj['backup_path'], '');
  assert.deepEqual(obj['steps'], []);
  const names = (obj['checks'] as Record<string, unknown>[]).map((c) => c['name']);
  assert.deepEqual(names, ['config', 'provider', 'provider_cli', 'database_directory', 'ping', 'schema']);
});

// `tdo doctor` is a diagnostic. A diagnostic that leaves a directory behind is
// how a mistyped path quietly becomes real, which matters most when an agent
// is running the command to find out what is wrong.
test('doctor creates nothing', async (t: TestContext) => {
  const h = await harness(t);
  installNoTurso(t);
  const missing = path.join(h.dir, 'typo', 'deeper', 'tasks.db');
  h.env['TODOCLOUD_SQLITE_PATH'] = missing;

  const got = await h.run('doctor', '--json');
  assert.equal(got.code, exit.Error, 'an uninitialized store is a failed check');
  const report = h.decode(got);

  for (const leftover of [
    path.join(h.dir, 'typo'),
    path.join(h.dir, 'typo', 'deeper'),
    missing,
  ]) {
    assert.equal(fs.existsSync(leftover), false, `doctor created ${leftover}`);
  }

  // The report must still be useful: the directory check passes, saying the
  // path is writable and that init would create it, and the store itself is
  // reported as uninitialised rather than as a mystery.
  const checks = report['checks'] as Record<string, unknown>[];
  const detail = (name: string): string =>
    String(checks.find((c) => c['name'] === name)?.['detail'] ?? '');
  assert.equal(
    checks.find((c) => c['name'] === 'database_directory')?.['ok'],
    true,
    detail('database_directory'),
  );
  assert.match(detail('database_directory'), /tdo init/);
  assert.match(detail('ping'), /init/);
});

// The report is the output; an error envelope on top of it would contradict
// the documented shape, so only the exit code carries the failure.
test('a failed doctor writes the report, not an error envelope', async (t: TestContext) => {
  const h = await harness(t);
  installNoTurso(t);
  h.env['TODOCLOUD_SQLITE_PATH'] = path.join(h.dir, 'absent', 'tasks.db');

  const got = await h.run('doctor', '--json');
  assert.equal(got.code, exit.Error, got.stderr);
  const report = h.decode(got);
  assert.equal(report['ok'], false);
  assert.equal(Object.hasOwn(report, 'error'), false, got.stdout);
});

test('doctor reports a provider that is not implemented', async (t: TestContext) => {
  const h = await harness(t);
  h.env['TODOCLOUD_PROVIDER'] = 'firestore';

  const got = await h.run('doctor', '--json');
  assert.equal(got.code, exit.Error, got.stderr);
  const report = h.decode(got);
  // The config check fails first here: Validate refuses a removed provider,
  // which is the same answer every other command gives for it.
  assert.equal(report['ok'], false);
  assert.ok(got.stdout.includes('firestore'), got.stdout);
});

test('doctor reports a missing turso token without printing one', async (t: TestContext) => {
  const h = await harness(t);
  installNoTurso(t);
  h.env['TODOCLOUD_PROVIDER'] = 'turso';
  h.env['TODOCLOUD_TURSO_URL'] = 'libsql://example.turso.io';

  const got = await h.run('doctor', '--json');
  // Validate refuses a provider with no token, and diagnose turns that into
  // the first failed check rather than an error envelope: the report is the
  // output, and only the exit code carries the failure.
  assert.equal(got.code, exit.Error, got.stdout);
  const report = h.decode(got);
  assert.equal(report['ok'], false);
  assert.match(got.stdout, /TODOCLOUD_TURSO_TOKEN/);
  // And the advice names the keychain, never a token.
  assert.ok(!got.stdout.includes('[REDACTED]#'), got.stdout);
});

// The provider CLI check, driven directly, as Go's two doctor tests did.
test('the turso provider_cli check in its three states', async (t: TestContext) => {
  const cases: {
    name: string;
    installed: boolean;
    loggedIn: boolean;
    ok: boolean;
    parts: string[];
  }[] = [
    {
      name: 'not installed',
      installed: false,
      loggedIn: false,
      ok: false,
      parts: ['not installed', 'turso auth login'],
    },
    {
      name: 'not logged in',
      installed: true,
      loggedIn: false,
      ok: false,
      parts: ['not logged in'],
    },
    {
      name: 'logged in',
      installed: true,
      loggedIn: true,
      ok: true,
      parts: ['installed and logged in'],
    },
  ];
  for (const c of cases) {
    const restore = loginForTest.installProviderCLI({
      lookPath: (file: string): string => {
        if (c.installed) {
          return `/fake/bin/${file}`;
        }
        throw new Error(`${file} is not installed`);
      },
      runner: (): providercli.Output =>
        c.loggedIn
          ? { stdout: 'a-session-token', stderr: '' }
          : { stdout: '', stderr: '', err: new providercli.ExitError(1) },
    });
    try {
      const check = await providerCLICheck('turso');
      assert.equal(check.name, 'provider_cli', c.name);
      assert.equal(check.ok, c.ok, `${c.name}: ${check.detail}`);
      for (const part of c.parts) {
        assert.ok(check.detail.includes(part), `${c.name}: ${check.detail}`);
      }
      // A session token prints a credential on success, so its stdout is
      // never read into the detail.
      assert.ok(!check.detail.includes('a-session-token'), check.detail);
    } finally {
      restore();
    }
  }
});

// CLAUDE.md §1.4: wrangler is never run, and never suggested.
test('the other providers involve no provider CLI, and never wrangler', async () => {
  for (const provider of ['d1', 'sqlite', 'firestore']) {
    const check = await providerCLICheck(provider);
    assert.equal(check.ok, true, provider);
    assert.ok(check.detail.includes('no provider CLI is involved'), check.detail);
    assert.ok(!check.detail.toLowerCase().includes('wrangler'), check.detail);
  }
});

// A migration cannot be undone, so `migrate` takes a backup first. A provider
// that cannot copy the data aside gets the `tdo rm --purge` treatment instead:
// prompt a user, refuse a script. This is the case Go reached by handing
// `a.migrate` a wrapper that hid the Backupper interface; `admin.ts` exposes
// `migrate` through `forTest` for the same reason, because the real command
// opens the store through the configured provider, which always backs up.
test('migrating a store that cannot be backed up refuses without a terminal', async (t: TestContext) => {
  const h = await harness(t);

  // Put the store one version behind, so there is a migration to refuse.
  const db = new DatabaseSync(h.db);
  try {
    db.prepare(`UPDATE meta SET value = ? WHERE key = ?`).run(
      BigInt(schema.Version - 1),
      schema.MetaKey,
    );
  } finally {
    db.close();
  }

  const out = new buffer();
  const errb = new buffer();
  const a = new App({
    stdout: out,
    stderr: errb,
    // h.env is the variable map, not an Env; read through it the way the
    // harness's own runs do.
    getenv: (name: string): string => h.env[name] ?? '',
    // The point of the test: no terminal to confirm at.
    stdinIsTTY: (): boolean => false,
  });

  await h.withStore(async (st) => {
    // A store with no backupForMigration, which is what a remote provider
    // without VACUUM INTO looks like to `migrate`.
    const unbackupable = Object.create(
      Object.getPrototypeOf(st) as object,
    ) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(st as object)) {
      Object.defineProperty(
        unbackupable,
        key,
        Object.getOwnPropertyDescriptor(st as object, key)!,
      );
    }
    unbackupable['backupForMigration'] = undefined;

    await assert.rejects(
      () => adminForTest.migrate(a, unbackupable as never, false),
      (err: Error) => {
        const message = String(err.message);
        assert.equal(exit.classify(err).code, exit.Usage, message);
        assert.match(message, /refusing to migrate/);
        assert.match(message, /without a terminal/);
        assert.match(message, /pass --yes/);
        return true;
      },
    );
  });

  // Nothing was asked and nothing was written.
  assert.equal(out.text, '', `stdout should stay empty: ${out.text}`);
  assert.doesNotMatch(errb.text, /Migrate .* from schema version/);
});
