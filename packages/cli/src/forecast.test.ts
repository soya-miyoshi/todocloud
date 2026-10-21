// `tdo forecast`: the selection and the order are tested exhaustively in
// packages/core/src/forecast.test.ts; these tests cover what the command adds —
// that it reaches deferred tasks `tdo ls` hides, its output shape, its flag
// and that it writes nothing.

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import * as exit from '@todocloud/core/exit';

import { addCommand } from './add.ts';
import type { CommandFactory } from './app.ts';
import { forecastCommand } from './forecast.ts';
import { listCommand } from './list.ts';
import { doneCommand } from './mark.ts';
import { newHarness } from './testsupport.ts';

const commands: readonly CommandFactory[] = [addCommand, listCommand, doneCommand, forecastCommand];

/** day returns a date-only string this many days from today, in UTC. */
function day(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

test('forecast lists deferred and due tasks, which ls would not all show', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  await h.mustRun('add', 'Plain', '--json');
  await h.mustRun('add', 'Deferred', '--defer', day(3), '--json');
  await h.mustRun('add', 'Due', '--due', day(10), '--json');

  const titles = h.tasksOf(await h.mustRun('forecast', '--json')).map((x) => x['title']);
  assert.deepEqual(titles, ['Deferred', 'Due']);

  // The deferred one is not available, so the default listing leaves it out;
  // that gap is why the Forecast is a view of its own.
  const ls = h.tasksOf(await h.mustRun('ls', '--json')).map((x) => x['title']);
  assert.ok(!ls.includes('Deferred'));
});

test('forecast --json carries the listing shape and the size of the folded tail', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  await h.mustRun('add', 'Soon', '--defer', day(2), '--json');
  await h.mustRun('add', 'Much later', '--defer', day(30), '--json');

  const obj = h.decode(await h.mustRun('forecast', '--json'));
  assert.equal(obj['count'], 2);
  assert.equal(obj['later'], 1);
  const tasks = obj['tasks'] as Record<string, unknown>[];
  // The folded part is last, and nothing is dropped.
  assert.deepEqual(tasks.map((x) => x['title']), ['Soon', 'Much later']);
});

test('forecast --sort due reads by deadline, and refuses another order', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  await h.mustRun('add', 'Released first, due last', '--defer', day(1), '--due', day(6), '--json');
  await h.mustRun('add', 'Released later, due first', '--defer', day(2), '--due', day(3), '--json');

  const byDefer = h.tasksOf(await h.mustRun('forecast', '--json')).map((x) => x['title']);
  assert.deepEqual(byDefer, ['Released first, due last', 'Released later, due first']);
  const byDue = h
    .tasksOf(await h.mustRun('forecast', '--sort', 'due', '--json'))
    .map((x) => x['title']);
  assert.deepEqual(byDue, ['Released later, due first', 'Released first, due last']);

  assert.equal((await h.run('forecast', '--sort', 'title')).code, exit.Usage);
  assert.equal((await h.run('forecast', 'junk')).code, exit.Usage);
});

test('forecast leaves finished tasks out and an empty list is not an error', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const empty = await h.mustRun('forecast', '--json');
  assert.deepEqual(h.decode(empty)['tasks'], []);
  const human = await h.mustRun('forecast');
  assert.equal(human.stdout, '');
  assert.match(human.stderr, /tdo add/);

  const task = h.taskOf(await h.mustRun('add', 'Finish me', '--due', day(1), '--json'));
  await h.mustRun('done', task['id'] as string);
  assert.deepEqual(h.tasksOf(await h.mustRun('forecast', '--json')), []);
});

test('forecast says what has landed and what is folded, on stderr only', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  await h.mustRun('add', 'Overdue', '--due', day(-2), '--json');
  await h.mustRun('add', 'Far off', '--defer', day(20), '--json');

  const res = await h.mustRun('forecast');
  assert.match(res.stdout, /Overdue/);
  assert.match(res.stdout, /Far off/);
  assert.match(res.stderr, /1 task is due today or earlier/);
  assert.match(res.stderr, /1 task is deferred more than 7 days out/);
});

test('forecast numbers its rows so the mark commands can use them', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  await h.mustRun('add', 'Number me', '--due', day(1), '--json');
  await h.mustRun('forecast');
  await h.mustRun('done', '1');
  assert.deepEqual(h.tasksOf(await h.mustRun('forecast', '--json')), []);
});

test('forecast --day today carries what was due on an earlier day', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  await h.mustRun('add', 'Last week', '--due', day(-5), '--json');
  await h.mustRun('add', 'Today', '--due', day(0), '--json');
  await h.mustRun('add', 'Tomorrow', '--due', day(1), '--json');

  const res = await h.mustRun('forecast', '--day', 'today', '--json');
  const payload = JSON.parse(res.stdout) as Record<string, unknown>;
  assert.deepEqual((payload['tasks'] as Record<string, unknown>[]).map((x) => x['title']), [
    'Last week',
    'Today',
  ]);
  // There is no Past day to send the older one to, so the day says how much
  // of itself arrived before today instead.
  assert.equal(payload['past_due'], 1);
  assert.equal(payload['day'], 'today');
});

test('forecast --day takes one of the week and refuses anything else', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  await h.mustRun('add', 'Tomorrow', '--due', day(1), '--json');

  const titles = h.tasksOf(await h.mustRun('forecast', '--day', 'd1', '--json')).map((x) => x['title']);
  assert.deepEqual(titles, ['Tomorrow']);
  assert.deepEqual(h.tasksOf(await h.mustRun('forecast', '--day', 'd2', '--json')), []);

  const bad = await h.run('forecast', '--day', 'past');
  assert.equal(bad.code, exit.Usage);
  assert.match(bad.stderr, /--day must be today or d1 to d6/);

  const both = await h.run('forecast', '--day', 'today', '--week');
  assert.equal(both.code, exit.Usage);
});

test('forecast --week groups seven days and numbers across them', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  await h.mustRun('add', 'Today', '--due', day(0), '--json');
  await h.mustRun('add', 'Tomorrow', '--due', day(1), '--json');

  const res = await h.mustRun('forecast', '--week', '--json');
  const payload = JSON.parse(res.stdout) as Record<string, unknown>;
  const days = payload['days'] as Record<string, unknown>[];
  assert.equal(days.length, 7);
  assert.equal(days[0]?.['day'], 'today');
  assert.equal(days[0]?.['count'], 1);
  assert.equal(days[1]?.['count'], 1);
  assert.equal(payload['count'], 2);

  // One listing across the whole week, so the second day's first row is 2
  // and `tdo done 2` means what the reader sees on it.
  const human = await h.mustRun('forecast', '--week');
  assert.match(human.stdout, /1\s+.*Today/);
  assert.match(human.stdout, /2\s+.*Tomorrow/);
  await h.mustRun('done', '2');
  assert.deepEqual(
    h.tasksOf(await h.mustRun('forecast', '--json')).map((x) => x['title']),
    ['Today'],
  );
});

test('a day beyond the week is in neither --week nor --day, but is still in the list', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  await h.mustRun('add', 'Far off', '--due', day(20), '--json');

  const res = await h.mustRun('forecast', '--week', '--json');
  assert.equal((JSON.parse(res.stdout) as Record<string, unknown>)['count'], 0);
  // The flat list is the whole Forecast and leaves nothing out, which is the
  // difference between folding a tail and dropping it.
  assert.equal(h.tasksOf(await h.mustRun('forecast', '--json')).length, 1);
});

test('forecast --days is --week generalised, and reaches past the fold', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  await h.mustRun('add', 'Today', '--due', day(0), '--json');
  await h.mustRun('add', 'Far off', '--due', day(20), '--json');

  const res = await h.mustRun('forecast', '--days', '30', '--json');
  const payload = JSON.parse(res.stdout) as Record<string, unknown>;
  const days = payload['days'] as Record<string, unknown>[];
  assert.equal(days.length, 30);
  assert.equal(days[0]?.['day'], 'today');
  assert.equal(days[20]?.['day'], 'd20');
  assert.equal(days[20]?.['count'], 1);
  // The horizon folds the flat list; it does not shorten a run of days the
  // reader asked for by name.
  assert.equal(payload['count'], 2);

  // --days 7 is --week.
  const week = JSON.parse((await h.mustRun('forecast', '--days', '7', '--json')).stdout);
  assert.deepEqual(week, JSON.parse((await h.mustRun('forecast', '--week', '--json')).stdout));
});

test('forecast --days takes a whole number in range, and nothing else', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  for (const bad of ['0', '61', '7.5', '1e2', 'seven', '-1']) {
    const res = await h.run('forecast', '--days', bad);
    assert.equal(res.code, exit.Usage, `--days ${bad}`);
  }
  assert.match((await h.run('forecast', '--days', '61')).stderr, /between 1 and 60/);
  assert.equal((await h.run('forecast', '--days', '3', '--week')).code, exit.Usage);
  assert.equal((await h.run('forecast', '--days', '3', '--day', 'today')).code, exit.Usage);
});

test('forecast --compact leaves the empty days out of the human listing', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  await h.mustRun('add', 'Today', '--due', day(0), '--json');
  await h.mustRun('add', 'Thursday', '--due', day(4), '--json');

  const full = await h.mustRun('forecast', '--week');
  const compact = await h.mustRun('forecast', '--week', '--compact');
  const headings = (s: string): number => (s.match(/ — \d{4}-\d{2}-\d{2}/g) ?? []).length;
  assert.equal(headings(full.stderr), 7);
  assert.equal(headings(compact.stderr), 2);
  assert.match(compact.stderr, /5 empty days left out/);
  // The rows and their numbers are the week's, not the compacted view's.
  assert.equal(compact.stdout, full.stdout);

  // It is a reading aid, so it needs days to leave out and has no say over a
  // shape a machine reads.
  assert.equal((await h.run('forecast', '--compact')).code, exit.Usage);
  assert.equal((await h.run('forecast', '--week', '--compact', '--json')).code, exit.Usage);
});

test('forecast --overdue is the flat list narrowed to what is late', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  await h.mustRun('add', 'Last week', '--due', day(-5), '--json');
  await h.mustRun('add', 'Today', '--due', day(0), '--json');
  await h.mustRun('add', 'Tomorrow', '--due', day(1), '--json');
  await h.mustRun('add', 'Deferred', '--defer', day(2), '--json');

  const obj = h.decode(await h.mustRun('forecast', '--overdue', '--json'));
  // Due today is not late: a date written as a day is midnight, so counting
  // it as overdue by breakfast tells the reader nothing.
  assert.deepEqual((obj['tasks'] as Record<string, unknown>[]).map((x) => x['title']), [
    'Last week',
  ]);
  assert.equal(obj['count'], 1);
  assert.equal(obj['later'], 0);

  assert.equal((await h.run('forecast', '--overdue', '--week')).code, exit.Usage);
  assert.equal((await h.run('forecast', '--overdue', '--day', 'today')).code, exit.Usage);
});

test('forecast --overdue says so plainly when nothing is late', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  await h.mustRun('add', 'Tomorrow', '--due', day(1), '--json');

  const res = await h.mustRun('forecast', '--overdue');
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /Nothing is late/);
});
