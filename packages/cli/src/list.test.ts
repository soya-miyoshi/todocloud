// `tdo ls`, `tdo next` and `tdo inbox`: the ports of the parts of
// cli_test.go, gtd_test.go and hostile_values_test.go that test the reads.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';

import * as exit from '@todocloud/core/exit';
import * as id from '@todocloud/core/id';
import { Filter } from '@todocloud/core/store/filter';
import { type Kind, type Task, newTask } from '@todocloud/core/task';

import { addCommand } from './add.ts';
import type { CommandFactory } from './app.ts';
import { inboxCommand, listAliasCommand, listCommand, nextCommand, parseOrder } from './list.ts';
import { deferCommand, doneCommand, holdCommand } from './mark.ts';
import { editCommand } from './edit.ts';
import { removeCommand } from './remove.ts';
import { showCommand } from './show.ts';
import { type Harness, newHarness } from './testsupport.ts';

// The commands these tests drive. app.ts' registry is assembled separately,
// so the table is named here; everything still goes through RunWith, so
// nothing is tested that the binary does not do.
const commands: readonly CommandFactory[] = [
  addCommand,
  inboxCommand,
  listCommand,
  listAliasCommand,
  showCommand,
  nextCommand,
  doneCommand,
  holdCommand,
  deferCommand,
  editCommand,
  removeCommand,
];

/**
 * container writes a folder or a project straight into the store. `tdo
 * project add` belongs to structure.go, which is ported separately, so the
 * fixtures these tests need are built through the store instead.
 */
async function container(h: Harness, kind: Kind, title: string, parentID = ''): Promise<Task> {
  const t = newTask(id.New(), kind, title, new Date());
  t.parentID = parentID;
  await h.withStore(async (st) => st.add(t));
  return t;
}

/** inside adds a task under parentID and returns it as it was stored. */
async function inside(h: Harness, title: string, parentID: string): Promise<Task> {
  const t = newTask(id.New(), 'task', title, new Date());
  t.parentID = parentID;
  await h.withStore(async (st) => st.add(t));
  return t;
}

test('add then list round trips the task', async (t: TestContext) => {
  const h = await newHarness(t, commands);

  const added = h.taskOf(
    await h.mustRun('add', 'Pay', 'the', 'invoice', '--due', '2026-11-01', '--priority', '2', '--tag', 'finance', '--json'),
  );
  assert.equal(added['title'], 'Pay the invoice');
  assert.equal(added['due_at'], '2026-11-01T00:00:00Z');
  assert.equal(added['priority'], 2);

  const listed = await h.mustRun('ls', '--json');
  assert.equal(h.decode(listed)['count'], 1);
  assert.equal(h.tasksOf(listed)[0]?.['id'], added['id']);

  // The human-readable table is a table, and it stays narrow.
  const text = await h.mustRun('ls');
  assert.match(text.stdout, /Pay the invoice/);
  for (const line of text.stdout.replace(/\n+$/, '').split('\n')) {
    assert.ok([...line].length <= 80, `table line is wider than 80 columns: ${JSON.stringify(line)}`);
  }
});

// `tdo list` was an alias on the `ls` command in Go. The dispatcher resolves
// a command by name, so the alias is its own hidden entry; it must behave
// identically.
test('the list alias is the ls command', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  await h.mustRun('add', 'Aliased');
  assert.equal(h.tasksOf(await h.mustRun('list', '--json')).length, 1);
});

test('ls takes no arguments', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const got = await h.run('ls', 'finance');
  assert.equal(got.code, exit.Usage);
  assert.match(got.stderr, /ls takes no arguments/);
});

test('the filter flags select what they say', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  await h.mustRun('add', 'Soon', '--due', '2026-11-01', '--priority', '3', '--tag', 'finance', '--set', 'client=acme');
  await h.mustRun('add', 'Later', '--due', '2027-01-01', '--priority', '1', '--tag', 'ops');

  const one = async (...args: string[]): Promise<Record<string, unknown>> => {
    const tasks = h.tasksOf(await h.mustRun(...args));
    assert.equal(tasks.length, 1, `${args.join(' ')}: ${JSON.stringify(tasks)}`);
    return tasks[0] as Record<string, unknown>;
  };

  assert.equal((await one('ls', '--tag', 'finance', '--json'))['title'], 'Soon');
  // A date-only bound includes the day itself.
  assert.equal((await one('ls', '--due-before', '2026-11-01', '--json'))['title'], 'Soon');
  assert.equal((await one('ls', '--priority', '2', '--json'))['title'], 'Soon');
  await one('ls', '--where', 'client=acme', '--json');

  // The limit counts matching tasks, not tasks the store looked at.
  assert.equal((await one('ls', '--tag', 'ops', '--limit', '1', '--json'))['title'], 'Later');
  await one('ls', '--limit', '1', '--json');

  await h.mustRun('ls');
  await h.mustRun('done', '1');
  assert.equal((await one('ls', '--status', 'done', '--json'))['title'], 'Soon');
  assert.equal(h.tasksOf(await h.mustRun('ls', '--all', '--json')).length, 2);
  // The default listing is what can be worked on now, so the completed one
  // is gone from it without any flag being passed.
  assert.equal((await one('ls', '--json'))['title'], 'Later');

  assert.equal((await h.run('ls', '--all', '--blocked')).code, exit.Usage);
  assert.equal((await h.run('ls', '--sort', 'sideways')).code, exit.Usage);
  assert.equal((await h.run('ls', '--limit', '-1')).code, exit.Usage);
  assert.equal((await h.run('ls', '--kind', 'sideways')).code, exit.Usage);
  assert.equal((await h.run('ls', '--status', 'sideways')).code, exit.Usage);
  assert.equal((await h.run('ls', '--untagged', '--tag', 'ops')).code, exit.Usage);
  assert.equal((await h.run('ls', '--where', 'nope')).code, exit.Usage);
  assert.equal((await h.run('ls', '--estimate-under', '0')).code, exit.Usage);
  assert.equal((await h.run('ls', '--project', 'x', '--under', 'y')).code, exit.Usage);
  await h.mustRun('ls', '--sort', 'updated');
});

test('an empty listing puts nothing on stdout', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const res = await h.mustRun('ls');
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /tdo add/);
});

// §4.1: the default listing is the available work.
test('the default listing shows only what can be worked on', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const project = await container(h, 'project', 'Errands');
  await inside(h, 'Can be done', project.id);
  const deferred = await inside(h, 'Not yet', project.id);
  await h.mustRun('defer', deferred.id, '2099-01-01');

  const available = h.tasksOf(await h.mustRun('ls', '--kind', 'task', '--json'));
  assert.equal(available.length, 1);
  assert.equal(available[0]?.['title'], 'Can be done');
  assert.equal(available[0]?.['available'], true);
  assert.equal(available[0]?.['blocked_by'], null);

  // A project with available work is available itself.
  assert.equal(h.tasksOf(await h.mustRun('ls', '--json')).length, 2);

  const blocked = h.tasksOf(await h.mustRun('ls', '--deferred', '--json'));
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0]?.['id'], deferred.id);
  const reason = blocked[0]?.['blocked_by'] as Record<string, unknown>;
  assert.equal(reason['rule'], 'deferred');
  assert.equal(reason['task_id'], deferred.id);
});

test('a held project empties itself from every listing', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const project = await container(h, 'project', 'Later');
  const child = await inside(h, 'Something inside', project.id);

  await h.mustRun('hold', project.id);
  assert.equal(h.tasksOf(await h.mustRun('ls', '--json')).length, 0);

  const blocked = h.tasksOf(await h.mustRun('ls', '--blocked', '--json'));
  const found = blocked.find((task) => task['id'] === child.id);
  assert.ok(found !== undefined, 'the child should appear under --blocked');
  const reason = found['blocked_by'] as Record<string, unknown>;
  assert.equal(reason['rule'], 'ancestor_status');
  assert.equal(reason['task_id'], project.id);
});

test('--tree prints the nesting with indentation', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const folder = await container(h, 'folder', 'Home');
  const project = await container(h, 'project', 'Kitchen', folder.id);
  await inside(h, 'Fix the tap', project.id);

  const out = (await h.mustRun('ls', '--all', '--tree')).stdout;
  const lines = out.replace(/\n+$/, '').split('\n');
  assert.equal(lines.length, 4, `expected a header and three rows: ${JSON.stringify(out)}`);
  assert.ok(
    (lines[1] as string).indexOf('Home') < (lines[2] as string).indexOf('Kitchen'),
    `a project must be indented under its folder:\n${out}`,
  );
  assert.ok(
    (lines[2] as string).indexOf('Kitchen') < (lines[3] as string).indexOf('Fix the tap'),
    `an action must be indented under its project:\n${out}`,
  );
  for (const line of lines) {
    assert.ok([...line].length <= 80, `a tree row is wider than 80 columns: ${JSON.stringify(line)}`);
  }
});

test('next is the first action that can be worked on', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const project = await container(h, 'project', 'Move house');
  await h.withStore(async (st) => {
    const p = await st.get(project.id);
    p.sequential = true;
    await st.update(p);
  });
  const first = await inside(h, 'Pack', project.id);
  const second = await inside(h, 'Hire a van', project.id);

  assert.equal(h.taskOf(await h.mustRun('next', '--json'))['id'], first.id);

  const blocked = h.tasksOf(await h.mustRun('ls', '--blocked', '--json'));
  const found = blocked.find((task) => task['id'] === second.id);
  assert.ok(found !== undefined, 'the second action should be blocked');
  const reason = found['blocked_by'] as Record<string, unknown>;
  assert.equal(reason['rule'], 'sequential');
  assert.equal(reason['task_id'], first.id);

  await h.mustRun('done', first.id);
  assert.equal(h.taskOf(await h.mustRun('next', '--json'))['id'], second.id);
});

// Nothing available answers with the same shape a listing that found
// something uses, so a caller reads `.tasks[0]` either way.
test('next with nothing available emits the empty listing', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const res = await h.mustRun('next', '--json');
  const obj = h.decode(res);
  assert.deepEqual(obj['tasks'], []);
  assert.equal(obj['count'], 0);

  const human = await h.mustRun('next');
  assert.equal(human.stdout, '');
  assert.match(human.stderr, /tdo ls --blocked/);

  assert.equal((await h.run('next', 'junk')).code, exit.Usage);
});

test('a capture lands in the inbox and is filed by processing', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const project = await container(h, 'project', 'Errands');
  const captured = h.taskOf(await h.mustRun('add', 'Buy stamps', '--json'));
  assert.equal(captured['parent_id'], null);

  assert.equal(h.decode(await h.mustRun('inbox', '--count', '--json'))['count'], 1);
  const filed = h.taskOf(
    await h.mustRun('inbox', 'process', captured['id'] as string, '--project', 'Errands', '--json'),
  );
  assert.equal(filed['parent_id'], project.id);
  assert.equal(h.decode(await h.mustRun('inbox', '--count', '--json'))['count'], 0);
});

test('inbox refuses the flags that belong to inbox process, and the reverse', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const task = await h.add('Loose');

  for (const args of [
    ['inbox', '--project', 'Errands'],
    ['inbox', '--parent', 'x'],
    ['inbox', 'junk'],
    ['inbox', 'process'],
    ['inbox', 'process', task.id],
    ['inbox', 'process', task.id, '--count'],
    ['inbox', 'process', task.id, '--project', 'a', '--parent', 'b'],
  ]) {
    const got = await h.run(...args);
    assert.equal(got.code, exit.Usage, args.join(' '));
  }
});

test('the empty inbox says so on stderr', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const res = await h.mustRun('inbox');
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /The inbox is empty/);
  assert.equal(h.decode(await h.mustRun('inbox', '--json'))['count'], 0);
  assert.match((await h.mustRun('inbox', '--count')).stdout, /0 items in the inbox/);
});

// §3.6: running a perspective is exactly equivalent to typing its filter, so
// mixing the two is refused rather than merged.
test('a perspective is exactly the filter it saved', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  await h.mustRun('add', 'Important', '--flag');
  await h.mustRun('add', 'Ordinary');

  const now = new Date();
  await h.withStore(async (st) =>
    st.savePerspective({
      name: 'flagged',
      filter: new Filter({ flagged: true }),
      createdAt: now,
      updatedAt: now,
    }),
  );

  const tasks = h.tasksOf(await h.mustRun('ls', '--perspective', 'flagged', '--json'));
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.['title'], 'Important');

  // A filter flag beside --perspective would contradict it.
  const clash = await h.run('ls', '--perspective', 'flagged', '--flagged');
  assert.equal(clash.code, exit.Usage);
  assert.match(clash.stderr, /already decides the filter/);

  // A name nothing saved is not found.
  assert.equal((await h.run('ls', '--perspective', 'nothing-saved')).code, exit.NotFound);
});

// A hostile value is data: it must still match the filters that name it.
test('a hostile value still matches the filters', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  for (const value of [
    `'; DROP TABLE tasks; --`,
    `%s %d %#v %%`,
    `{{.}} {{range .Tasks}}{{end}}`,
    `100%_x`,
    `he said "it's" fine`,
    '絵文字 🙂 ja/en mixed',
    '--not-a-flag',
  ]) {
    const h2 = await newHarness(t, commands);
    // The flags take their values with = and the title comes after --, so a
    // value that begins with a dash is still read as data.
    await h2.mustRun('add', `--note=${value}`, '--tag=plain', `--set=attr=${value}`, '--json', '--', value);
    await h2.mustRun('add', 'an unrelated task', '--set', 'attr=something else');

    assert.equal(
      h2.tasksOf(await h2.mustRun('ls', '--all', '--where', `attr=${value}`, '--json')).length,
      1,
      `--where attr=${JSON.stringify(value)}`,
    );
    assert.equal(
      h2.tasksOf(await h2.mustRun('ls', '--all', '--where', `title=${value.trim()}`, '--json')).length,
      1,
      `--where title=${JSON.stringify(value)}`,
    );
    assert.equal(h2.tasksOf(await h2.mustRun('ls', '--all', '--tag', 'plain', '--json')).length, 1);
  }
  // The store the outer harness owns was never written to; it exists so the
  // loop above can build one per value, as the Go subtests did.
  assert.equal(h.tasksOf(await h.mustRun('ls', '--all', '--json')).length, 0);
});

// A control character in a title is data, and the human renderer must not let
// it act. Machine output is untouched: JSON escapes them itself.
test('the table escapes control characters', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  await h.mustRun('add', '--', '\x1b[31mred\x1b[0m');
  await h.mustRun('add', '--', 'first\rsecond');
  await h.mustRun('add', '--', 'bell\x07and\x00nul');

  const res = await h.mustRun('ls', '--all');
  for (const raw of ['\x1b', '\r', '\x07', '\x00']) {
    assert.ok(!res.stdout.includes(raw), `the table passed ${JSON.stringify(raw)} to the terminal`);
  }
  for (const escaped of ['\\e[31m', '\\r', '\\x07', '\\x00']) {
    assert.ok(res.stdout.includes(escaped), `the table does not show ${escaped}:\n${res.stdout}`);
  }
});

// A hostile value must not break the table: one row per task, the short
// numbers in order, and the 80-column budget respected.
test('a hostile value does not break the table', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const values = ['A'.repeat(10000), `C:\\temp\\%_\\\\`, '[1,2,3]', 'before\x00after', '../../etc/passwd'];
  for (const value of values) {
    await h.mustRun('add', '--tag=plain', '--', value);
  }

  const res = await h.mustRun('ls', '--all');
  const lines = res.stdout.replace(/\n+$/, '').split('\n');
  assert.equal(lines.length, values.length + 1);
  assert.ok((lines[0] as string).startsWith('#'), `the first line is not the header: ${lines[0]}`);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] as string;
    assert.ok(line.startsWith(`${i} `), `row ${i} does not start with its short number: ${line}`);
    assert.ok([...line].length <= 80, `row ${i} is ${[...line].length} columns wide`);
  }
});

// The rows the listing numbered are the rows `tdo done 1` acts on, so an
// empty listing must not discard the numbers already cached.
test('an empty listing does not discard the cached numbers', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const first = await h.add('first');
  await h.mustRun('ls');
  // A listing that matches nothing: the task is not flagged.
  await h.mustRun('ls', '--flagged');
  assert.equal(h.taskOf(await h.mustRun('show', '1', '--json'))['id'], first.id);
});

// parseOrder is the one piece of the selection that is pure, so it is pinned
// directly as well as through the command.
test('parseOrder maps --sort onto a store order', () => {
  assert.deepEqual(parseOrder(''), ['position', false]);
  assert.deepEqual(parseOrder(' position '), ['position', false]);
  assert.deepEqual(parseOrder('created'), ['created', false]);
  assert.deepEqual(parseOrder('updated'), ['updated', false]);
  assert.deepEqual(parseOrder('due'), ['due', false]);
  assert.deepEqual(parseOrder('defer'), ['defer', false]);
  // Title is sorted in the command layer, because a collation is not
  // something every provider would agree on.
  assert.deepEqual(parseOrder('title'), ['position', true]);
  assert.throws(() => parseOrder('sideways'), /--sort expects/);
});

// A read must never create the store: an empty task list is indistinguishable
// from the real one, so a mistyped path is reported rather than created.
test('a read never creates the store', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const db = path.join(h.dir, 'stray', 'tasks.db');
  h.env['TODOCLOUD_SQLITE_PATH'] = db;
  const res = await h.run('ls');
  assert.equal(res.code, exit.Config);
  // The driver's own words never reach the user.
  assert.ok(!res.stderr.includes('no such table'), res.stderr);
  assert.ok(!fs.existsSync(db), 'a read created the database file');
  assert.ok(!fs.existsSync(path.dirname(db)), 'a read created the directory tree');
});
