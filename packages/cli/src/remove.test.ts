// `tdo rm`: the port of TestRemoveWritesTombstone,
// TestPurgeRefusesWithoutTTYOrYes, TestPurgingAContainerNeedsRecursive and
// TestRemovingAContainerTombstonesItsSubtree.

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import * as exit from '@todocloud/core/exit';
import * as id from '@todocloud/core/id';
import { Filter } from '@todocloud/core/store/filter';
import { type Kind, type Task, newTask } from '@todocloud/core/task';

import { addCommand } from './add.ts';
import type { CommandFactory, Env } from './app.ts';
import { listCommand } from './list.ts';
import { removeAliasCommand, removeCommand } from './remove.ts';
import { showCommand } from './show.ts';
import { assertCleanFailure, buffer, type Harness, newHarness } from './testsupport.ts';
import { RunWith } from './app.ts';

const commands: readonly CommandFactory[] = [
  addCommand,
  listCommand,
  showCommand,
  removeCommand,
  removeAliasCommand,
];

/** container writes a folder or a project straight into the store. */
async function container(h: Harness, kind: Kind, title: string, parentID = ''): Promise<Task> {
  const t = newTask(id.New(), kind, title, new Date());
  t.parentID = parentID;
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

/**
 * runAt drives one command line with stdin and the terminal answer under the
 * test's control. `tdo rm --purge` is the one place both matter, and a test
 * cannot give itself a terminal, which is why Env.stdinIsTTY is a seam.
 */
async function runAt(
  h: Harness,
  opts: { tty: boolean; stdin?: string },
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  const out = new buffer();
  const err = new buffer();
  const env: Env = {
    stdout: out,
    stderr: err,
    stdin: { read: (): Promise<string> => Promise.resolve(opts.stdin ?? '') },
    getenv: (name: string): string => h.env[name] ?? '',
    stdinIsTTY: (): boolean => opts.tty,
  };
  const code = await RunWith(env, ['tdo', ...args], commands);
  return { code, stdout: out.text, stderr: err.text };
}

test('rm writes a tombstone', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const added = h.taskOf(await h.mustRun('add', 'Tombstoned', '--json'));
  const taskID = added['id'] as string;

  const removed = h.tasksOf(await h.mustRun('rm', taskID, '--json'));
  assert.ok(removed[0]?.['deleted_at'] !== null, 'rm should stamp deleted_at');

  // A tombstone is hidden from every listing but the one that asks for it.
  assert.equal(h.tasksOf(await h.mustRun('ls', '--all', '--json')).length, 0);
  const deleted = h.tasksOf(await h.mustRun('ls', '--all', '--deleted', '--json'));
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0]?.['id'], taskID);
  // The row is still there, which is what lets a second device learn about
  // the deletion instead of silently resurrecting it.
  assert.equal(await storedTotal(h), 1);
});

// `tdo remove` was an alias on the `rm` command in Go.
test('the remove alias is the rm command', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const task = await h.add('Tombstoned');
  assert.ok(h.tasksOf(await h.mustRun('remove', task.id, '--json'))[0]?.['deleted_at'] !== null);
});

// Removing a container takes its subtree with it: leaving the children behind
// would make them orphans, which §3.3 refuses to call available.
test('rm on a container tombstones its subtree', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const project = await container(h, 'project', 'Errands');
  await inside(h, 'Buy stamps', project.id);

  const removed = h.tasksOf(await h.mustRun('rm', project.id, '--json'));
  assert.equal(removed.length, 2);
  for (const task of removed) {
    assert.ok(task['deleted_at'] !== null, 'a removed item carries a tombstone');
  }
});

test('rm expects at least one reference', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const got = await h.run('rm');
  assert.equal(got.code, exit.Usage);
  assert.match(got.stderr, /expected at least one task reference/);
});

// --purge is the only irreversible path in the CLI, so it is the only one
// that asks. Without a terminal it refuses rather than assuming --yes.
test('purge refuses without a terminal and without --yes', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const added = h.taskOf(await h.mustRun('add', 'Still here', '--json'));
  const taskID = added['id'] as string;

  const res = await runAt(h, { tty: false }, 'rm', taskID, '--purge');
  assert.equal(res.code, exit.Usage);
  assert.match(res.stderr, /--yes/, 'the refusal should name --yes');
  // The refusal names the real number of rows and the store it would have
  // emptied, because a provider override may have redirected it.
  assert.match(res.stderr, /1 item\(s\)/);
  assert.equal(await storedTotal(h), 1, 'nothing may be deleted by a refused purge');

  const purged = h.decode(await h.mustRun('rm', taskID, '--purge', '--yes', '--json'));
  assert.deepEqual(purged['purged'], [taskID]);
  assert.equal(purged['count'], 1);
  assert.equal(await storedTotal(h), 0);
});

// On a terminal it prompts, on stderr, so the question never lands in piped
// machine output.
test('purge prompts on a terminal and a yes goes through', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const task = await h.add('Going');

  const res = await runAt(h, { tty: true, stdin: 'y\n' }, 'rm', task.id, '--purge');
  assert.equal(res.code, exit.OK);
  assert.match(res.stderr, /Permanently delete 1 item\(s\)/);
  assert.match(res.stderr, /\[y\/N\]/);
  assert.match(res.stdout, new RegExp(`purged ${task.id}`));
  assert.equal(await storedTotal(h), 0);
});

// Declining is not a failure; nothing was changed.
test('declining the prompt purges nothing and exits 0', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const task = await h.add('Staying');

  for (const answer of ['n\n', '\n', 'nonsense\n', '']) {
    const res = await runAt(h, { tty: true, stdin: answer }, 'rm', task.id, '--purge');
    assert.equal(res.code, exit.OK, JSON.stringify(answer));
    assert.match(res.stderr, /Cancelled; nothing was purged/);
    assert.equal(res.stdout, '');
    assert.equal(await storedTotal(h), 1);
  }

  // Under --json the refusal is the documented shape rather than silence.
  const asJSON = await runAt(h, { tty: true, stdin: 'n\n' }, 'rm', task.id, '--purge', '--json');
  assert.equal(asJSON.code, exit.OK);
  const obj = JSON.parse(asJSON.stdout) as Record<string, unknown>;
  assert.deepEqual(obj['purged'], []);
  assert.equal(obj['count'], 0);
});

// "yes" in full is a yes too, and the answer is folded and trimmed.
test('the confirmation accepts y and yes in any case', async (t: TestContext) => {
  for (const answer of ['y', 'Y\n', 'yes\n', ' YES \n']) {
    // One store per answer, so a purge that went through cannot be mistaken
    // for one that did not.
    const h = await newHarness(t, commands);
    const task = await h.add('Going');
    const res = await runAt(h, { tty: true, stdin: answer }, 'rm', task.id, '--purge');
    assert.equal(res.code, exit.OK, JSON.stringify(answer));
    assert.equal(await storedTotal(h), 0, JSON.stringify(answer));
  }
});

test('purging a container needs --recursive', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const project = await container(h, 'project', 'Errands');
  await inside(h, 'Buy stamps', project.id);

  const res = await h.run('rm', project.id, '--purge', '--yes');
  assert.equal(res.code, exit.Usage);
  assert.match(res.stderr, /--recursive/);
  assertCleanFailure(t, res.stderr);
  assert.equal(await storedTotal(h), 2, 'the refusal deleted something');

  const purged = h.decode(await h.mustRun('rm', project.id, '--purge', '--recursive', '--yes', '--json'));
  assert.equal(purged['count'], 2);
  assert.equal(await storedTotal(h), 0);
});

// The prompt and the refusal both name the real number of rows, which is why
// the subtree is counted before anything is asked.
test('the count the prompt names includes the subtree', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const project = await container(h, 'project', 'Errands');
  await inside(h, 'one', project.id);
  await inside(h, 'two', project.id);

  const res = await runAt(h, { tty: true, stdin: 'n\n' }, 'rm', project.id, '--purge', '--recursive');
  assert.match(res.stderr, /Permanently delete 3 item\(s\)/);
});

test('purge resolves a short number from the last listing', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const first = await h.add('first');
  await h.add('second');
  await h.mustRun('ls');
  const purged = h.decode(await h.mustRun('rm', '1', '--purge', '--yes', '--json'));
  assert.deepEqual(purged['purged'], [first.id]);
});
