// `tdo repeat`, `tdo series`, `tdo review` and `tdo perspective`.
//
// The repeat half of repeat_in_container_test.go is about what completing a
// repeating action does to its container, which is `tdo done` — mark.go, and
// another agent's. What is here is the part this module owns: setting and
// ending a repeat, the series listing, the review listing and mark, and the
// four perspective verbs.

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import * as exit from '@todocloud/core/exit';
import { Filter } from '@todocloud/core/store/filter';
import { successor } from '@todocloud/core/recur';
import * as id from '@todocloud/core/id';

import {
  perspectiveCommand,
  repeatCommand,
  reviewCommand,
  seriesCommand,
} from './repeat.ts';
import { showCommand } from './show.ts';
import { folderCommand, projectCommand } from './structure.ts';
import { type Harness, newHarness } from './testsupport.ts';

function harness(t: TestContext): Promise<Harness> {
  return newHarness(t, [
    repeatCommand,
    seriesCommand,
    reviewCommand,
    perspectiveCommand,
    projectCommand,
    folderCommand,
    showCommand,
  ]);
}

test('repeat sets an interval and names the series', async (t: TestContext) => {
  const h = await harness(t);
  const task = await h.add('Water the plants');

  const got = h.taskOf(await h.mustRun('repeat', task.id, '1w', '--json'));
  assert.deepEqual(got['repeat'], { every: '1w', method: 'fixed' });
  // The first instance names the series, so a successor can be tied to it
  // without a second generator.
  assert.equal(got['series_id'], task.id);
});

test('repeat reads a method after the interval', async (t: TestContext) => {
  const h = await harness(t);
  const task = await h.add('Pay the rent');

  const got = h.taskOf(
    await h.mustRun('repeat', task.id, '1mo:from_completion', '--json'),
  );
  assert.deepEqual(got['repeat'], { every: '1mo', method: 'from_completion' });
});

// The series id stays: the instances already completed are still one series,
// and `tdo series` must keep finding them.
test('repeat --stop ends the series but keeps its id', async (t: TestContext) => {
  const h = await harness(t);
  const task = await h.add('Water the plants');
  await h.mustRun('repeat', task.id, '1w');

  const stopped = h.taskOf(await h.mustRun('repeat', task.id, '--stop', '--json'));
  assert.equal(stopped['repeat'], null);
  assert.equal(stopped['series_id'], task.id);
});

test('repeat refuses the wrong number of arguments', async (t: TestContext) => {
  const h = await harness(t);
  const task = await h.add('Water the plants');

  for (const args of [
    ['repeat'],
    ['repeat', task.id],
    ['repeat', task.id, '1w', 'extra'],
    ['repeat', '--stop'],
    ['repeat', task.id, '1w', '--stop'],
  ]) {
    const res = await h.run(...args);
    assert.equal(res.code, exit.Usage, `${args.join(' ')}: ${res.stderr}`);
  }
});

test('repeat refuses an unreadable interval and changes nothing', async (t: TestContext) => {
  const h = await harness(t);
  const task = await h.add('Water the plants');

  const res = await h.run('repeat', task.id, 'whenever');
  assert.equal(res.code, exit.Usage, res.stderr);
  assert.equal(h.taskOf(await h.mustRun('show', task.id, '--json'))['repeat'], null);
});

// A repeat is a write, so it names the store when the provider was
// overridden; a `--provider` that merely restates the configured one is not
// an override and says nothing.
test('repeat announces an overridden store', async (t: TestContext) => {
  const h = await harness(t);
  const task = await h.add('Water the plants');

  const res = await h.mustRun('repeat', task.id, '1w', '--provider', 'sqlite');
  assert.match(res.stderr, /--provider selected it for this command only/);
});

// An item that has never repeated is a series of one, which is a truthful
// answer rather than an error.
test('series lists one instance for an item that never repeated', async (t: TestContext) => {
  const h = await harness(t);
  const task = await h.add('Pay the invoice');

  const res = await h.mustRun('series', task.id, '--json');
  const obj = h.decode(res);
  assert.equal(obj['series_id'], task.id);
  assert.equal(obj['count'], 1);
});

// The instances are every status, including deleted: the point of looking at
// a series is to see its history.
test('series lists every instance, tombstones included', async (t: TestContext) => {
  const h = await harness(t);
  const first = await h.add('Water the plants');
  await h.mustRun('repeat', first.id, '1w');

  await h.withStore(async (st) => {
    const stored = await st.get(first.id);
    const next = successor(stored, new Date(), id.New());
    await st.add(next);
    // The first instance is finished and then tombstoned, which is what a
    // long-lived series looks like.
    const done = stored.clone();
    done.deletedAt = new Date();
    await st.update(done);
  });

  const obj = h.decode(await h.mustRun('series', first.id, '--json'));
  assert.equal(obj['count'], 2, JSON.stringify(obj));
  assert.equal(obj['series_id'], first.id);
});

test('series expects exactly one reference', async (t: TestContext) => {
  const h = await harness(t);
  const task = await h.add('Pay the invoice');
  for (const args of [['series'], ['series', task.id, task.id]]) {
    assert.equal((await h.run(...args)).code, exit.Usage);
  }
});

test('review with nothing due says so and lists nothing', async (t: TestContext) => {
  const h = await harness(t);
  await h.add('a loose task');

  const res = await h.mustRun('review');
  assert.equal(res.stdout, '', 'an empty review writes nothing to stdout');
  assert.match(res.stderr, /Nothing is due for review\./);
});

// A human listing that finds nothing must leave the numbers alone. The
// sequence that found this: `tdo ls`, then a `tdo review` with nothing due,
// then `tdo done 1` — which reported that there is no task 1, because the
// empty review listing had overwritten the cache the `ls` installed. It takes
// the whole registry, because the cache `tdo ls` installs is the subject.
test('an empty review does not discard the cached numbers', async (t: TestContext) => {
  const h = await newHarness(t);
  await h.mustRun('add', 'the only task');

  // A human listing installs the numbers.
  await h.mustRun('ls');
  assert.equal((await h.run('show', '1')).code, 0, 'after `ls`, number 1 must resolve');

  // `review` finds nothing: nothing is a project and nothing has an interval.
  // It must not renumber anything.
  await h.mustRun('review');

  const got = await h.run('show', '1');
  assert.equal(
    got.code,
    0,
    `a listing that found nothing discarded the cached numbers: ${got.stderr}`,
  );
});

// With no reference this is a pure read (§4.2): it lists what is due and
// marks nothing, so a second run says the same thing.
test('review lists what is due without marking it', async (t: TestContext) => {
  const h = await harness(t);
  await h.mustRun('project', 'add', 'Kitchen', '--review', '1w');

  const first = h.tasksOf(await h.mustRun('review', '--json'));
  assert.equal(first.length, 1, JSON.stringify(first));
  const second = h.tasksOf(await h.mustRun('review', '--json'));
  assert.equal(second.length, 1, 'a read marked something reviewed');
});

test('review <ref> marks it reviewed and takes it off the list', async (t: TestContext) => {
  const h = await harness(t);
  const project = h.taskOf(await h.mustRun('project', 'add', 'Kitchen', '--review', '1w', '--json'));

  const marked = h.taskOf(await h.mustRun('review', String(project['id']), '--json'));
  assert.notEqual(marked['last_reviewed_at'], null);
  assert.deepEqual(h.tasksOf(await h.mustRun('review', '--json')), []);
});

// A container is typed far more often than an action, so a title resolves
// here as well as a number or an id prefix.
test('review accepts a container title', async (t: TestContext) => {
  const h = await harness(t);
  await h.mustRun('project', 'add', 'Kitchen', '--review', '1w');

  const marked = h.taskOf(await h.mustRun('review', 'Kitchen', '--json'));
  assert.equal(marked['title'], 'Kitchen');
});

test('review --interval sets the interval while marking', async (t: TestContext) => {
  const h = await harness(t);
  await h.mustRun('project', 'add', 'Kitchen');

  const marked = h.taskOf(await h.mustRun('review', 'Kitchen', '--interval', '1mo', '--json'));
  assert.deepEqual(marked['review_interval'], { every: '1mo' });
});

test('review refuses --interval with no item, and two references', async (t: TestContext) => {
  const h = await harness(t);
  await h.mustRun('project', 'add', 'Kitchen');

  const bare = await h.run('review', '--interval', '1w');
  assert.equal(bare.code, exit.Usage, bare.stderr);
  assert.match(bare.stderr, /--interval needs the item/);
  assert.equal((await h.run('review', 'Kitchen', 'Kitchen')).code, exit.Usage);
});

// ---------------------------------------------------------------------------
// Perspectives, the saved queries of §3.6.
// ---------------------------------------------------------------------------

test('perspective save, show, ls and rm', async (t: TestContext) => {
  const h = await harness(t);

  const saved = await h.mustRun('perspective', 'save', 'hot', '--', '--flagged');
  assert.match(saved.stdout, /^hot\n$/);

  const listed = await h.mustRun('perspective', 'ls', '--json');
  const ps = h.decode(listed)['perspectives'] as Record<string, unknown>[];
  assert.equal(ps.length, 1);
  assert.equal(ps[0]?.['name'], 'hot');
  // The wire shape is the documented one: snake_case timestamps, not the
  // camelCase of the ported interface.
  assert.ok(Object.hasOwn(ps[0] ?? {}, 'created_at'), JSON.stringify(ps[0]));
  assert.deepEqual((ps[0]?.['filter'] as Record<string, unknown>)['flagged'], true);

  const shown = h.decode(await h.mustRun('perspective', 'show', 'hot', '--json'));
  assert.equal((shown['perspective'] as Record<string, unknown>)['name'], 'hot');

  const removed = h.decode(await h.mustRun('perspective', 'rm', 'hot', '--json'));
  assert.equal(removed['removed'], 'hot');
  assert.equal(h.decode(await h.mustRun('perspective', 'ls', '--json'))['count'], 0);
});

test('perspective ls is empty with a hint, not an error', async (t: TestContext) => {
  const h = await harness(t);
  const res = await h.mustRun('perspective', 'ls');
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /No perspectives yet/);
});

// These are evaluated on the client, outside the stored Filter, so saving
// them would produce a perspective that does not mean what it says when it is
// run.
test('perspective save refuses the client-side flags', async (t: TestContext) => {
  const h = await harness(t);

  const res = await h.run('perspective', 'save', 'odd', '--', '--untagged');
  assert.equal(res.code, exit.Usage, res.stderr);
  assert.match(res.stderr, /cannot be saved in a perspective yet/);
  assert.equal(h.decode(await h.mustRun('perspective', 'ls', '--json'))['count'], 0);
});

test('perspective save needs a name', async (t: TestContext) => {
  const h = await harness(t);

  for (const args of [
    ['perspective', 'save'],
    ['perspective', 'save', '   '],
  ]) {
    const res = await h.run(...args);
    assert.equal(res.code, exit.Usage, `${args.join(' ')}: ${res.stderr}`);
  }
});

// A save with no `ls` flag at all stores the default listing, which is what
// `tdo ls` with no flags means: available items, open statuses. The guard Go
// wrote for "at least one flag" sits after a parse that always runs, so it is
// unreachable there too — the behaviour is ported, not the dead branch's
// message.
test('perspective save with no flags stores the default listing', async (t: TestContext) => {
  const h = await harness(t);
  await h.mustRun('perspective', 'save', 'bare');
  const stored = await h.withStore((st) => st.perspective('bare'));
  assert.equal(stored.filter.availability, 'available');
});

// The flags are the very ones `tdo ls` declares, so a flag it does not have
// is a usage error here as well.
test('perspective save refuses a flag tdo ls does not have', async (t: TestContext) => {
  const h = await harness(t);
  const res = await h.run('perspective', 'save', 'odd', '--', '--nosuchflag');
  assert.equal(res.code, exit.Usage, res.stderr);
  assert.match(res.stderr, /perspective save/);
});

// Flags, not arguments: a stray word after the name would otherwise be
// silently dropped from the saved query.
test('perspective save refuses an argument after the name', async (t: TestContext) => {
  const h = await harness(t);
  const res = await h.run('perspective', 'save', 'odd', '--', '--flagged', 'junk');
  assert.equal(res.code, exit.Usage, res.stderr);
  assert.match(res.stderr, /not arguments/);
});

test('perspective rejects a verb it does not have', async (t: TestContext) => {
  const h = await harness(t);

  for (const args of [
    ['perspective'],
    ['perspective', 'nope'],
    ['perspective', 'ls', 'junk'],
    ['perspective', 'show'],
    ['perspective', 'show', 'a', 'b'],
    ['perspective', 'rm'],
  ]) {
    const res = await h.run(...args);
    assert.equal(res.code, exit.Usage, `${args.join(' ')}: ${res.stderr}`);
  }
});

test('perspective show and rm report an unknown name as not found', async (t: TestContext) => {
  const h = await harness(t);

  assert.equal((await h.run('perspective', 'show', 'nope')).code, exit.NotFound);
  assert.equal((await h.run('perspective', 'rm', 'nope')).code, exit.NotFound);
});
