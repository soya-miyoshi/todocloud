// `tdo tag`: the port of tags_test.go — the promoted tag, the two
// availability rules it drives, and the command that sets it.

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import * as exit from '@todocloud/core/exit';
import * as id from '@todocloud/core/id';
import { type Kind, type Task, newTask } from '@todocloud/core/task';

import { addCommand } from './add.ts';
import type { CommandFactory } from './app.ts';
import { editCommand } from './edit.ts';
import { listCommand } from './list.ts';
import { showCommand } from './show.ts';
import { tagCommand, tagNames } from './tags.ts';
import { type Harness, type Result, newHarness } from './testsupport.ts';

const commands: readonly CommandFactory[] = [addCommand, editCommand, listCommand, showCommand, tagCommand];

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

/** tagsOf pulls the list out of a {"tags":[…]} response. */
function tagsOf(h: Harness, res: Result): Record<string, unknown>[] {
  const raw = h.decode(res)['tags'];
  if (!Array.isArray(raw)) {
    throw new Error(`no tags array in ${res.stdout}`);
  }
  return raw as Record<string, unknown>[];
}

/** tagNamed returns one tag from `tdo tag ls --json`. */
async function tagNamed(h: Harness, name: string): Promise<Record<string, unknown>> {
  for (const tag of tagsOf(h, await h.mustRun('tag', 'ls', '--json'))) {
    if ((tag['name'] as string).toLowerCase() === name.toLowerCase()) {
      return tag;
    }
  }
  throw new Error(`no tag named ${JSON.stringify(name)} in the listing`);
}

test('tag ls reports the status and the count', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  await h.mustRun('add', 'Mow the lawn', '--tag', 'home,errand');
  await h.mustRun('add', 'Call the plumber', '--tag', 'Home');

  const home = await tagNamed(h, 'home');
  assert.equal(home['count'], 2);
  assert.equal(home['status'], 'active');

  await h.mustRun('tag', 'hold', 'errand');
  assert.equal((await tagNamed(h, 'errand'))['status'], 'on_hold');
  await h.mustRun('tag', 'unhold', 'errand');
  assert.equal((await tagNamed(h, 'errand'))['status'], 'active');
  // `activate` is the second spelling of `unhold`.
  await h.mustRun('tag', 'hold', 'errand');
  await h.mustRun('tag', 'activate', 'errand');
  assert.equal((await tagNamed(h, 'errand'))['status'], 'active');
  await h.mustRun('tag', 'drop', 'errand');
  assert.equal((await tagNamed(h, 'errand'))['status'], 'dropped');

  // A status may be set on a tag nobody has used yet, and it is then listed
  // at zero: the hold is the point, not the count.
  await h.mustRun('tag', 'hold', 'someday');
  const someday = await tagNamed(h, 'someday');
  assert.equal(someday['count'], 0);
  assert.equal(someday['status'], 'on_hold');

  const unused = tagsOf(h, await h.mustRun('tag', 'ls', '--unused', '--json'));
  assert.equal(unused.length, 1);
  assert.equal(unused[0]?.['name'], 'someday');

  const held = tagsOf(h, await h.mustRun('tag', 'ls', '--status', 'on_hold', '--json'));
  assert.equal(held.length, 1);
  assert.equal(held[0]?.['name'], 'someday');

  // A tag is a context, not a piece of work, so it is never done.
  const done = await h.run('tag', 'ls', '--status', 'done');
  assert.equal(done.code, exit.Usage);
  assert.match(done.stderr, /a tag is never done/);
});

test('an empty tag listing says so on stderr', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const res = await h.mustRun('tag', 'ls');
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /No tags yet/);
  assert.equal(h.decode(await h.mustRun('tag', 'ls', '--json'))['count'], 0);
});

// §3.3: a tag that is not active holds back every item filed under it.
test('a tag on hold holds its items back', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const project = await container(h, 'project', 'Errands');
  const drill = await inside(h, 'Return the drill', project.id);
  await inside(h, 'Write the letter', project.id);
  await h.mustRun('edit', drill.id, '--tag', 'errand');

  assert.equal(h.tasksOf(await h.mustRun('ls', '--json')).length, 3);

  await h.mustRun('tag', 'hold', 'errand');
  for (const item of h.tasksOf(await h.mustRun('ls', '--json'))) {
    assert.notEqual(item['title'], 'Return the drill', 'a task whose tag is on hold must not be available');
  }
  const blocked = h.tasksOf(await h.mustRun('ls', '--blocked', '--json'));
  const found = blocked.find((item) => item['title'] === 'Return the drill');
  assert.ok(found !== undefined, '`tdo ls --blocked` must list the item its tag is holding back');
  const reason = found['blocked_by'] as Record<string, unknown>;
  assert.equal(reason['rule'], 'tag_status');
  assert.equal(reason['tag'], 'errand');

  // A container's tag holds back what is inside it, exactly as putting the
  // container itself on hold would.
  await h.mustRun('tag', 'unhold', 'errand');
  await h.mustRun('edit', project.id, '--tag', 'waiting');
  await h.mustRun('tag', 'hold', 'waiting');
  assert.deepEqual(h.tasksOf(await h.mustRun('ls', '--json')), []);
  for (const item of h.tasksOf(await h.mustRun('ls', '--blocked', '--json'))) {
    if (item['title'] !== 'Write the letter') {
      continue;
    }
    const childReason = item['blocked_by'] as Record<string, unknown>;
    assert.equal(childReason['rule'], 'ancestor_tag_status');
    assert.equal(childReason['tag'], 'waiting');
  }
});

test('tag rename keeps the status and the tasks', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  await h.mustRun('add', 'Call the bank', '--tag', 'phone');
  await h.mustRun('tag', 'hold', 'phone');

  await h.mustRun('tag', 'rename', 'phone', 'calls');
  const calls = await tagNamed(h, 'calls');
  assert.equal(calls['status'], 'on_hold');
  assert.equal(calls['count'], 1);
  for (const tag of tagsOf(h, await h.mustRun('tag', 'ls', '--json'))) {
    assert.notEqual((tag['name'] as string).toLowerCase(), 'phone', 'the old name must be gone');
  }
  const task = h.taskOf(await h.mustRun('ls', '--all', '--json'));
  assert.deepEqual(task['tags'], ['calls']);
});

test('tag rm takes the tag off every task that carries it', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  await h.mustRun('add', 'Call the bank', '--tag', 'phone');
  await h.mustRun('tag', 'hold', 'phone');

  const removed = h.decode(await h.mustRun('tag', 'rm', 'phone', '--json'));
  assert.deepEqual(removed['removed'], ['phone']);
  assert.equal(removed['count'], 1);
  assert.equal(removed['untagged'], 1, 'tag rm must report how many tasks it changed');
  assert.equal(tagsOf(h, await h.mustRun('tag', 'ls', '--json')).length, 0);
  // Removing the tag that was holding the task back lifts the hold.
  assert.equal(h.tasksOf(await h.mustRun('ls', '--json')).length, 1);

  // An unknown tag is not found.
  assert.equal((await h.run('tag', 'rm', 'nothing-is-filed-here')).code, exit.NotFound);
});

test('tag refuses a verb it does not have and a flag that belongs elsewhere', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  await h.mustRun('add', 'Call the bank', '--tag', 'phone');

  for (const args of [
    ['tag'],
    ['tag', 'frobnicate'],
    ['tag', 'ls', 'phone'],
    ['tag', 'hold'],
    ['tag', 'rename', 'phone'],
    ['tag', 'rename', 'a', 'b', 'c'],
    ['tag', 'rm'],
    // A comma-separated list would put a single tag called "home,errand" on
    // hold, which is not what anyone means.
    ['tag', 'hold', 'home,errand'],
    ['tag', 'hold', '   '],
    // --status filters `tdo tag ls`; the verbs set the status.
    ['tag', 'hold', 'phone', '--status', 'active'],
    ['tag', 'rm', 'phone', '--unused'],
  ]) {
    const got = await h.run(...args);
    assert.equal(got.code, exit.Usage, args.join(' '));
    assert.notEqual(got.stderr.trim(), '', args.join(' '));
  }

  // The same name twice in one spelling is not two tags.
  const got = await h.run('tag', 'rename', 'phone', 'Phone');
  assert.equal(got.code, exit.Usage);
  assert.match(got.stderr, /two different names/);
});

// The numbers a listing prints belong to the last listing of items. Tags are
// named, so `tdo tag ls` must not renumber anything: the bug this avoids is
// `tdo project 1` meaning a folder because `tdo folder ls` ran in between.
test('a tag listing does not renumber the items', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  await h.mustRun('add', 'First', '--tag', 'home');
  await h.mustRun('add', 'Second');
  await h.mustRun('ls');

  await h.mustRun('tag', 'ls');
  assert.equal(h.taskOf(await h.mustRun('show', '1', '--json'))['title'], 'First');
});

// Setting a status on several tags at once reports them all, read back from
// the store so the output is what is stored and not what was asked for.
test('tag hold reports every tag it wrote', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const res = await h.mustRun('tag', 'hold', 'home', 'errand', 'Home', '--json');
  const tags = tagsOf(h, res);
  assert.equal(tags.length, 2, 'the same name twice is one tag');
  assert.deepEqual(
    tags.map((tag) => tag['status']),
    ['on_hold', 'on_hold'],
  );
});

test('tagNames trims, de-duplicates and refuses a list', () => {
  assert.deepEqual(tagNames([' home ', 'Home', 'errand']), ['home', 'errand']);
  assert.throws(() => tagNames(['   ']), /a tag must have a name/);
  assert.throws(() => tagNames(['home,errand']), /looks like a list/);
  assert.throws(() => tagNames([]), /expected at least one tag/);
});
