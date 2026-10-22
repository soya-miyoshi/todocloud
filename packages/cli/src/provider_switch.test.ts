// The port of internal/cli/provider_switch_test.go.
//
// Writing to a store the config file does not name is the failure mode that
// matters when a provider can be switched: nothing is lost, but it lands
// somewhere the user is not looking. These tests drive the real `tdo ls` and
// `tdo add` against a real config file, so the interaction between the file,
// the environment and `--provider` is exercised the way a user meets it.
//
// app.test.ts has the same notice against a fake command table; this file is
// the matrix of where the provider came from, which is what decides whether
// there is a notice at all.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';

import { Secret } from '@todocloud/core/secret';

import { type Env, RunWith } from './app.ts';
import type { Entry } from './keyring.ts';
import { type Result, buffer } from './testsupport.ts';

/**
 * runWithConfig runs the CLI against a temporary store described by a real
 * config file. The store is created with `tdo init` first, as a user would.
 */
async function runWithConfig(
  t: TestContext,
  fileProvider: string,
  extra: Record<string, string>,
  ...args: string[]
): Promise<Result> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdo-switch-'));
  const state = path.join(dir, 'state');
  const cfgPath = path.join(dir, 'config.toml');
  fs.writeFileSync(cfgPath, `provider = "${fileProvider}"\n`, { mode: 0o600 });

  const env: Record<string, string> = {
    TODOCLOUD_CONFIG: cfgPath,
    TODOCLOUD_SQLITE_PATH: path.join(dir, 'tasks.db'),
    TODOCLOUD_STATE_DIR: state,
    HOME: dir,
    ...extra,
  };

  // shortref reads the state directory from the process environment, so it
  // has to be redirected there as well as in the injected one.
  const previous = process.env['TODOCLOUD_STATE_DIR'];
  process.env['TODOCLOUD_STATE_DIR'] = state;
  t.after(() => {
    if (previous === undefined) {
      delete process.env['TODOCLOUD_STATE_DIR'];
    } else {
      process.env['TODOCLOUD_STATE_DIR'] = previous;
    }
    // Windows refuses to remove a file that still has a handle open, and a
    // SQLite handle can outlive the store that owned it for a moment. POSIX
    // never notices. Retry, and on Windows only, leave the directory behind
    // rather than fail a green test in its own teardown (see testsupport.ts).
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch (err) {
      if (process.platform !== 'win32') {
        throw err;
      }
    }
  });

  const run = async (...argv: string[]): Promise<Result> => {
    const out = new buffer();
    const err = new buffer();
    const injected: Env = {
      stdout: out,
      stderr: err,
      stdin: { read: (): Promise<string> => Promise.resolve('') },
      getenv: (key: string): string => env[key] ?? '',
      stdinIsTTY: (): boolean => false,
      // A turso or d1 provider in the file must not send the configuration to
      // the developer's real keychain (CLAUDE.md §1.5).
      keyring: (): Entry => ({ value: new Secret(''), present: false }),
    };
    const code = await RunWith(injected, ['tdo', ...argv]);
    return { code, stdout: out.text, stderr: err.text };
  };

  const init = await run('init');
  assert.equal(init.code, 0, `init failed: ${init.code}\nstderr: ${init.stderr}`);
  return run(...args);
}

test('a write announces an overridden provider', async (t: TestContext) => {
  const got = await runWithConfig(t, 'turso', { TODOCLOUD_PROVIDER: 'sqlite' }, 'add', 'Buy milk');
  assert.equal(got.code, 0, got.stderr);
  assert.ok(got.stderr.includes('writing to sqlite:'), `stderr does not name the store: ${got.stderr}`);
  assert.ok(
    got.stderr.includes('TODOCLOUD_PROVIDER') && got.stderr.includes('"turso"'),
    `stderr does not say what overrode what: ${got.stderr}`,
  );
});

test('a --provider override is always announced', async (t: TestContext) => {
  const got = await runWithConfig(t, 'sqlite', {}, '--provider', 'sqlite', 'add', 'Buy milk');
  assert.equal(got.code, 0, got.stderr);
  // Even a --provider that names the configured provider is announced: it is
  // a one-off instruction, and a mistyped one is exactly what this guards.
  assert.ok(got.stderr.includes('--provider'), `stderr does not mention the flag: ${got.stderr}`);
});

// An environment variable that agrees with the config file is not an
// override, and on a machine with no config file the environment *is* the
// configuration. Neither case may produce noise: that was the mistake this
// project already made once with the file-mode warning.
test('no notice when the environment agrees with the file', async (t: TestContext) => {
  const got = await runWithConfig(t, 'sqlite', { TODOCLOUD_PROVIDER: 'sqlite' }, 'add', 'Buy milk');
  assert.equal(got.code, 0, got.stderr);
  assert.ok(!got.stderr.includes('writing to'), `stderr carries a notice it should not: ${got.stderr}`);
});

// Reading is harmless: an unexpected store shows an unexpected list, which is
// self-evident. Only writes announce themselves.
test('a read does not announce the store', async (t: TestContext) => {
  const got = await runWithConfig(t, 'turso', { TODOCLOUD_PROVIDER: 'sqlite' }, 'ls');
  assert.equal(got.code, 0, got.stderr);
  assert.ok(!got.stderr.includes('writing to'), `ls announced a write: ${got.stderr}`);
});

// The notice must never reach stdout, or `tdo add --json | jq` breaks.
test('the override notice stays off stdout', async (t: TestContext) => {
  const got = await runWithConfig(
    t,
    'turso',
    { TODOCLOUD_PROVIDER: 'sqlite' },
    'add',
    'Buy milk',
    '--json',
  );
  assert.equal(got.code, 0, got.stderr);
  const envelope: unknown = JSON.parse(got.stdout);
  assert.ok(
    typeof envelope === 'object' && envelope !== null && 'tasks' in envelope,
    `stdout = ${got.stdout}, want the task envelope`,
  );
  assert.ok(got.stderr.includes('writing to'), `the notice went missing under --json: ${got.stderr}`);
});

// An export says which store it came from, so an archive opened months later
// is not anonymous.
test('an export records the store', async (t: TestContext) => {
  const got = await runWithConfig(t, 'sqlite', {}, 'export');
  assert.equal(got.code, 0, got.stderr);
  const envelope = JSON.parse(got.stdout) as Record<string, unknown>;
  assert.ok(
    String(envelope['store']).startsWith('sqlite:'),
    `store = ${String(envelope['store'])}, want it to name the sqlite store`,
  );
});
