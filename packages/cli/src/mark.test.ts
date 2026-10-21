// The mark family: the ports of the completion, status, flag, date and move
// cases of cli_test.go, gtd_test.go, repeat_in_container_test.go and
// structure_refs_test.go.

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import * as exit from '@todocloud/core/exit';
import * as id from '@todocloud/core/id';
import { Filter } from '@todocloud/core/store/filter';
import { type Kind, type Task, newTask } from '@todocloud/core/task';

import { addCommand } from './add.ts';
import { App, type CommandFactory } from './app.ts';
import { inboxCommand, listCommand, nextCommand } from './list.ts';
import {
  deferCommand,
  doneCommand,
  dropCommand,
  dueCommand,
  flagItemsCommand,
  holdCommand,
  markCommands,
  moveCommand,
  undoneCommand,
  unflagCommand,
  unholdCommand,
} from './mark.ts';
import { showCommand } from './show.ts';
import { assertCleanFailure, buffer, type Harness, newHarness } from './testsupport.ts';

const commands: readonly CommandFactory[] = [
  addCommand,
  inboxCommand,
  listCommand,
  showCommand,
  nextCommand,
  doneCommand,
  undoneCommand,
  dropCommand,
  holdCommand,
  unholdCommand,
  flagItemsCommand,
  unflagCommand,
  deferCommand,
  dueCommand,
  moveCommand,
];

/** container writes a folder or a project straight into the store. */
async function container(
  h: Harness,
  kind: Kind,
  title: string,
  init?: { parentID?: string; sequential?: boolean; completedByChildren?: boolean },
): Promise<Task> {
  const t = newTask(id.New(), kind, title, new Date());
  t.parentID = init?.parentID ?? '';
  t.sequential = init?.sequential ?? false;
  t.completedByChildren = init?.completedByChildren ?? false;
  await h.withStore(async (st) => st.add(t));
  return t;
}

/** inside adds a task under parentID. */
async function inside(h: Harness, title: string, parentID: string): Promise<Task> {
  const t = newTask(id.New(), 'task', title, new Date());
  t.parentID = parentID;
  await h.withStore(async (st) => st.add(t));
  return t;
}

/** storedTotal counts everything the store holds, tombstones included. */
function storedTotal(h: Harness): Promise<number> {
  return h.withStore(async (st) => (await st.list(new Filter({ includeDeleted: true }))).length);
}

// markCommands is the list the registry is built from; it must stay in the
// order Go's root() had, because that is the order `tdo --help` reads in.
test('markCommands names the ten commands in help order', () => {
  const a = new App({ stdout: new buffer(), stderr: new buffer() });
  assert.deepEqual(
    markCommands(a).map((c) => c.name),
    ['done', 'undone', 'drop', 'hold', 'unhold', 'flag', 'unflag', 'defer', 'due', 'mv'],
  );
});

test('done completes by number and by id prefix', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const added = h.taskOf(await h.mustRun('add', 'Numbered', '--json'));
  const taskID = added['id'] as string;

  // Without a listing there is no number to resolve, and the error says so.
  const missing = await h.run('done', '1');
  assert.equal(missing.code, exit.NotFound);
  assert.match(missing.stderr, /tdo ls/);

  await h.mustRun('ls');
  const done = h.tasksOf(await h.mustRun('done', '1', '--json'));
  assert.equal(done.length, 1);
  assert.equal(done[0]?.['id'], taskID);
  assert.equal(done[0]?.['done'], true);
  assert.ok(done[0]?.['completed_at'] !== null);

  const undone = h.tasksOf(await h.mustRun('undone', taskID.slice(0, 10), '--json'));
  assert.equal(undone[0]?.['done'], false);
  assert.equal(undone[0]?.['completed_at'], null);
});

test('done reports no successor for an item that does not repeat', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const task = await h.add('Once');
  const obj = h.decode(await h.mustRun('done', task.id, '--json'));
  assert.deepEqual(obj['repeated'], []);
});

test('completing a repeating task creates exactly one successor', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const added = h.taskOf(
    await h.mustRun('add', 'Water the plants', '--repeat', '1w', '--due', '2026-11-01', '--json'),
  );
  const taskID = added['id'] as string;

  const obj = h.decode(await h.mustRun('done', taskID, '--json'));
  const repeated = obj['repeated'] as Record<string, unknown>[];
  assert.equal(repeated.length, 1);
  const next = repeated[0] as Record<string, unknown>;
  assert.notEqual(next['id'], taskID, 'the successor needs an id of its own');
  assert.equal(next['due_at'], '2026-11-08T00:00:00Z', 'a fixed repeat advances the due date');
  assert.equal(next['series_id'], added['series_id']);
  assert.equal(await storedTotal(h), 2);

  // --no-repeat ends the series.
  await h.mustRun('done', next['id'] as string, '--no-repeat');
  assert.equal(await storedTotal(h), 2);
});

// "says so" of §4.1: a successor appearing is the point of a repeat, so the
// human output never leaves it silent — and it goes to stderr, not stdout.
test('done announces the successor on stderr', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const added = h.taskOf(await h.mustRun('add', 'Weekly', '--repeat', '1w', '--due', '2026-11-01', '--json'));
  const res = await h.mustRun('done', added['id'] as string);
  assert.match(res.stderr, /repeats: .* is next/);
});

// §3.3a, and the order `tdo done` has to file the successor in: a repeating
// last action leaves an open child behind, so the container must not close.
test('a repeating last action keeps its container open', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const project = await container(h, 'project', 'Weekly review', { completedByChildren: true });
  const action = h.taskOf(
    await h.mustRun('add', 'run the review', '--project', project.id, '--repeat', '1w', '--json'),
  );

  const obj = h.decode(await h.mustRun('done', action['id'] as string, '--json'));
  const repeated = obj['repeated'] as Record<string, unknown>[];
  assert.equal(repeated.length, 1);

  const after = h.taskOf(await h.mustRun('show', project.id, '--json'));
  assert.equal(after['status'], 'active', 'the container closed although its repeat left an open action');
  assert.equal(repeated[0]?.['parent_id'], project.id);
});

// The same container with a non-repeating last action does close: that is the
// rule working, and it is what makes the case above meaningful.
test('a non-repeating last action closes its container', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const project = await container(h, 'project', 'Ship the thing', { completedByChildren: true });
  const action = await inside(h, 'the only step', project.id);

  const res = await h.mustRun('done', action.id);
  // The container leaving `tdo ls` because its last action closed is not
  // something to discover later, so it is reported on stderr.
  assert.match(res.stderr, /completed with its last action/);
  assert.equal(h.taskOf(await h.mustRun('show', project.id, '--json'))['status'], 'done');

  const obj = h.decode(await h.mustRun('ls', '--all', '--json'));
  assert.equal(obj['count'], 2);
});

test('the containers a write closed are reported under --json', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const project = await container(h, 'project', 'Ship it', { completedByChildren: true });
  const action = await inside(h, 'the only step', project.id);

  const obj = h.decode(await h.mustRun('done', action.id, '--json'));
  const closed = obj['completed_with_last'] as Record<string, unknown>[];
  assert.equal(closed.length, 1);
  assert.equal(closed[0]?.['id'], project.id);
});

test('the status commands move an item between the four statuses', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const task = await h.add('Movable');

  assert.equal(h.taskOf(await h.mustRun('hold', task.id, '--json'))['status'], 'on_hold');
  assert.equal(h.taskOf(await h.mustRun('unhold', task.id, '--json'))['status'], 'active');
  assert.equal(h.taskOf(await h.mustRun('drop', task.id, '--json'))['status'], 'dropped');
  assert.equal(h.taskOf(await h.mustRun('undone', task.id, '--json'))['status'], 'active');
  assert.equal(h.taskOf(await h.mustRun('done', task.id, '--json'))['status'], 'done');
});

test('flag and unflag change only the flag', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const task = await h.add('Flaggable');
  assert.equal(h.taskOf(await h.mustRun('flag', task.id, '--json'))['flagged'], true);
  assert.equal(h.taskOf(await h.mustRun('unflag', task.id, '--json'))['flagged'], false);
  assert.equal(h.tasksOf(await h.mustRun('ls', '--flagged', '--json')).length, 0);
});

test('a write over several items applies to all of them or to none', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const first = await h.add('first');
  const second = await h.add('second');

  const both = h.tasksOf(await h.mustRun('flag', first.id, second.id, '--json'));
  assert.equal(both.length, 2);

  // One reference that means nothing stops the whole command.
  const got = await h.run('done', first.id, '01ZZZZZZZZZZZZZZZZZZZZZZZZ');
  assert.equal(got.code, exit.NotFound);
  assert.equal(h.taskOf(await h.mustRun('show', first.id, '--json'))['done'], false);
});

test('every mark command expects at least one reference', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  for (const name of ['done', 'undone', 'drop', 'hold', 'unhold', 'flag', 'unflag']) {
    const got = await h.run(name);
    assert.equal(got.code, exit.Usage, name);
    assert.match(got.stderr, /expected at least one task reference/);
  }
});

test('defer and due take the date as the last argument, or --clear', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const first = await h.add('first');
  const second = await h.add('second');

  // One date for several items in one command.
  const deferred = h.tasksOf(await h.mustRun('defer', first.id, second.id, '2099-01-01', '--json'));
  assert.equal(deferred.length, 2);
  for (const task of deferred) {
    assert.equal(task['defer_at'], '2099-01-01T00:00:00Z');
  }
  assert.equal(
    h.taskOf(await h.mustRun('due', first.id, '2026-11-01', '--json'))['due_at'],
    '2026-11-01T00:00:00Z',
  );

  // --clear takes the date's place.
  assert.equal(h.taskOf(await h.mustRun('defer', first.id, '--clear', '--json'))['defer_at'], null);
  assert.equal(h.taskOf(await h.mustRun('due', first.id, '--clear', '--json'))['due_at'], null);

  for (const args of [
    ['defer', first.id],
    ['due', first.id],
    ['defer', '2026-11-01'],
    ['defer', first.id, 'tomorrow'],
  ]) {
    const got = await h.run(...args);
    assert.equal(got.code, exit.Usage, args.join(' '));
  }
});

test('mv reparents, and --inbox and --top take an item out of its container', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const folder = await container(h, 'folder', 'Home');
  const project = await container(h, 'project', 'Kitchen', { parentID: folder.id });
  const task = await inside(h, 'Fix the tap', project.id);

  // A container is resolved by title as well, exactly as `--project` is.
  assert.equal(h.taskOf(await h.mustRun('mv', task.id, 'Kitchen', '--json'))['parent_id'], project.id);
  assert.equal(h.taskOf(await h.mustRun('mv', task.id, '--inbox', '--json'))['parent_id'], null);
  assert.equal(h.taskOf(await h.mustRun('mv', project.id, '--top', '--json'))['parent_id'], null);
});

// §3.1, at exit 2: an illegal parent/kind pairing and a move that would make
// a cycle are mistakes at the command line, not store failures.
test('mv refuses an illegal parent and a cycle', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const folder = await container(h, 'folder', 'Home');
  const project = await container(h, 'project', 'Kitchen', { parentID: folder.id });
  const task = await inside(h, 'Fix the tap', project.id);

  for (const args of [
    ['mv', task.id, folder.id],
    ['mv', folder.id, project.id],
    ['mv', folder.id, folder.id],
    ['mv', task.id],
    ['mv'],
  ]) {
    const got = await h.run(...args);
    assert.equal(got.code, exit.Usage, args.join(' '));
    assertCleanFailure(t, got.stderr);
  }
});

// Two containers with the same title is an ambiguous reference, not a guess.
test('mv refuses an ambiguous container title', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  await container(h, 'project', 'Admin');
  await container(h, 'folder', 'Admin');
  const loose = await h.add('file the receipts');
  const got = await h.run('mv', loose.id, 'Admin');
  assert.equal(got.code, exit.Ambiguous);
});

// In a sequential project the order of the children is the order they become
// available (§3.3), so reordering is a feature and not a cosmetic.
test('--before and --after place items among their siblings', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const project = await container(h, 'project', 'Return', { sequential: true });
  const first = await inside(h, 'Collect the receipts', project.id);
  const second = await inside(h, 'Fill the form', project.id);
  const scan = await inside(h, 'Scan the copies', project.id);

  const order = async (): Promise<string> => {
    const titles: string[] = [];
    for (const item of h.tasksOf(await h.mustRun('ls', '--all', '--json'))) {
      if (item['kind'] === 'task') {
        titles.push(item['title'] as string);
      }
    }
    return titles.join(',');
  };
  assert.equal(await order(), 'Collect the receipts,Fill the form,Scan the copies');

  await h.mustRun('mv', scan.id, '--before', first.id);
  assert.equal(await order(), 'Scan the copies,Collect the receipts,Fill the form');
  await h.mustRun('mv', scan.id, '--after', second.id);
  assert.equal(await order(), 'Collect the receipts,Fill the form,Scan the copies');

  // The order is the order the sequential rule uses.
  assert.equal(h.taskOf(await h.mustRun('next', '--json'))['title'], 'Collect the receipts');
  await h.mustRun('mv', scan.id, '--before', first.id);
  assert.equal(h.taskOf(await h.mustRun('next', '--json'))['title'], 'Scan the copies');
});

test('a reorder refuses every contradiction', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const project = await container(h, 'project', 'Return');
  const first = await inside(h, 'One', project.id);
  const second = await inside(h, 'Two', project.id);

  for (const args of [
    ['mv', second.id, '--before', first.id, '--after', first.id],
    ['mv', second.id, '--before', first.id, '--inbox'],
    ['mv', second.id, '--before', ''],
    ['mv', '--before', first.id],
    ['mv', first.id, '--before', first.id],
  ]) {
    const got = await h.run(...args);
    assert.equal(got.code, exit.Usage, args.join(' '));
  }

  // Moving an item next to an anchor somewhere else moves it there too.
  const other = await container(h, 'project', 'Other');
  const elsewhere = await inside(h, 'Elsewhere', other.id);
  const moved = h.taskOf(await h.mustRun('mv', second.id, '--after', elsewhere.id, '--json'));
  assert.equal(moved['parent_id'], other.id);
});

// The safety property of PLAN.md §3.4: a new instance appears only as the
// direct result of an explicit `tdo done`. A tool an agent drives must not
// manufacture rows while it is being read.
test('no read generates a repeat', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const project = await container(h, 'project', 'Chores');
  const added = h.taskOf(
    await h.mustRun('add', 'Water the plants', '--project', project.id, '--repeat', '1d', '--due', '2020-01-01', '--json'),
  );
  const taskID = added['id'] as string;

  const before = await storedTotal(h);
  assert.equal(before, 2);

  const reads = [
    ['ls'],
    ['ls', '--json'],
    ['ls', '--all', '--json'],
    ['ls', '--blocked', '--json'],
    ['ls', '--tree'],
    ['show', taskID],
    ['show', taskID, '--json'],
    ['next', '--json'],
    ['inbox', '--json'],
    ['inbox', '--count', '--json'],
  ];
  for (let round = 0; round < 2; round++) {
    for (const args of reads) {
      await h.mustRun(...args);
      assert.equal(await storedTotal(h), before, `tdo ${args.join(' ')} changed the number of items`);
    }
  }

  // Only the explicit completion does, and only once.
  await h.mustRun('done', taskID, '--json');
  assert.equal(await storedTotal(h), before + 1);
});
