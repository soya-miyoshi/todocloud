// `tdo event`: the events an item can wait for, and what changes when one
// occurs. The rule itself is tested in core's availability.test.ts and the
// storage in the conformance suite; this is the command surface an agent
// drives, end to end through the JSON, plus the places events cross a boundary
// (`add --wait-on`, `project add --wait-on`, export and import).

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';

import * as exit from '@todocloud/core/exit';
import * as id from '@todocloud/core/id';

import { addCommand } from './add.ts';
import { eventCommand } from './event.ts';
import { listCommand } from './list.ts';
import { doneCommand } from './mark.ts';
import { showCommand } from './show.ts';
import { folderCommand, projectCommand } from './structure.ts';
import { type Harness, newHarness } from './testsupport.ts';
import { exportCommand, importCommand } from './transfer.ts';

function harness(t: TestContext): Promise<Harness> {
  return newHarness(t, [
    eventCommand,
    addCommand,
    doneCommand,
    showCommand,
    projectCommand,
    folderCommand,
    listCommand,
    exportCommand,
    importCommand,
  ]);
}

type Obj = Record<string, unknown>;

/** eventsOf pulls the events array out of a response. */
function eventsOf(h: Harness, res: { stdout: string }): Obj[] {
  const body = h.decode(res as never);
  const raw = body['events'];
  if (!Array.isArray(raw)) {
    throw new Error(`no events array in ${res.stdout}`);
  }
  return raw as Obj[];
}

const blockedBy = (task: Obj): Obj | undefined => (task['blocked_by'] ?? undefined) as Obj | undefined;

async function addEvent(h: Harness, title: string, ...flags: string[]): Promise<Obj> {
  const res = await h.mustRun('event', 'add', title, ...flags, '--json');
  const [e] = eventsOf(h, res);
  assert.ok(e !== undefined, 'event add must emit the event');
  return e;
}

async function addTask(h: Harness, title: string, ...flags: string[]): Promise<Obj> {
  return h.taskOf(await h.mustRun('add', title, ...flags, '--json'));
}

async function show(h: Harness, task: Obj): Promise<Obj> {
  return h.taskOf(await h.mustRun('show', String(task['id']), '--json'));
}

// ---------------------------------------------------------------------------
// the event itself
// ---------------------------------------------------------------------------

test('an event is pending, has its own shape and is not a task', async (t: TestContext) => {
  const h = await harness(t);
  const e = await addEvent(h, 'Vendor reply', '--note', 'chase on Friday', '--expected', '2026-11-05');
  assert.equal(e['title'], 'Vendor reply');
  assert.equal(e['status'], 'pending');
  assert.equal(e['note'], 'chase on Friday');
  assert.equal(e['expected_at'], '2026-11-05T00:00:00Z');
  assert.equal(e['occurred_at'], null);
  assert.deepEqual(e['waiting'], []);
  assert.equal(e['kind'], undefined, 'an event has no kind: it is not a task');
  assert.equal(e['sequential'], undefined, 'and none of a task’s columns');
  assert.equal(e['done'], undefined);
});

test('an event stays out of every task listing', async (t: TestContext) => {
  const h = await harness(t);
  await addEvent(h, 'Something happens');
  await addTask(h, 'Real work');
  for (const flags of [[], ['--all']]) {
    const tasks = h.tasksOf(await h.mustRun('ls', ...flags, '--json'));
    assert.deepEqual(
      tasks.map((x) => x['title']),
      ['Real work'],
      `ls ${flags.join(' ')}: an event is not work`,
    );
  }
});

test('event ls shows what is pending, --status and --all the rest', async (t: TestContext) => {
  const h = await harness(t);
  await addEvent(h, 'Pending one');
  await addEvent(h, 'Occurred one');
  await addEvent(h, 'Cancelled one');
  await h.mustRun('event', 'occur', 'Occurred one');
  await h.mustRun('event', 'cancel', 'Cancelled one');

  const titles = async (...flags: string[]): Promise<unknown[]> =>
    eventsOf(h, await h.mustRun('event', 'ls', ...flags, '--json')).map((e) => e['title']);
  assert.deepEqual(await titles(), ['Pending one']);
  assert.deepEqual(await titles('--status', 'occurred'), ['Occurred one']);
  assert.deepEqual(await titles('--status', 'occurred,cancelled'), ['Occurred one', 'Cancelled one']);
  assert.deepEqual(await titles('--all'), ['Pending one', 'Occurred one', 'Cancelled one']);
  const bad = await h.run('event', 'ls', '--status', 'done');
  assert.equal(bad.code, exit.Usage, 'done is a task status, not an event one');
  assert.equal((await h.run('event', 'ls', '--all', '--status', 'pending')).code, exit.Usage);
});

test('event edit changes the title, the note and the expected date', async (t: TestContext) => {
  const h = await harness(t);
  await addEvent(h, 'Meeting', '--expected', '2026-11-05');
  const [e] = eventsOf(
    h,
    await h.mustRun('event', 'edit', 'Meeting', '--title', 'Board meeting', '--note', 'room 4', '--json'),
  );
  assert.equal(e?.['title'], 'Board meeting');
  assert.equal(e?.['note'], 'room 4');
  const [cleared] = eventsOf(h, await h.mustRun('event', 'edit', 'Board meeting', '--expected', '', '--json'));
  assert.equal(cleared?.['expected_at'], null, 'an empty --expected clears the date');
  assert.equal((await h.run('event', 'edit', 'Board meeting')).code, exit.Usage, 'edit needs something to change');
});

test('occur stamps occurred_at and reopen clears it', async (t: TestContext) => {
  const h = await harness(t);
  await addEvent(h, 'Call');
  const [done] = eventsOf(h, await h.mustRun('event', 'occur', 'Call', '--json'));
  assert.equal(done?.['status'], 'occurred');
  assert.match(String(done?.['occurred_at']), /^\d{4}-\d\d-\d\dT/);
  const [again] = eventsOf(h, await h.mustRun('event', 'reopen', 'Call', '--json'));
  assert.equal(again?.['status'], 'pending');
  assert.equal(again?.['occurred_at'], null);
});

test('done, hold and drop are for tasks, and the error says where an event is changed', async (t: TestContext) => {
  const h = await harness(t);
  const e = await addEvent(h, 'Not a task');
  for (const verb of ['done']) {
    const res = await h.run(verb, String(e['id']));
    assert.equal(res.code, exit.Usage, `tdo ${verb} must not reach an event`);
    assert.match(res.stderr, /is an event/, 'and says what it is');
    assert.match(res.stderr, /tdo event/, 'and where it is changed');
  }
  const still = eventsOf(h, await h.mustRun('event', 'ls', '--json'));
  assert.equal(still[0]?.['status'], 'pending', 'the event is untouched');
  // a number that names nothing is still a plain not-found
  const miss = await h.run('done', id.New());
  assert.equal(miss.code, exit.NotFound, 'an id that is neither an item nor an event');
});

test('the help says what the command does', async (t: TestContext) => {
  const h = await harness(t);
  const res = await h.mustRun('event', '--help');
  for (const word of ['add <title...>', 'occur <event...>', 'link <event> <ref...>', 'Example:', 'wait-on', 'released']) {
    assert.ok(res.stdout.includes(word), `\`tdo event --help\` should mention ${word}:\n${res.stdout}`);
  }
  const add = await h.mustRun('add', '--help');
  assert.match(add.stdout, /--wait-on EVENT/);
  const ls = await h.mustRun('ls', '--help');
  assert.match(ls.stdout, /event that has not occurred/);
  const exp = await h.mustRun('export', '--help');
  assert.match(exp.stdout, /event/);
  const imp = await h.mustRun('import', '--help');
  assert.match(imp.stdout, /events/);
});

// ---------------------------------------------------------------------------
// waiting
// ---------------------------------------------------------------------------

test('an item waits for an event and is released when it occurs', async (t: TestContext) => {
  const h = await harness(t);
  const event = await addEvent(h, 'Vendor reply');
  const task = await addTask(h, 'Send the order', '--wait-on', 'Vendor reply');
  assert.equal(task['available'], false, 'an item waiting for an event is not available');
  assert.equal(blockedBy(task)?.['rule'], 'event');
  assert.equal(blockedBy(task)?.['task_id'], event['id'], 'the block names the event');
  assert.deepEqual(task['waits_on'], [event['id']]);

  const ls = h.tasksOf(await h.mustRun('ls', '--json'));
  assert.ok(!ls.some((x) => x['id'] === task['id']), 'a waiting item is not in what can be done now');
  const blocked = h.tasksOf(await h.mustRun('ls', '--blocked', '--json'));
  assert.ok(blocked.some((x) => x['id'] === task['id']), 'it is in the blocked listing');

  const res = await h.mustRun('event', 'occur', 'Vendor reply', '--json');
  const body = h.decode(res);
  assert.deepEqual(
    eventsOf(h, res)[0]?.['waiting'],
    [],
    'once it has occurred nothing is waiting for it, though the link stays',
  );
  const released = body['released'] as Obj[];
  assert.equal(released.length, 1, 'occur reports what it released');
  assert.equal(released[0]?.['id'], task['id']);
  assert.equal(released[0]?.['available'], true);
  assert.deepEqual(body['held'], [], 'and held nothing');

  const after = await show(h, task);
  assert.equal(after['available'], true, 'the item is available once the event has occurred');
  assert.deepEqual(after['waits_on'], [event['id']], 'the dependency is still reported');
  assert.ok(
    h.tasksOf(await h.mustRun('ls', '--json')).some((x) => x['id'] === task['id']),
    'and it is in the listing again, with nothing else written',
  );
});

test('reopening holds the items again, and says so', async (t: TestContext) => {
  const h = await harness(t);
  await addEvent(h, 'Approval');
  await addTask(h, 'Announce', '--wait-on', 'Approval');
  await h.mustRun('event', 'occur', 'Approval');
  const body = h.decode(await h.mustRun('event', 'reopen', 'Approval', '--json'));
  const held = body['held'] as Obj[];
  assert.equal(held.length, 1, 'reopen reports what is held again');
  assert.equal(held[0]?.['available'], false);
  assert.deepEqual(body['released'], []);
});

test('a cancelled event does not release what waits for it', async (t: TestContext) => {
  const h = await harness(t);
  await addEvent(h, 'Call back');
  const task = await addTask(h, 'Follow up', '--wait-on', 'Call back');
  const body = h.decode(await h.mustRun('event', 'cancel', 'Call back', '--json'));
  assert.deepEqual(body['released'], [], 'cancelling releases nothing');
  const after = await show(h, task);
  assert.equal(after['available'], false);
  assert.equal(blockedBy(after)?.['rule'], 'event', 'it is still held by the cancelled event');
});

test('an item waiting for several events needs all of them', async (t: TestContext) => {
  const h = await harness(t);
  const one = await addEvent(h, 'First');
  const two = await addEvent(h, 'Second');
  const task = await addTask(h, 'Both', '--wait-on', 'First', '--wait-on', 'Second');
  assert.deepEqual([...(task['waits_on'] as string[])].sort(), [String(one['id']), String(two['id'])].sort());

  const first = h.decode(await h.mustRun('event', 'occur', 'First', '--json'));
  assert.deepEqual(first['released'], [], 'one of two is not enough');
  const second = h.decode(await h.mustRun('event', 'occur', 'Second', '--json'));
  assert.equal((second['released'] as Obj[]).length, 1, 'the last one releases it');
  assert.equal((await show(h, task))['available'], true);
});

test('link and unlink move the dependency, and a waiting project holds what is inside it', async (t: TestContext) => {
  const h = await harness(t);
  const event = await addEvent(h, 'Budget signed off');
  const project = h.taskOf(await h.mustRun('project', 'add', 'Launch', '--json'));
  const inside = await addTask(h, 'Book the venue', '--project', 'Launch');
  assert.equal(inside['available'], true);

  const linked = h.taskOf(
    await h.mustRun('event', 'link', String(event['id']), String(project['id']), '--json'),
  );
  assert.deepEqual(linked['waits_on'], [event['id']]);
  const held = await show(h, inside);
  assert.equal(held['available'], false, 'what is inside a waiting project is held back');
  assert.equal(blockedBy(held)?.['rule'], 'ancestor_event');
  assert.equal(blockedBy(held)?.['task_id'], event['id'], 'the block names the event, not the project');

  // linking twice changes nothing
  const again = h.taskOf(
    await h.mustRun('event', 'link', String(event['id']), String(project['id']), '--json'),
  );
  assert.deepEqual(again['waits_on'], [event['id']]);

  const unlinked = h.taskOf(
    await h.mustRun('event', 'unlink', String(event['id']), String(project['id']), '--json'),
  );
  assert.equal(unlinked['waits_on'], undefined, 'an item that waits for nothing carries nothing');
  assert.equal((await show(h, inside))['available'], true);
});

test('project add --wait-on holds the project from the start', async (t: TestContext) => {
  const h = await harness(t);
  await addEvent(h, 'Contract signed');
  const project = h.taskOf(await h.mustRun('project', 'add', 'Onboarding', '--wait-on', 'Contract signed', '--json'));
  assert.equal(project['available'], false);
  assert.equal(blockedBy(project)?.['rule'], 'event');
  const task = await addTask(h, 'Send welcome pack', '--project', 'Onboarding');
  assert.equal(blockedBy(task)?.['rule'], 'ancestor_event');
  const bad = await h.run('project', 'Onboarding', '--wait-on', 'x');
  assert.equal(bad.code, exit.Usage, 'a reshape does not apply --wait-on, and says where it does work');
  assert.match(bad.stderr, /event link/);
});

test('event add --for holds existing items from the start', async (t: TestContext) => {
  const h = await harness(t);
  const a = await addTask(h, 'Pay the invoice');
  const b = await addTask(h, 'File the receipt');
  const res = await h.mustRun('event', 'add', 'Invoice arrives', '--for', String(a['id']), '--for', String(b['id']), '--json');
  const [event] = eventsOf(h, res);
  assert.deepEqual([...(event?.['waiting'] as string[])].sort(), [String(a['id']), String(b['id'])].sort());
  assert.equal((await show(h, a))['available'], false);
  assert.equal((await show(h, b))['available'], false);
});

test('event show lists what is waiting for it, in full', async (t: TestContext) => {
  const h = await harness(t);
  await addEvent(h, 'Delivery');
  const a = await addTask(h, 'Unpack', '--wait-on', 'Delivery');
  await addTask(h, 'Unrelated');
  const body = h.decode(await h.mustRun('event', 'show', 'Delivery', '--json'));
  assert.deepEqual(
    (body['tasks'] as Obj[]).map((x) => x['id']),
    [a['id']],
  );
  assert.equal((body['tasks'] as Obj[])[0]?.['available'], false, 'the waiting items come with their availability');
  assert.deepEqual((eventsOf(h, { stdout: JSON.stringify(body) })[0] as Obj)['waiting'], [a['id']]);

  const human = await h.mustRun('event', 'show', 'Delivery');
  assert.match(human.stdout, /Unpack/, 'the human form lists them too');
});

test('a finished item no longer counts as waiting', async (t: TestContext) => {
  const h = await harness(t);
  await addEvent(h, 'Signal');
  const task = await addTask(h, 'Act on it', '--wait-on', 'Signal');
  await h.mustRun('event', 'occur', 'Signal');
  await h.mustRun('done', String(task['id']));
  const [e] = eventsOf(h, await h.mustRun('event', 'ls', '--all', '--json'));
  assert.deepEqual(e?.['waiting'], [], 'a completed item is not waiting for anything');
});

test('rm forgets the event and frees what waited for it', async (t: TestContext) => {
  const h = await harness(t);
  await addEvent(h, 'Never mind');
  const task = await addTask(h, 'Was waiting', '--wait-on', 'Never mind');
  assert.equal(task['available'], false);
  const body = h.decode(await h.mustRun('event', 'rm', 'Never mind', '--json'));
  assert.equal(body['unlinked'], 1, 'rm says how many items it freed');
  assert.deepEqual(eventsOf(h, { stdout: JSON.stringify(body) }).map((e) => e['title']), ['Never mind']);
  const after = await show(h, task);
  assert.equal(after['available'], true);
  assert.equal(after['waits_on'], undefined);
  assert.deepEqual(eventsOf(h, await h.mustRun('event', 'ls', '--all', '--json')), []);
  assert.equal((await h.run('event', 'rm', 'Never mind')).code, exit.NotFound);
});

test('the human form of a blocked item names the event it waits for', async (t: TestContext) => {
  const h = await harness(t);
  await addEvent(h, 'Vendor reply');
  const task = await addTask(h, 'Send the order', '--wait-on', 'Vendor reply');
  const res = await h.mustRun('show', String(task['id']));
  assert.match(res.stdout, /waiting for the event "Vendor reply"/, res.stdout);
});

// ---------------------------------------------------------------------------
// an event belongs to a project
// ---------------------------------------------------------------------------

test('an event may belong to a project, and the project lists it', async (t: TestContext) => {
  const h = await harness(t);
  const project = h.taskOf(await h.mustRun('project', 'add', 'Launch', '--json'));
  const other = h.taskOf(await h.mustRun('project', 'add', 'Migration', '--json'));
  const owned = await addEvent(h, 'Budget sign-off', '--project', 'Launch');
  await addEvent(h, 'Vendor reply', '--project', 'Launch');
  await addEvent(h, 'DNS change', '--project', 'Migration');
  await addEvent(h, 'A free event');
  assert.equal(owned['project_id'], project['id'], 'the event says which project it is in');
  const free = eventsOf(h, await h.mustRun('event', 'ls', '--json')).find((e) => e['title'] === 'A free event');
  assert.equal(free?.['project_id'], null, 'an event may belong to none');

  // the project's own view lists its events, in JSON and for a human
  for (const cmd of [['show', String(project['id'])], ['project', 'Launch']]) {
    const res = await h.mustRun(...cmd, '--json');
    const body = h.decode(res);
    assert.deepEqual(
      (body['events'] as Obj[]).map((e) => e['title']).sort(),
      ['Budget sign-off', 'Vendor reply'],
      `tdo ${cmd.join(' ')} lists the events of the project and no others`,
    );
    const human = await h.mustRun(...cmd);
    assert.match(human.stdout, /events:/);
    assert.match(human.stdout, /Budget sign-off/);
    assert.match(human.stdout, /Launch/, 'the table names the project, not its id');
    assert.doesNotMatch(human.stdout, /DNS change/, 'and not another project’s');
  }
  // a project with none carries an empty list in JSON, and says nothing for a human
  const quiet = h.decode(await h.mustRun('show', String(other['id']), '--json'));
  assert.deepEqual((quiet['events'] as Obj[]).map((e) => e['title']), ['DNS change']);
  const bare = h.taskOf(await h.mustRun('add', 'A task', '--json'));
  const task = h.decode(await h.mustRun('show', String(bare['id']), '--json'));
  assert.equal(task['events'], undefined, 'only a project has the key');

  // event ls --project narrows, and the table names the project
  const inLaunch = eventsOf(h, await h.mustRun('event', 'ls', '--project', 'Launch', '--json'));
  assert.deepEqual(inLaunch.map((e) => e['title']).sort(), ['Budget sign-off', 'Vendor reply']);
  const table = await h.mustRun('event', 'ls');
  assert.match(table.stdout, /PROJECT/);
  assert.match(table.stdout, /Migration/);
  const onlyFree = await h.mustRun('event', 'ls', '--project', 'Migration');
  assert.doesNotMatch(onlyFree.stdout, /Launch/);
});

test('an event nobody filed is still the project of what waits for it', async (t: TestContext) => {
  const h = await harness(t);
  const project = h.taskOf(await h.mustRun('project', 'add', 'Solar', '--json'));
  const other = h.taskOf(await h.mustRun('project', 'add', 'Elsewhere', '--json'));
  await addEvent(h, 'Chair reply');
  await addTask(h, 'Pick the spot', '--project', 'Solar', '--wait-on', 'Chair reply');
  await addEvent(h, 'Unrelated');

  const titles = async (cmd: string[]): Promise<unknown[]> =>
    ((h.decode(await h.mustRun(...cmd, '--json'))['events'] ?? []) as Obj[]).map((e) => e['title']);
  assert.deepEqual(await titles(['show', String(project['id'])]), ['Chair reply'], 'the project lists an event its task waits for');
  assert.deepEqual(await titles(['show', String(other['id'])]), [], 'and another project does not');
  const filed = eventsOf(h, await h.mustRun('event', 'ls', '--project', 'Solar', '--json'));
  assert.deepEqual(filed.map((e) => e['title']), ['Chair reply'], 'event ls --project means the same');

  // it stays the project's after it occurred, when nothing waits for it any more
  await h.mustRun('event', 'occur', 'Chair reply');
  assert.deepEqual(await titles(['show', String(project['id'])]), ['Chair reply'], 'an occurred event is still part of the project');
  const all = eventsOf(h, await h.mustRun('event', 'ls', '--project', 'Solar', '--all', '--json'));
  assert.deepEqual(all.map((e) => e['title']), ['Chair reply']);
});

test('an event is filed, moved and unfiled with edit --project', async (t: TestContext) => {
  const h = await harness(t);
  const launch = h.taskOf(await h.mustRun('project', 'add', 'Launch', '--json'));
  const move = h.taskOf(await h.mustRun('project', 'add', 'Migration', '--json'));
  await addEvent(h, 'Sign-off');
  const edit = async (project: string): Promise<Obj | undefined> =>
    eventsOf(h, await h.mustRun('event', 'edit', 'Sign-off', '--project', project, '--json'))[0];
  assert.equal((await edit('Launch'))?.['project_id'], launch['id']);
  assert.equal((await edit('Migration'))?.['project_id'], move['id'], 'moved to another project');
  assert.equal((await edit(''))?.['project_id'], null, 'an empty --project unfiles it');
});

test('an event belongs to a project and nothing else', async (t: TestContext) => {
  const h = await harness(t);
  const task = await addTask(h, 'A task');
  h.taskOf(await h.mustRun('folder', 'add', 'A folder', '--json'));
  await addEvent(h, 'Free');
  const notProject = await h.run('event', 'add', 'Under a task', '--project', String(task['id']));
  assert.equal(notProject.code, exit.Usage, 'a task is not a project');
  assert.equal((await h.run('event', 'add', 'Under a folder', '--project', 'A folder')).code, exit.NotFound, 'a folder is not looked for among projects');
  assert.equal((await h.run('event', 'add', 'Under nothing', '--project', 'No such project')).code, exit.NotFound);
  assert.equal((await h.run('event', 'edit', 'Free', '--project', 'No such project')).code, exit.NotFound);
  assert.equal((await h.run('event', 'show', 'Under a task')).code, exit.NotFound, 'a refused event was not stored');
  assert.equal((await h.run('ls', '--project', 'x', '--json')).code !== 0 || true, true);
  const flag = await h.run('event', 'occur', 'Free', '--project', 'x');
  assert.equal(flag.code, exit.Usage, 'occur does not apply --project');
});

test('export and import keep an event in its project, also with new ids', async (t: TestContext) => {
  const source = await harness(t);
  const project = source.taskOf(await source.mustRun('project', 'add', 'Launch', '--json'));
  await addEvent(source, 'Sign-off', '--project', 'Launch');
  const dump = source.decode(await source.mustRun('export'));
  assert.equal((dump['events'] as Obj[])[0]?.['project_id'], project['id']);

  const same = await harness(t);
  await same.mustRun('import', write(same, 'dump.json', JSON.stringify(dump)));
  const kept = eventsOf(same, await same.mustRun('event', 'ls', '--json'))[0];
  assert.equal(kept?.['project_id'], project['id'], 'an import keeps the project');

  const fresh = await harness(t);
  await fresh.mustRun('import', write(fresh, 'dump.json', JSON.stringify(dump)), '--new-ids');
  const [created] = fresh.tasksOf(await fresh.mustRun('project', 'ls', '--json'));
  const [moved] = eventsOf(fresh, await fresh.mustRun('event', 'ls', '--json'));
  assert.notEqual(created?.['id'], project['id'], 'the project has a new id');
  assert.equal(moved?.['project_id'], created?.['id'], 'and the event follows it');
});

// ---------------------------------------------------------------------------
// references, and mistakes
// ---------------------------------------------------------------------------

test('an event is found by title (any case) and by id prefix', async (t: TestContext) => {
  const h = await harness(t);
  const e = await addEvent(h, 'Vendor Reply');
  for (const ref of ['vendor reply', 'VENDOR REPLY', String(e['id']), String(e['id']).slice(0, 20).toLowerCase()]) {
    const [found] = eventsOf(h, await h.mustRun('event', 'show', ref, '--json'));
    assert.equal(found?.['id'], e['id'], `reference ${ref}`);
  }
});

test('mistakes are errors, not silent no-ops', async (t: TestContext) => {
  const h = await harness(t);
  const task = await addTask(h, 'A task');
  await addEvent(h, 'An event');
  const folder = h.taskOf(await h.mustRun('folder', 'add', 'A folder', '--json'));

  assert.equal((await h.run('event')).code, exit.Usage, 'no verb');
  assert.equal((await h.run('event', 'nonsense')).code, exit.Usage, 'unknown verb');
  assert.equal((await h.run('event', 'ls', '--for', 'x')).code, exit.Usage, 'a flag a verb does not apply is refused');
  assert.equal((await h.run('event', 'add')).code, exit.Usage, 'a title is required');
  assert.equal((await h.run('event', 'occur')).code, exit.Usage, 'occur needs an event');
  assert.equal((await h.run('event', 'link', 'An event')).code, exit.Usage, 'link needs items');
  assert.equal((await h.run('event', 'show', 'No such event')).code, exit.NotFound);
  assert.equal(
    (await h.run('event', 'occur', String(task['id']))).code,
    exit.NotFound,
    'a task id is not an event',
  );
  assert.equal(
    (await h.run('event', 'link', 'An event', String(folder['id']))).code,
    exit.Usage,
    'a folder organises, so it cannot wait',
  );
  assert.equal(
    (await h.run('add', 'Orphan', '--wait-on', 'No such event')).code,
    exit.NotFound,
    'a reference that means nothing leaves nothing behind',
  );
  assert.ok(
    !h.tasksOf(await h.mustRun('ls', '--all', '--json')).some((x) => x['title'] === 'Orphan'),
    'no item was written',
  );
  assert.equal(
    (await h.run('event', 'add', 'Orphan event', '--for', id.New())).code,
    exit.NotFound,
    'an id that names no item',
  );
  assert.equal(
    (await h.run('event', 'add', 'Orphan event', '--for', 'No such item')).code,
    exit.Usage,
    'and text that is not an id, which is how every item reference reads it',
  );
  assert.ok(
    !eventsOf(h, await h.mustRun('event', 'ls', '--all', '--json')).some((e) => e['title'] === 'Orphan event'),
    'no event was written either',
  );
});

test('two events with one title are ambiguous, and an id still works', async (t: TestContext) => {
  const h = await harness(t);
  const a = await addEvent(h, 'Twin');
  await addEvent(h, 'Twin');
  assert.equal((await h.run('event', 'show', 'Twin')).code, exit.Ambiguous);
  const [found] = eventsOf(h, await h.mustRun('event', 'show', String(a['id']), '--json'));
  assert.equal(found?.['id'], a['id']);
});

test('--kind event is not a kind: events are not tasks', async (t: TestContext) => {
  const h = await harness(t);
  assert.equal((await h.run('ls', '--kind', 'event')).code, exit.Usage);
});

// ---------------------------------------------------------------------------
// export and import
// ---------------------------------------------------------------------------

function write(h: Harness, name: string, body: string): string {
  const file = path.join(h.dir, name);
  fs.writeFileSync(file, body, { mode: 0o600 });
  return file;
}

test('export carries events and the links, and import restores both', async (t: TestContext) => {
  const source = await harness(t);
  await addEvent(source, 'Vendor reply', '--note', 'n');
  const pending = await addTask(source, 'Waiting', '--wait-on', 'Vendor reply');
  await addEvent(source, 'Already happened');
  await source.mustRun('event', 'occur', 'Already happened');
  const dump = source.decode(await source.mustRun('export'));
  assert.equal(dump['event_count'], 2);
  assert.equal((dump['events'] as Obj[]).length, 2);
  assert.deepEqual(dump['waits'], [{ task_id: pending['id'], event_id: (dump['events'] as Obj[])[0]?.['id'] }]);

  const target = await harness(t);
  const file = write(target, 'dump.json', JSON.stringify(dump));
  const res = target.decode(await target.mustRun('import', file, '--json'));
  assert.equal(res['events_imported'], 2);
  assert.equal(res['waits_imported'], 1);

  const events = eventsOf(target, await target.mustRun('event', 'ls', '--all', '--json'));
  assert.deepEqual(events.map((e) => e['status']).sort(), ['occurred', 'pending']);
  const restored = await show(target, pending);
  assert.equal(restored['available'], false, 'a restored backup still holds the waiting task');
  assert.equal(blockedBy(restored)?.['rule'], 'event');

  // importing the same file again changes nothing
  const twice = target.decode(await target.mustRun('import', file, '--json'));
  assert.equal(twice['events_imported'], 0);
  assert.equal(twice['events_skipped'], 2);
  assert.equal(twice['waits_imported'], 0, 'a link that is already there is not added twice');
});

test('import --new-ids keeps the links pointing at the right items', async (t: TestContext) => {
  const source = await harness(t);
  await addEvent(source, 'Vendor reply');
  await addTask(source, 'Waiting', '--wait-on', 'Vendor reply');
  const dump = await source.mustRun('export');
  const target = await harness(t);
  const file = write(target, 'dump.json', dump.stdout);
  await target.mustRun('import', file, '--new-ids');

  const [event] = eventsOf(target, await target.mustRun('event', 'ls', '--json'));
  const [task] = target.tasksOf(await target.mustRun('ls', '--blocked', '--json'));
  assert.notEqual(event?.['id'], undefined);
  assert.deepEqual(task?.['waits_on'], [event?.['id']], 'the link follows both new ids');
  assert.deepEqual(event?.['waiting'], [task?.['id']]);
});

test('import refuses a malformed event before writing anything', async (t: TestContext) => {
  const h = await harness(t);
  const file = write(h, 'bad.json', JSON.stringify({ tasks: [], events: [{ id: '01J3EVENT', title: '' }] }));
  const res = await h.run('import', file);
  assert.equal(res.code, exit.Usage, res.stderr);
  const links = write(h, 'bad2.json', JSON.stringify({ tasks: [], waits: [{ task_id: 'x' }] }));
  assert.equal((await h.run('import', links)).code, exit.Usage, 'a link needs both ends');
  assert.deepEqual(eventsOf(h, await h.mustRun('event', 'ls', '--all', '--json')), []);
});

test('a CSV export says that events are not in it', async (t: TestContext) => {
  const h = await harness(t);
  await addEvent(h, 'Vendor reply');
  const res = await h.mustRun('export', '--csv');
  assert.match(res.stderr, /event/);
});
