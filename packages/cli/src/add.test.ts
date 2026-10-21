// `tdo add`: the ports of the capture cases of cli_test.go, gtd_test.go and
// hostile_values_test.go.

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import * as exit from '@todocloud/core/exit';
import * as id from '@todocloud/core/id';
import { type Kind, type Task, newTask } from '@todocloud/core/task';

import { addCommand, parseInstant, parseTags } from './add.ts';
import type { CommandFactory } from './app.ts';
import { listCommand } from './list.ts';
import { showCommand } from './show.ts';
import { assertCleanFailure, type Harness, newHarness } from './testsupport.ts';

const commands: readonly CommandFactory[] = [addCommand, listCommand, showCommand];

/** container writes a folder or a project straight into the store. */
async function container(h: Harness, kind: Kind, title: string, parentID = ''): Promise<Task> {
  const t = newTask(id.New(), kind, title, new Date());
  t.parentID = parentID;
  await h.withStore(async (st) => st.add(t));
  return t;
}

test('add captures a task to the inbox', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const added = h.taskOf(await h.mustRun('add', 'Buy', 'stamps', '--json'));
  assert.equal(added['title'], 'Buy stamps');
  assert.equal(added['kind'], 'task');
  // The inbox is the absence of a container, so there is nothing to create.
  assert.equal(added['parent_id'], null);
});

test('add expects a title', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  for (const args of [['add'], ['add', '  '], ['add', '', '']]) {
    const got = await h.run(...args);
    assert.equal(got.code, exit.Usage, args.join(' '));
    assert.match(got.stderr, /expected a task title/);
  }
});

test('add writes every well-known field', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const added = h.taskOf(
    await h.mustRun(
      'add',
      'Pay the invoice',
      '--due',
      '2026-11-01',
      '--defer',
      '2026-10-01',
      '--priority',
      '2',
      '--tag',
      'finance,Finance,ops',
      '--note',
      'pay by card',
      '--estimate',
      '25m',
      '--flag',
      '--json',
    ),
  );
  assert.equal(added['due_at'], '2026-11-01T00:00:00Z');
  assert.equal(added['defer_at'], '2026-10-01T00:00:00Z');
  assert.equal(added['priority'], 2);
  assert.equal(added['note'], 'pay by card');
  assert.equal(added['estimated_minutes'], 25);
  assert.equal(added['flagged'], true);
  // The tags are normalized by the shared layer: blanks and duplicates go,
  // and the comparison is case-insensitive.
  assert.deepEqual(added['tags'], ['finance', 'ops']);
});

// Go declared --notes as an alias of --note. The dispatcher has no alias
// mechanism, so the second spelling is a hidden flag of its own and must
// still reach the same field.
test('--notes is accepted as the second spelling of --note', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  assert.equal(h.taskOf(await h.mustRun('add', 'Noted', '--notes', 'by the back door', '--json'))['note'],
    'by the back door');
});

test('--set stores a JSON value as that value and anything else as text', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const nested = '{"owner":"ana","steps":[1,2,3]}';
  const added = h.taskOf(
    await h.mustRun('add', 'Nested', '--set', `plan=${nested}`, '--set', 'estimate=3', '--set', 'ref=3.0.1', '--json'),
  );
  assert.equal(added['estimate'], 3, '--set estimate=3 should store a number');
  assert.equal(added['ref'], '3.0.1', '--set ref=3.0.1 should store a string');

  const shown = h.taskOf(await h.mustRun('show', added['id'] as string, '--json'));
  const plan = shown['plan'] as Record<string, unknown>;
  assert.equal(plan['owner'], 'ana');
  assert.deepEqual(plan['steps'], [1, 2, 3]);
});

test('add refuses a reserved field and a malformed --set', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  for (const args of [
    ['add', 'Reserved', '--set', 'id=nope'],
    ['add', 'Reserved', '--set', 'status=done'],
    ['add', 'Malformed', '--set', 'nokey'],
    ['add', 'Malformed', '--set', '=value'],
  ]) {
    const got = await h.run(...args);
    assert.equal(got.code, exit.Usage, args.join(' '));
    assertCleanFailure(t, got.stderr);
  }
});

// --unset removes a field from an existing item, so a new one has none.
test('add refuses --unset', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const got = await h.run('add', 'New', '--unset', 'owner');
  // --unset is not one of `tdo add`'s flags at all, so the dispatcher
  // reports it before the body can.
  assert.equal(got.code, exit.Usage);
});

test('a priority outside 0..3 is a usage error', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  for (const value of ['4', '-1', 'high']) {
    const got = await h.run('add', 'Bad priority', '--priority', value);
    assert.equal(got.code, exit.Usage, `--priority ${value}`);
    assertCleanFailure(t, got.stderr);
  }
  await h.mustRun('add', 'Good priority', '--priority', '3');
});

test('a bad date, estimate or repeat is a usage error', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  for (const args of [
    ['add', 'x', '--due', 'tomorrow'],
    ['add', 'x', '--defer', '2026-13-01'],
    ['add', 'x', '--estimate', 'a while'],
    ['add', 'x', '--estimate', '-5m'],
    ['add', 'x', '--repeat', 'sometimes'],
    ['add', 'x', '--repeat', ''],
  ]) {
    const got = await h.run(...args);
    assert.equal(got.code, exit.Usage, args.join(' '));
    assertCleanFailure(t, got.stderr);
  }
});

test('--repeat names the series on the first instance', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const added = h.taskOf(await h.mustRun('add', 'Water the plants', '--repeat', '1w', '--due', '2026-11-01', '--json'));
  assert.equal((added['repeat'] as Record<string, unknown>)['every'], '1w');
  assert.ok(typeof added['series_id'] === 'string' && added['series_id'] !== '');
});

test('--project and --parent choose where the task goes', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const project = await container(h, 'project', 'Errands');

  // A container is typed far more often than an action, so a title is
  // accepted as well as a number or an id prefix.
  const byTitle = h.taskOf(await h.mustRun('add', 'Buy stamps', '--project', 'Errands', '--json'));
  assert.equal(byTitle['parent_id'], project.id);
  // An id is accepted too. A short prefix is not used here: ids minted
  // milliseconds apart share their leading timestamp characters, so a
  // fixture-length prefix would be ambiguous by accident.
  const byPrefix = h.taskOf(await h.mustRun('add', 'Post it', '--project', project.id, '--json'));
  assert.equal(byPrefix['parent_id'], project.id);

  // --parent makes an action group out of a task.
  const under = h.taskOf(await h.mustRun('add', 'Find the address', '--parent', byTitle['id'] as string, '--json'));
  assert.equal(under['parent_id'], byTitle['id']);
});

test('the destination flags contradict each other', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const project = await container(h, 'project', 'Errands');
  for (const args of [
    ['add', 'x', '--project', 'Errands', '--parent', project.id],
    ['add', 'x', '--inbox', '--project', 'Errands'],
    ['add', 'x', '--inbox', '--parent', project.id],
  ]) {
    const got = await h.run(...args);
    assert.equal(got.code, exit.Usage, args.join(' '));
    assert.match(got.stderr, /pass only one|contradicts/);
  }
  // --inbox on its own is the default said out loud.
  assert.equal(h.taskOf(await h.mustRun('add', 'Loose', '--inbox', '--json'))['parent_id'], null);
});

// §3.1: a task cannot go inside a folder, and the refusal is a mistake at
// the command line rather than a store failure.
test('a task cannot go inside a folder', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const folder = await container(h, 'folder', 'Home');
  const got = await h.run('add', 'Loose', '--parent', folder.id);
  assert.equal(got.code, exit.Usage);
  assertCleanFailure(t, got.stderr);
});

test('a container that is named but does not exist is reported', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const missing = await h.run('add', 'x', '--project', 'Nothing by this name');
  assert.equal(missing.code, exit.NotFound);
  assert.match(missing.stderr, /tdo project ls/);
});

// A container's title is tried last, so two containers sharing one is an
// ambiguous reference and not a guess.
test('an ambiguous container title exits 6', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  await container(h, 'project', 'Admin');
  await container(h, 'project', 'admin');
  const got = await h.run('add', 'x', '--project', 'Admin');
  assert.equal(got.code, exit.Ambiguous);
});

// A value that reads like an attack on something is data. The flags take
// their values with = and the title comes after --, so a value beginning
// with a dash is still read as data.
test('a hostile value is stored as data', async (t: TestContext) => {
  const hostile: Record<string, string> = {
    sql: `'; DROP TABLE tasks; --`,
    format: '%s %d %#v %%',
    template: '{{.}} {{range .Tasks}}{{end}}',
    path: '../../etc/passwd',
    nul: 'before\x00after',
    ansi: '\x1b[31mred\x1b[0m\x1b]0;title\x07',
    carriage: 'first\rsecond',
    long: 'A'.repeat(10000),
    backslashes: 'C:\\temp\\%_\\\\',
    'like wilds': '100%_x',
    quotes: `he said "it's" fine`,
    unicode: '絵文字 🙂 ja/en mixed',
    'leading dash': '--not-a-flag',
  };
  for (const [name, value] of Object.entries(hostile)) {
    await test(name, async (tt: TestContext) => {
      const h = await newHarness(tt, commands);
      const added = h.taskOf(
        await h.mustRun('add', `--note=${value}`, '--tag=plain', `--set=attr=${value}`, '--json', '--', value),
      );
      const taskID = added['id'] as string;
      assert.ok(typeof taskID === 'string' && taskID !== '');

      const shown = h.taskOf(await h.mustRun('show', taskID, '--json'));
      // The title is what `add` built from its arguments, so it is the value
      // with the surrounding whitespace trimmed.
      assert.equal(shown['title'], value.trim());
      assert.equal(shown['note'], value);
      assert.equal(shown['attr'], value);

      // The store is intact: a would-be injection did not drop the table,
      // and the task is still the only row.
      assert.equal(h.tasksOf(await h.mustRun('ls', '--all', '--json')).length, 1);
    });
  }
});

// A value that is JSON goes through task.parseValue and is stored as that
// JSON rather than as the text of it.
test('a --set value that is JSON is stored as JSON', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  for (const value of ['{"id":"forged","status":"done"}', '[1,2,3]']) {
    const added = h.taskOf(await h.mustRun('add', 'JSON', `--set=attr=${value}`, '--json'));
    assert.equal(typeof added['attr'], 'object', `${value} should have been parsed`);
    // A field cannot shadow a required one, whatever it carries.
    assert.notEqual(added['id'], 'forged');
    assert.equal(added['status'], 'active');
  }
});

// The two pure helpers, pinned directly as well as through the command.
test('parseInstant reads a date or nothing at all', () => {
  assert.equal(parseInstant(''), undefined);
  assert.equal(parseInstant('   '), undefined);
  assert.equal(parseInstant('2026-11-01')?.toISOString(), '2026-11-01T00:00:00.000Z');
  assert.throws(() => parseInstant('tomorrow'));
});

test('parseTags splits the comma-separated lists a repeated --tag builds up', () => {
  assert.deepEqual(parseTags(['home,errand', ' Home ', '', 'ops']), ['home', 'errand', 'ops']);
  assert.deepEqual(parseTags([]), []);
});
