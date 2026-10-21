// The dispatcher. These are the ports of usage_test.go and the parts of
// cli_test.go that test the flag tree rather than a command, plus the cases
// `parseArgs` makes possible that urfave did not.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';

import * as exit from '@todocloud/core/exit';

import {
  App,
  type Command,
  type CommandFactory,
  type Context,
  commandTable,
  hasFlag,
  usagef,
} from './app.ts';
import { newHarness } from './testsupport.ts';

/**
 * fakeAdd is `tdo add` reduced to what the dispatcher is responsible for: the
 * positional arguments become the title, and a flag before `--` applies. The
 * real command is another agent's port; these tests are about argv, so they
 * drive a command whose whole behaviour is visible here.
 */
function fakeAdd(a: App): Command {
  return {
    name: 'add',
    usage: 'capture a task',
    argsUsage: '<title>...',
    store: 'write',
    flags: {
      priority: { type: 'string', usage: 'priority' },
      due: { type: 'string', usage: 'due date' },
      tag: { type: 'string', multiple: true, usage: 'a tag' },
    },
    run(ctx: Context): Promise<void> {
      const title = ctx.args.join(' ');
      if (title === '') {
        throw usagef('add expects a title');
      }
      const priority = ctx.string('priority');
      if (a.out.json) {
        a.out.emit({
          tasks: [
            {
              title,
              priority: priority === '' ? 0 : Number(priority),
              tags: ctx.strings('tag'),
            },
          ],
          count: 1,
        });
      } else {
        a.out.printf(`${title}\n`);
      }
      return Promise.resolve();
    },
  };
}

/** fakeLs is a listing that needs the store but writes nothing of interest. */
function fakeLs(a: App): Command {
  return {
    name: 'ls',
    usage: 'list items',
    store: 'read',
    flags: { status: { type: 'string', usage: 'status' } },
    run(ctx: Context): Promise<void> {
      if (a.out.json) {
        a.out.emit({ tasks: [], count: 0, status: ctx.string('status') });
      } else {
        a.out.printf('no items\n');
      }
      return Promise.resolve();
    },
  };
}

/** fakeGroup is `tdo project <sub>`, for the subcommand resolution tests. */
function fakeGroup(a: App): Command {
  return {
    name: 'project',
    usage: 'work with projects',
    subcommands: [
      {
        name: 'ls',
        usage: 'list projects',
        run(ctx: Context): Promise<void> {
          a.out.printf(`project ls json=${String(a.out.json)} args=${ctx.args.join(',')}\n`);
          return Promise.resolve();
        },
      },
    ],
  };
}

/** fakeInit is the one command that may create the store. */
function fakeInit(a: App): Command {
  return {
    name: 'init',
    usage: 'create the store',
    store: 'create',
    run(): Promise<void> {
      a.out.printf('initialized\n');
      return Promise.resolve();
    },
  };
}

const table: readonly CommandFactory[] = [fakeAdd, fakeLs, fakeGroup, fakeInit];

// Exit code 2 is the documented class for "the user got the command line
// wrong" (docs/agents.md). parseArgs reports a parse failure by throwing,
// which would otherwise be classified as a generic failure, so these cases
// are pinned.
test('a mistake at the command line exits with the usage code', async (t: TestContext) => {
  const h = await newHarness(t, table);

  for (const [name, args] of [
    ['unknown flag on a subcommand', ['add', 'x', '--nope']],
    ['unknown global flag', ['--nope', 'ls']],
    // CLAUDE.md §1.6: there is no --token flag and there must never be one.
    ['a flag that should never exist', ['add', 'x', '--token', 'TOKEN_GOES_HERE']],
    ['unknown command', ['frobnicate']],
    ['unknown command with arguments', ['frobnicate', 'x']],
    ['missing value for a flag', ['add', 'x', '--due']],
    ['a value given to a boolean', ['add', 'x', '--json=yes']],
    ['unknown subcommand', ['project', 'frobnicate']],
  ] as const) {
    const got = await h.run(...args);
    assert.equal(got.code, exit.Usage, `${name}: stdout ${got.stdout} stderr ${got.stderr}`);
    assert.equal(got.stdout, '', `${name}: a failure without --json writes to stderr`);
  }
});

// The same mistakes must produce the documented envelope on stdout, with the
// usage code, so an agent can tell a bad command line from a missing task.
test('a mistake at the command line renders the JSON envelope', async (t: TestContext) => {
  const h = await newHarness(t, table);

  for (const args of [
    ['add', 'x', '--nope', '--json'],
    ['frobnicate', '--json'],
  ]) {
    const got = await h.run(...args);
    assert.equal(got.code, exit.Usage, args.join(' '));
    const envelope = JSON.parse(got.stdout) as { error?: { code?: string; message?: string } };
    assert.equal(envelope.error?.code, exit.CodeUsage, got.stdout);
    assert.notEqual((envelope.error?.message ?? '').trim(), '', 'the envelope carries no message');
  }
});

// A mistyped command must say so rather than print a help topic.
test('an unknown command names itself', async (t: TestContext) => {
  const h = await newHarness(t, table);
  const got = await h.run('frobnicate');
  assert.match(got.stderr, /unknown command "frobnicate"/);
});

// An unknown flag names itself too, which is the whole reason parseArgs'
// message is rewritten rather than passed through.
test('an unknown flag names itself', async (t: TestContext) => {
  const h = await newHarness(t, table);
  assert.match((await h.run('add', 'x', '--nope')).stderr, /unknown flag --nope/);
  assert.match((await h.run('--nope', 'add', 'x')).stderr, /unknown flag --nope/);
});

// Help is not a failure.
test('help succeeds', async (t: TestContext) => {
  const h = await newHarness(t, table);
  for (const args of [[], ['--help'], ['-h'], ['add', '--help'], ['help'], ['help', 'add'], ['project', '--help']]) {
    const got = await h.run(...args);
    assert.equal(got.code, exit.OK, `${args.join(' ')}: stderr ${got.stderr}`);
    assert.match(got.stdout, /Usage:/);
  }
});

test('the root help lists every command and the global flags', async (t: TestContext) => {
  const h = await newHarness(t, table);
  const got = await h.mustRun('--help');
  for (const want of ['add', 'ls', 'project', 'init', '--json', '--debug', '--config', '--provider']) {
    assert.ok(got.stdout.includes(want), `the help omits ${want}: ${got.stdout}`);
  }
  assert.equal(got.stderr, '', 'help is the result, so it goes to stdout');
});

test("a command's help names its own flags", async (t: TestContext) => {
  const h = await newHarness(t, table);
  const got = await h.mustRun('add', '--help');
  assert.match(got.stdout, /--priority/);
  assert.match(got.stdout, /<title>\.\.\./);
});

// `tdo ls --json` and `tdo --json ls` must behave identically: Go got that
// from urfave sharing a non-Local flag, and the port gets it by merging the
// global flags into every command's option set.
test('a global flag is accepted before and after the command', async (t: TestContext) => {
  const h = await newHarness(t, table);
  for (const args of [
    ['--json', 'ls'],
    ['ls', '--json'],
  ]) {
    const got = await h.mustRun(...args);
    assert.equal(h.decode(got)['count'], 0, args.join(' '));
  }
  // And inside a group, before the subcommand name.
  const grouped = await h.mustRun('project', '--json', 'ls');
  assert.match(grouped.stdout, /json=true/);
});

test('--debug writes to stderr and nothing to stdout', async (t: TestContext) => {
  const h = await newHarness(t, table);
  const got = await h.mustRun('--debug', 'ls', '--json');
  assert.match(got.stderr, /tdo: debug: opening sqlite store at/);
  assert.doesNotMatch(got.stdout, /debug/);
});

// A command that declares a store mode is handed an open store, and the
// schema check runs first: the harness creates the schema, so a store at the
// wrong version is the mismatch test's business, not this one's.
test('a command that declares a store mode is handed one', async (t: TestContext) => {
  const h = await newHarness(t, table);
  assert.equal((await h.mustRun('ls')).stdout, 'no items\n');
});

// `tdo init junk` must not leave a database behind on its way to exit 2.
test('a create command refuses a stray argument before opening anything', async (t: TestContext) => {
  const h = await newHarness(t, table);
  const got = await h.run('init', 'junk');
  assert.equal(got.code, exit.Usage);
  assert.match(got.stderr, /init takes no arguments/);
});

// --provider picks the store for one command only, and a write says so, since
// writing to the wrong store is the failure mode that matters.
test('a write names the store when --provider overrode it', async (t: TestContext) => {
  const h = await newHarness(t, table);
  const got = await h.mustRun('--provider', 'sqlite', 'add', 'a task');
  assert.match(got.stderr, /writing to .*--provider selected it for this command only/s);
  // A read says nothing, and neither does a write to the configured store.
  assert.equal((await h.mustRun('ls')).stderr, '');
  assert.equal((await h.mustRun('add', 'another')).stderr, '');
});

// An unimplemented provider never reaches openStore: Config.Validate refuses
// it first, with the advice that applies. openStore keeps the check Go had
// anyway, because the two are reached by different paths and a provider that
// validates but cannot be opened must not fall through to a raw failure.
test('an unimplemented provider is a configuration error', async (t: TestContext) => {
  const h = await newHarness(t, table);
  const got = await h.run('--provider', 'firestore', 'ls');
  assert.equal(got.code, exit.Config);
  assert.match(got.stderr, /firestore/);
  assert.equal(got.stdout, '');
});

test('an unknown provider is a configuration error', async (t: TestContext) => {
  const h = await newHarness(t, table);
  const got = await h.run('--provider', 'frobnicate', 'ls');
  assert.equal(got.code, exit.Config);
});

// hasFlag is the pre-parse peek that decides how a parse error is rendered.
// It must stop at `--`, or `tdo add -- --json` would render its failure as
// JSON on stdout.
test('hasFlag peeks at the global flags and stops at the separator', () => {
  assert.equal(hasFlag(['tdo', 'ls', '--json'], 'json'), true);
  assert.equal(hasFlag(['tdo', '--json', 'ls'], 'json'), true);
  assert.equal(hasFlag(['tdo', 'add', '--', '--json'], 'json'), false);
  assert.equal(hasFlag(['tdo', 'ls'], 'json'), false);
});

// The contract says a flag never takes a secret (CLAUDE.md §1.6). argv is
// world-readable via ps and is saved in shell history, so this walks the real
// registry rather than trusting a review to catch it.
test('no registered flag takes a credential', () => {
  const a = new App({});
  const forbidden = new Set(['token', 'password', 'secret', 'api-token', 'api_token', 'key']);
  const walk = (commands: readonly Command[], path: string): void => {
    for (const c of commands) {
      for (const name of Object.keys(c.flags ?? {})) {
        assert.ok(
          !forbidden.has(name),
          `${path}${c.name} declares --${name}: a secret reaches tdo through the environment, the keychain or the config file only`,
        );
      }
      walk(c.subcommands ?? [], `${path}${c.name} `);
    }
  };
  walk(commandTable(a), '');
});

// The usage message points at the help rather than restating the table, so
// the two cannot drift apart.
test('the registry is consistent', () => {
  const a = new App({});
  const walk = (commands: readonly Command[]): void => {
    for (const c of commands) {
      assert.notEqual(c.usage, '', `${c.name} has no usage line`);
      assert.notEqual(c.name, 'help', '"help" is handled by the dispatcher itself');
      assert.ok(
        (c.run === undefined) !== (c.subcommands === undefined),
        `${c.name} must have exactly one of run and subcommands`,
      );
      if (c.subcommands === undefined) {
        continue;
      }
      walk(c.subcommands);
    }
  };
  walk(commandTable(a));
});

// ---------------------------------------------------------------------------
// The output contract, over the real registry.
//
// The tests above drive a fake command table, because they are about argv.
// These three walk the commands a user actually runs: the `--json` shape is a
// documented contract (docs/agents.md) and `tdo … --json | jq` has to be safe
// everywhere, including on a failure.
// ---------------------------------------------------------------------------

test('every JSON command writes only JSON', async (t: TestContext) => {
  const h = await newHarness(t);
  const id = String(h.taskOf(await h.mustRun('add', 'Contract', '--json'))['id']);
  await h.mustRun('ls');

  const exportFile = path.join(h.dir, 'contract.json');
  fs.writeFileSync(exportFile, (await h.mustRun('export', '--all')).stdout, { mode: 0o600 });

  const commands: readonly string[][] = [
    ['add', 'Another', '--json'],
    ['ls', '--json'],
    ['ls', '--all', '--deleted', '--json'],
    ['show', id, '--json'],
    ['done', id, '--json'],
    ['undone', id, '--json'],
    ['edit', id, '--title', 'Contract II', '--json'],
    ['init', '--json'],
    ['migrate', '--json'],
    ['config', '--json'],
    ['doctor', '--json'],
    ['version', '--json'],
    ['export', '--all', '--json'],
    ['import', exportFile, '--json'],
    ['rm', id, '--json'],
    ['rm', id, '--purge', '--yes', '--json'],
    // Failures are part of the contract too.
    ['show', 'not-a-ref', '--json'],
    ['show', '01ZZZZZZZZZZZZZZZZZZZZZZZZ', '--json'],
  ];
  for (const args of commands) {
    const res = await h.run(...args);
    // JSON.parse takes the whole of stdout, so it rejects a second document
    // on its own: in Go that needed a streaming decoder and a `dec.More()`.
    try {
      JSON.parse(res.stdout);
    } catch (err) {
      assert.fail(
        `\`tdo ${args.join(' ')}\`: stdout is not exactly one JSON value: ${JSON.stringify(res.stdout)}: ${String(err)}`,
      );
    }
  }
});

test('a not-found is the error envelope on stdout under --json', async (t: TestContext) => {
  const h = await newHarness(t);
  const res = await h.run('show', '01ZZZZZZZZZZZZZZZZZZZZZZZZ', '--json');
  assert.equal(res.code, exit.NotFound, res.stderr);
  const envelope = h.decode(res)['error'] as Record<string, unknown>;
  assert.equal(envelope['code'], exit.CodeNotFound, res.stdout);
  assert.notEqual(envelope['message'], '', res.stdout);
});

test('a usage error under --json is the envelope and nothing else', async (t: TestContext) => {
  const h = await newHarness(t);
  const res = await h.run('show', 'not-a-ref', '--json');
  assert.equal(res.code, exit.Usage, res.stderr);
  assert.ok(Object.hasOwn(h.decode(res), 'error'), res.stdout);
});

// The regression test for a read-only command that used to leave a directory
// tree and an empty database behind when the configured path was a typo. Only
// `tdo init` may create a store. list.test.ts covers `tdo ls` against its own
// table; this is the whole set, through the dispatcher that does the opening.
test('no command but init creates the store', async (t: TestContext) => {
  for (const args of [
    ['ls'],
    ['show', '01J3ABCDEFGHJKMNPQRSTVWXYZ'],
    ['add', 'a task'],
    ['done', '01J3ABCDEFGHJKMNPQRSTVWXYZ'],
    ['export'],
    ['import'],
  ]) {
    const h = await newHarness(t);
    const stray = path.join(h.dir, 'stray');
    const db = path.join(stray, 'tasks.db');
    h.env['TODOCLOUD_SQLITE_PATH'] = db;

    const res = await h.run(...args);
    const where = `tdo ${args.join(' ')}`;
    assert.equal(res.code, exit.Config, `${where}: exit ${res.code}\nstderr: ${res.stderr}`);
    assert.match(res.stderr, /tdo init/u, `${where}: stderr should advise \`tdo init\``);
    // The driver's own words never reach the user.
    assert.ok(!res.stderr.includes('no such table'), `${where}: stderr leaks the driver message: ${res.stderr}`);
    assert.equal(fs.existsSync(db), false, `${where}: the database file was created`);
    assert.equal(fs.existsSync(stray), false, `${where}: the parent directory was created`);
  }
});
