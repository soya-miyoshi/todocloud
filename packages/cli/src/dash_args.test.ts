// The port of dash_args_test.go. Argument parsing has hostile edge cases and
// this file is the specification for how the dispatcher handles them: the
// separator, a value that looks like a flag, a negative number and the empty
// string.
//
// Go drove the real `tdo add`. That command is another agent's port, so these
// tests drive a command whose whole body is visible here — the behaviour under
// test belongs to the dispatcher either way, and a test that pins argv must
// not fail for a reason inside a command.

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import * as exit from '@todocloud/core/exit';

import { type App, type Command, type CommandFactory, type Context, usagef } from './app.ts';
import { newHarness } from './testsupport.ts';

/** add joins its arguments into a title, as the real one does. */
function add(a: App): Command {
  return {
    name: 'add',
    usage: 'capture a task',
    argsUsage: '<title>...',
    store: 'write',
    flags: {
      priority: { type: 'string', usage: 'priority' },
      note: { type: 'string', usage: 'a note' },
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
              note: ctx.string('note'),
              note_set: ctx.isSet('note'),
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

const table: readonly CommandFactory[] = [add];

// docs/agents.md tells a caller to put a dash-leading title after `--` and
// every flag before it. Both halves of that sentence are load-bearing: a flag
// placed after the separator becomes part of the title, which is the kind of
// thing an agent would otherwise discover by storing a task called
// "--not-a-flag --json".
test('the argument separator behaves as documented', async (t: TestContext) => {
  const h = await newHarness(t, table);

  // Flags before the separator: the flag applies, the value is the title.
  const added = h.taskOf(await h.mustRun('add', '--json', '--priority', '2', '--', '--not-a-flag'));
  assert.equal(added['title'], '--not-a-flag', 'the dash-leading value is the title');
  assert.equal(added['priority'], 2, 'the flag before `--` did not apply');

  // A flag after the separator is an argument, and `add` joins its arguments
  // into the title.
  const res = await h.mustRun('add', '--', '--leading-dash', '--json');
  assert.equal(res.code, 0, res.stderr);
  assert.ok(
    res.stdout !== '' && !res.stdout.startsWith('{'),
    `the trailing --json was honoured as a flag; it should be part of the title:\n${res.stdout}`,
  );
  assert.equal(res.stdout, '--leading-dash --json\n');

  // Without the separator it is a usage error, not a surprise.
  assert.equal((await h.run('add', '--not-a-flag')).code, exit.Usage);
});

// parseArgs refuses an option-like value in strict mode, which would have
// made `--priority -1` an error where urfave read it as minus one. The
// dispatcher joins a separated value onto its flag before parseArgs sees it,
// so a negative number, a dash-leading value and `-` all still work.
test('a flag value may look like a flag', async (t: TestContext) => {
  const h = await newHarness(t, table);

  const negative = h.taskOf(await h.mustRun('add', 'x', '--json', '--priority', '-1'));
  assert.equal(negative['priority'], -1);

  // The explicit form means the same thing.
  const joined = h.taskOf(await h.mustRun('add', 'x', '--json', '--priority=-1'));
  assert.equal(joined['priority'], -1);

  const dashed = h.taskOf(await h.mustRun('add', 'x', '--json', '--note', '--not-a-flag'));
  assert.equal(dashed['note'], '--not-a-flag');

  const stdinish = h.taskOf(await h.mustRun('add', 'x', '--json', '--note', '-'));
  assert.equal(stdinish['note'], '-');
});

// An empty string is a value, and it is not the same as the flag's absence:
// `--note ""` clears the note where no --note leaves it alone.
test('an empty flag value is a value', async (t: TestContext) => {
  const h = await newHarness(t, table);

  const cleared = h.taskOf(await h.mustRun('add', 'x', '--json', '--note', ''));
  assert.equal(cleared['note'], '');
  assert.equal(cleared['note_set'], true);

  const absent = h.taskOf(await h.mustRun('add', 'x', '--json'));
  assert.equal(absent['note_set'], false);

  // And the explicit spelling is the same value.
  const explicit = h.taskOf(await h.mustRun('add', 'x', '--json', '--note='));
  assert.equal(explicit['note'], '');
  assert.equal(explicit['note_set'], true);
});

// A missing value is still a usage error. The value-joining shim must not
// invent one by consuming the next flag, nor swallow the error parseArgs
// reports at the end of the line.
test('a flag with no value at all is a usage error', async (t: TestContext) => {
  const h = await newHarness(t, table);
  const got = await h.run('add', 'x', '--priority');
  assert.equal(got.code, exit.Usage, got.stderr);
  assert.match(got.stderr, /priority/);
});

// A repeated flag collects, and it does not split on commas: `--tag a,b` is
// one tag. Go had to turn urfave's slice separator off for this; here it is
// simply what parseArgs does.
test('a repeated flag collects and never splits on a comma', async (t: TestContext) => {
  const h = await newHarness(t, table);
  const added = h.taskOf(await h.mustRun('add', 'x', '--json', '--tag', 'a,b', '--tag', 'c'));
  assert.deepEqual(added['tags'], ['a,b', 'c']);
});

// A lone `-` is an argument, not a flag: it is how a caller names stdin.
test('a bare dash is an argument', async (t: TestContext) => {
  const h = await newHarness(t, table);
  assert.equal((await h.mustRun('add', '-')).stdout, '-\n');
});

// The separator with nothing after it leaves the command with no arguments,
// which is the command's own usage error rather than a parse failure.
test('the separator with nothing after it is an empty argument list', async (t: TestContext) => {
  const h = await newHarness(t, table);
  const got = await h.run('add', '--');
  assert.equal(got.code, exit.Usage);
  assert.match(got.stderr, /add expects a title/);
});
