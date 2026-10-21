// New tests: the Go package had none. What is covered here is the part of the
// listing pipeline that runs on this side of the store — where the limit is
// applied, the two filters no Filter can express, and the title order. What
// the store's own pass answers is the conformance suite's business, and is
// not re-checked here.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { KeyPriority, StatusActive, StatusDone, StatusOnHold } from '../task.ts';
import { Condition } from '../store/store.ts';
import { Filter } from '../store/filter.ts';
import { openStatuses, run, Selection } from './select.ts';
import { idA, idB, idC, idD, MemStore, task } from './testsupport.ts';

test('openStatuses is what "the list" means', () => {
  // Done and dropped items are what an explicit status filter is for, and the
  // front end decides that, not the store.
  assert.deepEqual(openStatuses(), [StatusActive, StatusOnHold]);
});

/** four returns a store with four top-level tasks in position order. */
function four(): MemStore {
  const a = task(idA, { title: 'beta', position: 0 });
  const b = task(idB, { title: 'alpha', position: 1 });
  const c = task(idC, { title: 'Alpha', position: 2 });
  const d = task(idD, { title: 'gamma', position: 3 });
  return new MemStore([a, b, c, d]);
}

function titles(tasks: readonly { title: string }[]): string[] {
  return tasks.map((t) => t.title);
}

test('a selection with nothing of its own is the store\'s own listing', async () => {
  const got = await run(four(), new Selection());
  assert.deepEqual(titles(got), ['beta', 'alpha', 'Alpha', 'gamma']);
});

test('the limit is pushed to the store when nothing is filtered here', async () => {
  const got = await run(four(), new Selection({ limit: 2 }));
  assert.deepEqual(titles(got), ['beta', 'alpha']);
});

test('the limit counts what the caller asked to see, not what the store returned', async () => {
  // The whole reason the limit moves: with a client-side filter in play, a
  // limit the store applied would cut the list before this module had thrown
  // anything away, and `tdo ls --max 15m --limit 2` would return one item or
  // none.
  const st = four();
  const tagged = task(idA, { title: 'beta', position: 0 });
  tagged.setTags(['home']);
  await st.update(tagged);

  const got = await run(st, new Selection({ untagged: true, limit: 2 }));
  assert.deepEqual(titles(got), ['alpha', 'Alpha']);
});

test('untagged keeps only the items carrying no tag', async () => {
  const st = four();
  const tagged = task(idB, { title: 'alpha', position: 1 });
  tagged.setTags(['Home']);
  await st.update(tagged);

  assert.deepEqual(titles(await run(st, new Selection({ untagged: true }))), [
    'beta',
    'Alpha',
    'gamma',
  ]);
});

test('maxMinutes keeps the items shorter than it, and only the estimated ones', async () => {
  const st = four();
  for (const [id, minutes] of [
    [idA, 10],
    [idB, 15],
    [idC, 60],
  ] as const) {
    const t = await st.get(id);
    t.estimatedMinutes = minutes;
    await st.update(t);
  }
  // Strictly less than the bound, and an item with no estimate at all is not
  // "short": nothing is known about it.
  const got = await run(st, new Selection({ maxMinutes: 15 }));
  assert.deepEqual(titles(got), ['beta']);
  assert.deepEqual(titles(await run(st, new Selection({ maxMinutes: 61 }))), [
    'beta',
    'alpha',
    'Alpha',
  ]);
});

test('byTitle sorts case-insensitively and breaks a tie by id', async () => {
  const got = await run(four(), new Selection({ byTitle: true }));
  // "alpha" and "Alpha" fold to the same key, so the id decides — and idB
  // comes before idC, whichever order the store returned them in.
  assert.deepEqual(titles(got), ['alpha', 'Alpha', 'beta', 'gamma']);
  assert.deepEqual(
    (await run(four(), new Selection({ byTitle: true }))).map((t) => t.id),
    [idB, idC, idA, idD],
  );
});

test('byTitle is applied before the limit', async () => {
  const got = await run(four(), new Selection({ byTitle: true, limit: 2 }));
  assert.deepEqual(titles(got), ['alpha', 'Alpha']);
});

test('a condition on an open field is applied here, after the store', async () => {
  const st = four();
  for (const [id, priority] of [
    [idA, 1],
    [idB, 3],
    [idC, 3],
  ] as const) {
    const t = await st.get(id);
    t.fields[KeyPriority] = priority;
    await st.update(t);
  }
  const got = await run(
    st,
    new Selection({ cond: new Condition({ minPriority: 2 }) }),
  );
  assert.deepEqual(titles(got), ['alpha', 'Alpha']);
});

test('the store filter and a client-side filter compose', async () => {
  const st = four();
  const done = await st.get(idB);
  done.setStatus(StatusDone, new Date());
  await st.update(done);

  const got = await run(
    st,
    new Selection({
      filter: new Filter({ statuses: openStatuses() }),
      byTitle: true,
    }),
  );
  assert.deepEqual(titles(got), ['Alpha', 'beta', 'gamma']);
});

test('run does not write a limit back into the caller\'s selection', async () => {
  // Go passed the Selection by value, so setting the limit on the Filter
  // could not reach the caller. A class is a reference here, and a run that
  // left the limit behind would quietly cap the next run of a reused
  // selection — which is how a saved perspective would start returning
  // fewer items than it asked for.
  const s = new Selection({ limit: 2 });
  await run(four(), s);
  assert.equal(s.filter.limit, 0);
  assert.deepEqual(titles(await run(four(), s)), ['beta', 'alpha']);
});

test('an empty result is an empty array, never undefined', async () => {
  const got = await run(
    new MemStore(),
    new Selection({ untagged: true, byTitle: true }),
  );
  assert.deepEqual(got, []);
});
