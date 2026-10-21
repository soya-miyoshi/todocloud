// The port of internal/cli/credential_matrix_test.go.
//
// This file tests the project's central promise as a matrix rather than as a
// handful of assertions spread over the command tests: one sentinel value per
// credential source, every command, every output stream, every rendering mode.
//
// Every credential source is populated at once — both token environment
// variables, a guarded config file, the keychain and the provider CLI that
// mints a token — so that a run proves the whole resolution path rather than
// one branch of it. Nothing here touches the developer's own environment,
// config file, keychain or provider CLI: the keychain and the Turso CLI are
// replaced through `login.ts`'s own test seams, the keychain the configuration
// reads is the injected `Env.keyring`, and everything on disk lives under the
// harness's temporary directory.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';

import * as providercli from '@todocloud/core/providercli';
import { Secret } from '@todocloud/core/secret';

import { type Env, RunWith, commandTable, App } from './app.ts';
import * as config from './config.ts';
import * as keyring from './keyring.ts';
import { forTest as loginForTest } from './login.ts';
import { type Harness, type Result, buffer, newHarness } from './testsupport.ts';

/**
 * tomlString renders a value as a basic TOML string for a hand-written
 * fixture. A path is the reason it exists: on Windows a temporary directory
 * is C:\Users\..., and a backslash in a TOML basic string begins an escape
 * sequence, so pasting such a path in raw produces a file the parser rejects
 * — and a test that fails for a reason that has nothing to do with what it
 * is testing.
 */
function tomlString(v: string): string {
  return `"${v.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;
}

/**
 * Each sentinel is one fake credential and the source it is planted in. Every
 * value is obviously fake (CLAUDE.md §1.3) and distinctive enough to grep the
 * repository for.
 */
const sentinelEnvTurso = 'TOKEN_GOES_HERE_env_7f3a';
const sentinelEnvD1 = 'TOKEN_GOES_HERE_envd1_7f3a';
const sentinelKeyring = 'TOKEN_GOES_HERE_keyring_7f3a';
const sentinelFile = 'TOKEN_GOES_HERE_file_7f3a';
const sentinelMinted = 'TOKEN_GOES_HERE_minted_7f3a';
const sentinelStdin = 'TOKEN_GOES_HERE_stdin_7f3a';

/** credSentinels is every planted value, with the source it came from. */
const credSentinels: readonly { source: string; value: string }[] = [
  { source: 'the TODOCLOUD_TURSO_TOKEN environment variable', value: sentinelEnvTurso },
  { source: 'the TODOCLOUD_D1_TOKEN environment variable', value: sentinelEnvD1 },
  { source: 'the OS keychain', value: sentinelKeyring },
  { source: 'the config file', value: sentinelFile },
  { source: 'a token minted by the turso CLI', value: sentinelMinted },
  { source: 'a token pasted on stdin', value: sentinelStdin },
];

/** OutputMode is one rendering of the same command. */
interface OutputMode {
  name: string;
  flags: string[];
  /**
   * json says whether stdout must hold machine output, which is also checked
   * for being exactly one JSON value.
   */
  json: boolean;
}

const outputModes: readonly OutputMode[] = [
  { name: 'plain', flags: [], json: false },
  { name: 'json', flags: ['--json'], json: true },
  { name: 'debug', flags: ['--debug'], json: false },
  { name: 'json+debug', flags: ['--json', '--debug'], json: true },
];

/** setup is the mode used for the fixture's own runs: no mode flags at all. */
const setup: OutputMode = { name: 'setup', flags: [], json: false };

/**
 * MatrixCommand is one command line to run in every mode. Adding a command to
 * the matrix is one entry.
 */
interface MatrixCommand {
  name: string;
  /**
   * args are everything after the program name, excluding the mode flags,
   * which are inserted before them so that a positional argument cannot
   * swallow them.
   */
  args: string[];
  /** stdin is what the command reads, for the one command that reads a token. */
  stdin?: string | undefined;
  /**
   * stdoutIsNotJSON marks a command whose stdout is machine output in another
   * format, so the single-JSON-value check does not apply.
   */
  stdoutIsNotJSON?: boolean | undefined;
  /**
   * mustSucceed asserts the run exercised a real success path rather than
   * failing early for an unrelated reason.
   */
  mustSucceed?: boolean | undefined;
}

/**
 * matrixSubcommands is every command in the tree, with the global flags it
 * needs to reach its own code. It drives the deliberate-failure rows.
 *
 * `list` and `remove` are here where Go had them as aliases: the port
 * registers each as its own (hidden) command, so each needs its own row.
 */
const matrixSubcommands: readonly { name: string; globals?: string[] }[] = [
  { name: 'add' },
  { name: 'inbox' },
  { name: 'ls' },
  { name: 'list' },
  { name: 'next' },
  { name: 'project' },
  { name: 'folder' },
  { name: 'tag' },
  { name: 'repeat' },
  { name: 'series' },
  { name: 'review' },
  { name: 'perspective' },
  { name: 'drop' },
  { name: 'hold' },
  { name: 'unhold' },
  { name: 'flag' },
  { name: 'unflag' },
  { name: 'defer' },
  { name: 'due' },
  { name: 'mv' },
  { name: 'serve' },
  { name: 'show' },
  { name: 'done' },
  { name: 'undone' },
  { name: 'edit' },
  { name: 'rm' },
  { name: 'remove' },
  { name: 'init' },
  { name: 'migrate' },
  { name: 'config' },
  { name: 'doctor' },
  { name: 'export' },
  { name: 'import' },
  { name: 'version' },
  { name: 'login', globals: ['--provider', 'turso'] },
];

/**
 * Fixture is one populated world: a store, a config file holding a token, an
 * environment holding two more, a keychain holding a fourth and a Turso CLI
 * that mints a fifth.
 */
interface Fixture {
  h: Harness;
  /** exportFile is a valid export document, for the import row. */
  exportFile: string;
  /**
   * strayConfig names a config file whose sqlite path does not exist, for the
   * missing-store failure row.
   */
  strayConfig: string;
  /** missingConfig names a config file that is not there at all. */
  missingConfig: string;
}

/**
 * run drives the real command tree with both streams captured, the
 * environment injected and the keychain stubbed.
 *
 * The harness's own `run` would do all of that, but it hands every command an
 * empty stdin and a keychain with no entry; the matrix needs a token on stdin
 * and a keychain that answers, so the Env is built from the harness's world
 * here rather than a second harness being stood up.
 */
async function runRow(f: Fixture, mode: OutputMode, cmd: MatrixCommand): Promise<Result> {
  const out = new buffer();
  const err = new buffer();
  const injected: Env = {
    stdout: out,
    stderr: err,
    stdin: { read: (): Promise<string> => Promise.resolve(cmd.stdin ?? '') },
    getenv: (key: string): string => f.h.env[key] ?? '',
    stdinIsTTY: (): boolean => false,
    // The keychain the *configuration* reads. It holds the keychain sentinel
    // for both accounts, so a run proves the keychain branch of the
    // resolution path as well as the environment's.
    keyring: (): keyring.Entry => ({ value: new Secret(sentinelKeyring), present: true }),
  };
  const code = await RunWith(injected, ['tdo', ...mode.flags, ...cmd.args]);
  return { code, stdout: out.text, stderr: err.text };
}

/**
 * installMatrixKeychain replaces the keychain `tdo login` writes through with
 * an in-memory one holding the keychain sentinel for both accounts.
 */
function installMatrixKeychain(t: TestContext): void {
  const stored = new Map<string, Secret>([
    [keyring.AccountTursoToken, new Secret(sentinelKeyring)],
    [keyring.AccountD1Token, new Secret(sentinelKeyring)],
  ]);
  t.after(
    loginForTest.installKeychain({
      backend: (): string => keyring.BackendKeychain,
      available: (): boolean => true,
      get: (account: string): keyring.Entry => {
        const value = stored.get(account);
        return { value: value ?? new Secret(''), present: value !== undefined };
      },
      set: (account: string, value: Secret): void => {
        stored.set(account, value);
      },
      delete: (account: string): void => {
        stored.delete(account);
      },
    }),
  );
}

/**
 * installMatrixTurso replaces the Turso CLI with one that is installed,
 * logged in, and mints the minted sentinel. The real binary is never run
 * (CLAUDE.md §1.5).
 */
function installMatrixTurso(t: TestContext): void {
  t.after(
    loginForTest.installProviderCLI({
      lookPath: (file: string): string => {
        if (file === providercli.TURSO_BIN) {
          return '/fake/bin/turso';
        }
        throw new Error(`${file} is not installed`);
      },
      runner: (_signal, name, args): providercli.Output => {
        assert.equal(name, providercli.TURSO_BIN, 'the matrix reached another provider CLI');
        for (const arg of args) {
          assert.ok(!arg.includes(sentinelMinted), `a token reached argv: ${args.join(' ')}`);
          assert.ok(!arg.includes(sentinelStdin), `a token reached argv: ${args.join(' ')}`);
        }
        const line = args.join(' ');
        if (line === 'auth token') {
          return { stdout: 'a-session-token', stderr: '' };
        }
        if (line === 'db list') {
          return { stdout: 'NAME\nmatrix-tasks\n', stderr: '' };
        }
        if (args[0] === 'db' && args[1] === 'tokens' && args[2] === 'create') {
          return { stdout: `${sentinelMinted}\n`, stderr: '' };
        }
        if (args[0] === 'db' && args[1] === 'show') {
          return { stdout: 'libsql://example.turso.io\n', stderr: '' };
        }
        throw new Error(`the fake turso CLI was asked for ${line}`);
      },
    }),
  );
}

/** newMatrixFixture builds the world and populates the store. */
async function newMatrixFixture(t: TestContext): Promise<Fixture> {
  // The harness owns the temporary directory, the SQLite store, the injected
  // environment and the redirected state directory.
  const h = await newHarness(t);
  const dir = h.dir;

  // The config file has to satisfy every guard for its token to be loaded at
  // all: the XDG path, mode 0600, outside any git repository. The harness's
  // directory is a fresh temporary one, so it is outside this repository.
  const cfgPath = path.join(dir, 'config', 'todocloud', 'config.toml');
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    cfgPath,
    'provider = "sqlite"\n' +
      `\n[turso]\nurl = "libsql://example.turso.io"\ntoken = "${sentinelFile}"\n` +
      '\n[d1]\naccount_id = "00000000-0000-0000-0000-000000000000"\n' +
      `database_id = "00000000-0000-0000-0000-000000000000"\ntoken = "${sentinelFile}"\n`,
    { mode: 0o600 },
  );
  fs.chmodSync(cfgPath, 0o600);

  const stray = path.join(dir, 'stray.toml');
  fs.writeFileSync(
    stray,
    `provider = "sqlite"\n\n[sqlite]\npath = ${tomlString(path.join(dir, 'absent', 'tasks.db'))}\n`,
    { mode: 0o600 },
  );

  // Every credential source is live at once.
  h.env[config.EnvTursoToken] = sentinelEnvTurso;
  h.env[config.EnvD1Token] = sentinelEnvD1;
  h.env[config.EnvTursoURL] = 'libsql://example.turso.io';

  installMatrixKeychain(t);
  installMatrixTurso(t);

  const f: Fixture = {
    h,
    exportFile: path.join(dir, 'export.json'),
    strayConfig: stray,
    missingConfig: path.join(dir, 'not-there.toml'),
  };

  const must = async (...args: string[]): Promise<Result> => {
    const res = await runRow(f, setup, { name: args.join(' '), args });
    assert.equal(res.code, 0, `fixture \`tdo ${args.join(' ')}\` failed: ${res.stderr}`);
    return res;
  };

  await must('init');
  // Three tasks and one listing, so the short reference "1" resolves and the
  // rows that read or change a task exercise their real paths.
  for (const title of ['Matrix one', 'Matrix two', 'Matrix three']) {
    await must('add', title);
  }
  await must('ls');
  const exported = await must('export');
  fs.writeFileSync(f.exportFile, exported.stdout, { mode: 0o600 });
  return f;
}

/**
 * matrixRows returns the command lines the matrix runs: the successful path of
 * every command, a deliberate failure of every command, and the specific
 * failures a user actually hits.
 */
function matrixRows(f: Fixture): MatrixCommand[] {
  const rows: MatrixCommand[] = [
    { name: 'version', args: ['version'], mustSucceed: true },
    { name: 'config', args: ['config'], mustSucceed: true },
    { name: 'doctor', args: ['doctor'], mustSucceed: true },
    { name: 'init', args: ['init'], mustSucceed: true },
    { name: 'migrate', args: ['migrate'], mustSucceed: true },
    { name: 'add', args: ['add', 'Buy milk'], mustSucceed: true },
    { name: 'ls', args: ['ls'], mustSucceed: true },
    { name: 'ls --all', args: ['ls', '--all'], mustSucceed: true },
    { name: 'show', args: ['show', '1'], mustSucceed: true },
    { name: 'done', args: ['done', '1'], mustSucceed: true },
    { name: 'undone', args: ['undone', '1'], mustSucceed: true },
    { name: 'edit', args: ['edit', '1', '--title', 'Renamed'], mustSucceed: true },
    // The structure commands, and then the commands that take a reference.
    // The short numbers come from the listing just above each block, which is
    // how a human reaches them too.
    { name: 'folder add', args: ['folder', 'add', 'Home'], mustSucceed: true },
    {
      name: 'project add',
      args: ['project', 'add', 'Errands', '--folder', 'Home', '--review', '1w'],
      mustSucceed: true,
    },
    { name: 'project <ref>', args: ['project', 'Errands', '--sequential'], mustSucceed: true },
    { name: 'inbox', args: ['inbox'], mustSucceed: true },
    { name: 'inbox --count', args: ['inbox', '--count'], mustSucceed: true },
    {
      name: 'inbox process',
      args: ['inbox', 'process', '1', '--project', 'Errands'],
      mustSucceed: true,
    },
    { name: 'mv --inbox', args: ['mv', '1', '--inbox'], mustSucceed: true },
    { name: 'next', args: ['next'], mustSucceed: true },
    { name: 'project ls', args: ['project', 'ls'], mustSucceed: true },
    { name: 'folder ls', args: ['folder', 'ls'], mustSucceed: true },
    { name: 'tag ls', args: ['tag', 'ls'], mustSucceed: true },
    { name: 'tag hold', args: ['tag', 'hold', 'errand'], mustSucceed: true },
    { name: 'tag unhold', args: ['tag', 'unhold', 'errand'], mustSucceed: true },
    { name: 'review', args: ['review'], mustSucceed: true },
    { name: 'review <ref>', args: ['review', 'Errands'], mustSucceed: true },
    { name: 'ls --all (renumbers)', args: ['ls', '--all'], mustSucceed: true },
    { name: 'flag', args: ['flag', '1'], mustSucceed: true },
    { name: 'unflag', args: ['unflag', '1'], mustSucceed: true },
    { name: 'hold', args: ['hold', '1'], mustSucceed: true },
    { name: 'unhold', args: ['unhold', '1'], mustSucceed: true },
    { name: 'drop', args: ['drop', '1'], mustSucceed: true },
    { name: 'undone (after drop)', args: ['undone', '1'], mustSucceed: true },
    { name: 'defer', args: ['defer', '1', '2026-12-01'], mustSucceed: true },
    { name: 'defer --clear', args: ['defer', '1', '--clear'], mustSucceed: true },
    { name: 'due', args: ['due', '1', '2026-12-01'], mustSucceed: true },
    { name: 'due --clear', args: ['due', '1', '--clear'], mustSucceed: true },
    { name: 'repeat', args: ['repeat', '1', '1w'], mustSucceed: true },
    { name: 'series', args: ['series', '1'], mustSucceed: true },
    { name: 'repeat --stop', args: ['repeat', '1', '--stop'], mustSucceed: true },
    {
      name: 'perspective save',
      args: ['perspective', 'save', 'flagged', '--', '--flagged'],
      mustSucceed: true,
    },
    { name: 'perspective ls', args: ['perspective', 'ls'], mustSucceed: true },
    { name: 'perspective show', args: ['perspective', 'show', 'flagged'], mustSucceed: true },
    { name: 'ls --perspective', args: ['ls', '--perspective', 'flagged'], mustSucceed: true },
    { name: 'perspective rm', args: ['perspective', 'rm', 'flagged'], mustSucceed: true },
    { name: 'ls --all (renumbers again)', args: ['ls', '--all'], mustSucceed: true },
    { name: 'rm', args: ['rm', '2'], mustSucceed: true },
    { name: 'rm --purge --yes', args: ['rm', '--purge', '--yes', '3'], mustSucceed: true },
    { name: 'list (the ls alias)', args: ['list'], mustSucceed: true },
    { name: 'export', args: ['export'], mustSucceed: true },
    {
      name: 'export --csv',
      args: ['export', '--csv'],
      stdoutIsNotJSON: true,
      mustSucceed: true,
    },
    { name: 'import', args: ['import', '--new-ids', f.exportFile], mustSucceed: true },
    {
      name: 'login --show',
      args: ['--provider', 'turso', 'login', '--show'],
      mustSucceed: true,
    },
    {
      name: 'login (mints through the turso CLI)',
      args: ['--provider', 'turso', 'login', '--yes', '--database', 'matrix-tasks'],
      mustSucceed: true,
    },
    {
      name: 'login (reads a pasted token from stdin)',
      args: ['--provider', 'd1', 'login', '--yes'],
      stdin: `${sentinelStdin}\n`,
      mustSucceed: true,
    },
    {
      name: 'login --remove --yes',
      args: ['--provider', 'turso', 'login', '--remove', '--yes'],
      mustSucceed: true,
    },
  ];

  // A deliberate failure of every command: an unknown flag, which must be
  // reported without any of the configuration it never got to read.
  for (const sub of matrixSubcommands) {
    rows.push({
      name: `${sub.name} (unknown flag)`,
      args: [...(sub.globals ?? []), sub.name, '--definitely-not-a-flag'],
    });
  }

  // The failures a user meets for real.
  rows.push(
    { name: 'unknown command', args: ['nosuchcommand'] },
    // serve is only ever exercised through a failure here: a row that
    // succeeded would block the test on a listener.
    { name: 'serve with an impossible port', args: ['serve', '--port', '70000'] },
    { name: 'unknown reference', args: ['show', '999999'] },
    { name: 'malformed reference', args: ['done', 'not-an-id'] },
    { name: 'missing store', args: ['--config', f.strayConfig, 'ls'] },
    { name: 'missing config file', args: ['--config', f.missingConfig, 'config'] },
    { name: 'unimplemented provider', args: ['--provider', 'turso', 'ls'] },
    { name: 'import of a missing file', args: ['import', path.join(f.h.dir, 'absent.json')] },
    {
      name: 'login --remove with --show',
      args: ['--provider', 'turso', 'login', '--remove', '--show'],
    },
    { name: 'login with nothing on stdin', args: ['--provider', 'd1', 'login', '--yes'], stdin: '' },
  );
  return rows;
}

/**
 * assertAtMostOneJSONValue checks that a --json run put one JSON document on
 * stdout and nothing else: a second document is a place a leak could hide.
 *
 * Go decoded a stream; `JSON.parse` takes the whole string, which rejects a
 * second document on its own, so the two halves of the Go check are one here.
 */
function assertAtMostOneJSONValue(row: MatrixCommand, mode: OutputMode, stdout: string): void {
  if (stdout.trim() === '') {
    // Some commands report entirely on stderr; an empty stdout cannot hide
    // anything.
    return;
  }
  try {
    JSON.parse(stdout);
  } catch (err) {
    assert.fail(
      `\`tdo ${row.args.join(' ')}\` in ${mode.name} mode did not put exactly one JSON value on stdout: ${JSON.stringify(stdout)}: ${String(err)}`,
    );
  }
}

// The matrix: commands × modes, with every credential source populated,
// asserting that no sentinel appears on either stream and that --json stdout
// holds exactly one JSON value.
for (const mode of outputModes) {
  test(`no credential reaches any stream in ${mode.name} mode`, async (t: TestContext) => {
    // A fresh world per mode, so a row that changes the store cannot make
    // another mode's row fail for an unrelated reason.
    const f = await newMatrixFixture(t);
    for (const row of matrixRows(f)) {
      const res = await runRow(f, mode, row);
      const where = `\`tdo ${row.args.join(' ')}\` in ${mode.name} mode`;

      for (const s of credSentinels) {
        assert.ok(
          !res.stdout.includes(s.value),
          `${where} leaked ${s.source} onto stdout\nstdout: ${res.stdout}`,
        );
        assert.ok(
          !res.stderr.includes(s.value),
          `${where} leaked ${s.source} onto stderr\nstderr: ${res.stderr}`,
        );
      }

      if (mode.json && row.stdoutIsNotJSON !== true) {
        assertAtMostOneJSONValue(row, mode, res.stdout);
      }
      if (row.mustSucceed === true) {
        assert.equal(
          res.code,
          0,
          `${where} exited ${res.code}, want 0 (the row is meant to exercise a success path)\nstderr: ${res.stderr}`,
        );
      }
      if (row.mustSucceed !== true && row.name.includes('unknown flag')) {
        assert.notEqual(
          res.code,
          0,
          `${where} exited 0, so the deliberate failure did not happen`,
        );
      }
    }
  });
}

// TestMatrixCoversEveryCommand keeps the matrix honest: every command in the
// tree must appear in it, so a new command cannot be added without a row. The
// list is derived from the registry rather than written out, which is the
// whole point: a hand-written list would drift.
test('the matrix covers every command', async (t: TestContext) => {
  const f = await newMatrixFixture(t);
  const covered = new Set<string>();
  for (const row of matrixRows(f)) {
    for (const arg of row.args) {
      if (!arg.startsWith('-')) {
        covered.add(arg);
      }
    }
  }

  for (const c of commandTable(new App({}))) {
    assert.ok(covered.has(c.name), `command ${JSON.stringify(c.name)} has no row in the credential matrix`);
  }
});

// ---------------------------------------------------------------------------
// The config-file token guard, where a user actually meets it.
// ---------------------------------------------------------------------------

/** GuardCase is one config file the token guard has to judge. */
interface GuardCase {
  name: string;
  /** inRepository puts the file inside a directory with a .git entry. */
  inRepository?: boolean;
  /** mode is the file's permission bits. */
  mode: number;
  /** location is how the file is named: "xdg", "env" or "flag". */
  location: 'xdg' | 'env' | 'flag';
  /** key is the token key written in the file: "token", "api_token" or "". */
  key: 'token' | 'api_token' | '';
  /** wantLoaded is whether the token should end up in the configuration. */
  wantLoaded?: boolean;
  /** wantWarning is whether the run should say something on stderr. */
  wantWarning?: boolean;
}

const guardCases: readonly GuardCase[] = [
  { name: 'xdg path, mode 600, token', mode: 0o600, location: 'xdg', key: 'token', wantLoaded: true },
  { name: 'env path, mode 600, token', mode: 0o600, location: 'env', key: 'token', wantLoaded: true },
  {
    name: 'arbitrary --config path, mode 600, token',
    mode: 0o600,
    location: 'flag',
    key: 'token',
    wantWarning: true,
  },
  { name: 'xdg path, mode 640, token', mode: 0o640, location: 'xdg', key: 'token', wantWarning: true },
  { name: 'xdg path, mode 644, token', mode: 0o644, location: 'xdg', key: 'token', wantWarning: true },
  { name: 'env path, mode 644, token', mode: 0o644, location: 'env', key: 'token', wantWarning: true },
  {
    name: 'xdg path inside a git repository, mode 600, token',
    inRepository: true,
    mode: 0o600,
    location: 'xdg',
    key: 'token',
    wantWarning: true,
  },
  {
    name: 'env path inside a git repository, mode 600, token',
    inRepository: true,
    mode: 0o600,
    location: 'env',
    key: 'token',
    wantWarning: true,
  },
  // An unsupported spelling is reported and dropped, wherever it is.
  {
    name: 'xdg path, mode 600, api_token',
    mode: 0o600,
    location: 'xdg',
    key: 'api_token',
    wantWarning: true,
  },
  {
    name: 'env path, mode 600, api_token',
    mode: 0o600,
    location: 'env',
    key: 'api_token',
    wantWarning: true,
  },
  {
    name: 'arbitrary --config path, mode 600, api_token',
    mode: 0o600,
    location: 'flag',
    key: 'api_token',
    wantWarning: true,
  },
  { name: 'xdg path, mode 644, no token at all', mode: 0o644, location: 'xdg', key: '' },
  {
    name: 'xdg path inside a git repository, no token at all',
    inRepository: true,
    mode: 0o600,
    location: 'xdg',
    key: '',
  },
  { name: 'arbitrary --config path, mode 600, no token at all', mode: 0o600, location: 'flag', key: '' },
];

/**
 * runGuardCase builds one config file as the case describes it, runs
 * `tdo config --json` against it and decodes the result.
 */
function runGuardCase(
  t: TestContext,
  c: GuardCase,
): Promise<{ res: Result; described: Record<string, unknown> }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdo-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = path.join(root, 'state');

  // Where the file sits on disk. A repository case gets a .git entry above
  // it, which is what the file-token guard looks for.
  let base = root;
  if (c.inRepository === true) {
    base = path.join(root, 'repo');
    fs.mkdirSync(path.join(base, '.git'), { recursive: true, mode: 0o700 });
  }
  const xdgConfig = path.join(base, 'config');

  const cfgPath =
    c.location === 'xdg'
      ? path.join(xdgConfig, 'todocloud', 'config.toml')
      : path.join(base, 'named.toml');
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true, mode: 0o700 });

  let body =
    `provider = "sqlite"\n\n[sqlite]\npath = ${tomlString(path.join(root, 'tasks.db'))}\n` +
    '\n[turso]\nurl = "libsql://example.turso.io"\n';
  if (c.key !== '') {
    body += `${c.key} = "${sentinelFile}"\n`;
  }
  fs.writeFileSync(cfgPath, body, { mode: 0o600 });
  // The mode is set after the write, so an umask cannot soften it.
  fs.chmodSync(cfgPath, c.mode);

  const env: Record<string, string> = {
    HOME: root,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_STATE_HOME: state,
    // No token in the environment: the environment wins over the file, so its
    // absence is what makes this a test of the file.
  };
  let args = ['tdo', '--json', 'config'];
  if (c.location === 'env') {
    env[config.EnvConfig] = cfgPath;
  }
  if (c.location === 'flag') {
    args = ['tdo', '--json', '--config', cfgPath, 'config'];
  }

  const out = new buffer();
  const err = new buffer();
  return RunWith(
    {
      stdout: out,
      stderr: err,
      stdin: { read: (): Promise<string> => Promise.resolve('') },
      getenv: (key: string): string => env[key] ?? '',
      stdinIsTTY: (): boolean => false,
      // No test may query the developer's real keychain (CLAUDE.md §1.5), and
      // an absent entry is what makes the file the thing under test.
      keyring: (): keyring.Entry => ({ value: new Secret(''), present: false }),
    },
    args,
  ).then((code) => {
    const res: Result = { code, stdout: out.text, stderr: err.text };
    const value: unknown = JSON.parse(res.stdout);
    assert.ok(
      typeof value === 'object' && value !== null && !Array.isArray(value),
      `stdout is not a JSON object: ${res.stdout}`,
    );
    return { res, described: value as Record<string, unknown> };
  });
}

// The guard is tested where a user actually meets it: through
// `tdo config --json`. It overlaps config.test.ts deliberately — the guard is
// only worth anything if it still holds once the command layer has resolved
// the path, read the file and rendered the result.
test('the config-file token guard, through `tdo config --json`', async (t: TestContext) => {
  for (const base of guardCases) {
    // Where a file token is not read at all, every case that writes one is a
    // refusal with a warning, whatever the path and the mode say. The verdict
    // is the platform's, not the matrix's, so the expectation moves rather
    // than the case being dropped: that a token in a file never loads here is
    // exactly what is worth asserting on such a platform.
    const c: GuardCase =
      !config.FileTokensSupported() && base.key === 'token'
        ? { ...base, wantLoaded: false, wantWarning: true }
        : base;

    const { res, described } = await runGuardCase(t, c);
    assert.equal(res.code, 0, `${c.name}: \`tdo config --json\` exited ${res.code}: ${res.stderr}`);

    const turso = described['turso'] as Record<string, unknown>;
    assert.equal(
      turso['token_present'],
      c.wantLoaded === true,
      `${c.name}: token_present = ${String(turso['token_present'])}\nstderr: ${res.stderr}`,
    );
    const origin = String(turso['token_origin'] ?? '');
    if (c.wantLoaded === true) {
      assert.ok(origin.startsWith('file:'), `${c.name}: token_origin = ${origin}, want a file: origin`);
    } else {
      assert.equal(origin, '', `${c.name}: a refused token still recorded the origin ${origin}`);
    }

    assert.equal(
      res.stderr.trim() !== '',
      c.wantWarning === true,
      `${c.name}: warning on stderr = ${String(res.stderr.trim() !== '')}, want ${String(c.wantWarning === true)}\nstderr: ${res.stderr}`,
    );

    // Whatever the verdict, the value itself may not appear anywhere: not in
    // a warning, not in an origin, not in the rendered config.
    assert.ok(!res.stderr.includes(sentinelFile), `${c.name}: the token value reached stderr: ${res.stderr}`);
    assert.ok(!res.stdout.includes(sentinelFile), `${c.name}: the token value reached stdout: ${res.stdout}`);
    for (const raw of described['warnings'] as unknown[]) {
      assert.ok(!String(raw).includes(sentinelFile), `${c.name}: a warning carries the token value: ${String(raw)}`);
    }
    for (const [name, raw] of Object.entries(described['origins'] as Record<string, unknown>)) {
      assert.ok(
        !String(raw).includes(sentinelFile),
        `${c.name}: the origin of ${name} carries the token value: ${String(raw)}`,
      );
    }
  }
});
