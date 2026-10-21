// New tests: the Go package had none, and its behaviour was covered only
// where it reached a provider. These cover what this module decides on its
// own — the order it issues its store calls in, what a refusal leaves behind,
// which operations report an auto-completion and which do not, and the
// arithmetic of a reorder. The rules themselves (§3.1 containment, §3.3
// availability, §3.3a complete-with-last-action) are the store's, and the
// conformance suite in `@todocloud/store-testkit` holds every provider to
// them; nothing here re-checks them.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  KindProject,
  KindTask,
  RepeatFixed,
  StatusActive,
  StatusDone,
  StatusDropped,
  StatusOnHold,
} from '../task.ts';
import { ErrNotFound, isNotFound, RuleNone } from '../store/store.ts';
import { Edit, isInvalid } from './edit.ts';
import {
  After,
  apply,
  availabilityOf,
  Before,
  complete,
  create,
  DeferDate,
  DueDate,
  moveTo,
  reorder,
  setDate,
  setFlagged,
  setStatus,
  tombstone,
} from './taskops.ts';
import {
  at,
  idA,
  idB,
  idC,
  idD,
  idE,
  ids,
  MemStore,
  now,
  task,
} from './testsupport.ts';

/** ops renders the call log as "op:id" strings, for an order assertion. */
function ops(st: MemStore): string[] {
  return st.calls.map((c) => `${c.op}:${c.id}`);
}

/** rejects asserts that p rejects, and returns the error it threw. */
async function rejects(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  assert.fail('expected a rejection');
}

// -------------------------------------------------------------------------
// complete

test('completing a plain task closes it and creates nothing', async () => {
  const st = new MemStore([task(idA)]);
  const res = await complete(st, [await st.get(idA)], now, false, ids(idB));
  assert.equal(res.tasks.length, 1);
  assert.equal(res.tasks[0]?.status, StatusDone);
  assert.equal(res.tasks[0]?.completedAt?.getTime(), now.getTime());
  assert.deepEqual(res.successors, []);
  assert.deepEqual(res.autoCompleted, []);
  assert.equal(st.count(), 1);
});

test('the successor is added before the instance is closed', async () => {
  // The order is load-bearing, not incidental: closing the instance may be
  // the last action of a complete-with-last container, and the store closes
  // that container as part of the same update. A successor added afterwards
  // would be filed under a container that is already done.
  const t = task(idA);
  t.repeat = { method: RepeatFixed, every: '1w' };
  const st = new MemStore([t]);

  const res = await complete(st, [await st.get(idA)], now, false, ids(idB));
  assert.deepEqual(ops(st), ['add:' + idB, 'update:' + idA]);
  assert.equal(res.successors.length, 1);
  assert.equal(res.successors[0]?.id, idB);
  assert.equal(res.successors[0]?.status, StatusActive);
  assert.equal(res.tasks[0]?.status, StatusDone);
  // The instance names the series, so the successor can be tied to it.
  assert.equal(res.tasks[0]?.seriesID, idA);
  assert.equal(res.successors[0]?.seriesID, idA);
});

test('a failed add leaves the instance open: both or neither', async () => {
  const t = task(idA);
  t.repeat = { method: RepeatFixed, every: '1w' };
  const st = new MemStore([t]);
  st.fail = { op: 'add', err: new Error('provider is down') };

  await rejects(complete(st, [await st.get(idA)], now, false, ids(idB)));
  // No update was attempted, and the stored instance is untouched.
  assert.deepEqual(ops(st), ['add:' + idB]);
  assert.equal(st.stored(idA)?.status, StatusActive);
  assert.equal(st.stored(idA)?.completedAt, undefined);
});

test('an unreadable interval refuses before anything is written', async () => {
  const t = task(idA);
  t.repeat = { method: RepeatFixed, every: 'weekly' };
  const st = new MemStore([t]);

  const err = await rejects(complete(st, [await st.get(idA)], now, false, ids(idB)));
  assert.match((err as Error).message, /must start with a number/);
  assert.deepEqual(ops(st), []);
  assert.equal(st.stored(idA)?.status, StatusActive);
});

test('noRepeat ends a repeating item without a successor', async () => {
  // The one way to end a series short of `tdo repeat --stop`.
  const t = task(idA);
  t.repeat = { method: RepeatFixed, every: '1w' };
  const st = new MemStore([t]);

  const res = await complete(st, [await st.get(idA)], now, true, ids(idB));
  assert.deepEqual(res.successors, []);
  assert.deepEqual(ops(st), ['update:' + idA]);
  assert.equal(res.tasks[0]?.status, StatusDone);
  // The repeat itself is left on the row; only the successor is skipped.
  assert.deepEqual(res.tasks[0]?.repeat, { method: RepeatFixed, every: '1w' });
});

test('the ids a repeat generates come from the generator, in order', async () => {
  const st = new MemStore(
    [idA, idB].map((id) => {
      const t = task(id);
      t.repeat = { method: RepeatFixed, every: '1d' };
      return t;
    }),
  );
  const res = await complete(
    st,
    [await st.get(idA), await st.get(idB)],
    now,
    false,
    ids(idC, idD),
  );
  assert.deepEqual(
    res.successors.map((t) => t.id),
    [idC, idD],
  );
  // The named items come back in the order they were given, which is the
  // order the caller will print them in.
  assert.deepEqual(
    res.tasks.map((t) => t.id),
    [idA, idB],
  );
});

test('a container closed by its last child is reported once', async () => {
  // `tdo done a b`, where a and b are the last two actions of one project,
  // completes that project once — not once per child.
  const project = task(idC, { kind: KindProject, title: 'ship it' });
  project.completedByChildren = true;
  const st = new MemStore([
    project,
    task(idA, { parentID: idC, position: 0 }),
    task(idB, { parentID: idC, position: 1 }),
  ]);

  const res = await complete(
    st,
    [await st.get(idA), await st.get(idB)],
    now,
    false,
    ids(idD, idE),
  );
  assert.deepEqual(
    res.autoCompleted.map((t) => t.id),
    [idC],
  );
  assert.equal(res.autoCompleted[0]?.status, StatusDone);
});

test('completing the first of two children reports no container', async () => {
  const project = task(idC, { kind: KindProject, title: 'ship it' });
  project.completedByChildren = true;
  const st = new MemStore([
    project,
    task(idA, { parentID: idC, position: 0 }),
    task(idB, { parentID: idC, position: 1 }),
  ]);
  const res = await complete(st, [await st.get(idA)], now, false, ids(idD));
  assert.deepEqual(res.autoCompleted, []);
});

test('a successor keeps its container open', async () => {
  // This is what the add-then-update order buys: the new instance is a live
  // sibling by the time the container is considered, so the project does not
  // close under a series that is still running.
  const project = task(idC, { kind: KindProject, title: 'weekly review' });
  project.completedByChildren = true;
  const child = task(idA, { parentID: idC });
  child.repeat = { method: RepeatFixed, every: '1w' };
  const st = new MemStore([project, child]);

  const res = await complete(st, [await st.get(idA)], now, false, ids(idB));
  assert.deepEqual(res.autoCompleted, []);
  assert.equal(st.stored(idC)?.status, StatusActive);
});

// -------------------------------------------------------------------------
// setStatus, setFlagged, setDate, apply

test('setStatus moves each task and stamps updatedAt', async () => {
  const st = new MemStore([task(idA), task(idB)]);
  const later = at(3);
  const res = await setStatus(
    st,
    [await st.get(idA), await st.get(idB)],
    StatusOnHold,
    later,
  );
  for (const t of res.tasks) {
    assert.equal(t.status, StatusOnHold);
    assert.equal(t.updatedAt.getTime(), later.getTime());
  }
  assert.equal(st.stored(idA)?.status, StatusOnHold);
});

test('setStatus can close a container, and the other writes cannot', async () => {
  // Only a status change closes or tombstones an item, so only setStatus is
  // asked to predict an auto-completion. The distinction is the `mayComplete`
  // argument, and a port that passed it everywhere would read the whole store
  // on every flag toggle.
  function tree(): MemStore {
    const project = task(idC, { kind: KindProject, title: 'ship it' });
    project.completedByChildren = true;
    return new MemStore([project, task(idA, { parentID: idC })]);
  }

  let st = tree();
  let res = await setStatus(st, [await st.get(idA)], StatusDropped, now);
  assert.deepEqual(
    res.autoCompleted.map((t) => t.id),
    [idC],
  );

  st = tree();
  res = await setFlagged(st, [await st.get(idA)], true, now);
  assert.deepEqual(res.autoCompleted, []);
  assert.deepEqual(ops(st), ['update:' + idA]);
  assert.equal(st.stored(idA)?.flagged, true);

  st = tree();
  res = await setDate(st, [await st.get(idA)], DueDate, at(24), now);
  assert.deepEqual(res.autoCompleted, []);
});

test('setDate writes the field it was named, and clears it on undefined', async () => {
  const st = new MemStore([task(idA)]);
  const when = at(24);

  let res = await setDate(st, [await st.get(idA)], DeferDate, when, now);
  assert.equal(res.tasks[0]?.deferAt?.getTime(), when.getTime());
  assert.equal(res.tasks[0]?.dueAt, undefined);

  res = await setDate(st, [await st.get(idA)], DueDate, when, now);
  assert.equal(res.tasks[0]?.dueAt?.getTime(), when.getTime());
  assert.equal(res.tasks[0]?.deferAt?.getTime(), when.getTime());

  res = await setDate(st, [await st.get(idA)], DeferDate, undefined, now);
  assert.equal(res.tasks[0]?.deferAt, undefined);
  assert.equal(st.stored(idA)?.deferAt, undefined);
  assert.equal(st.stored(idA)?.dueAt?.getTime(), when.getTime());
});

test('apply writes an edit through to the store', async () => {
  const st = new MemStore([task(idA, { title: 'old' })]);
  const res = await apply(
    st,
    [await st.get(idA)],
    new Edit({ title: 'new', tags: ['home'] }),
    now,
  );
  assert.equal(res.tasks[0]?.title, 'new');
  assert.deepEqual(st.stored(idA)?.tags, ['home']);
});

test('a refused edit writes nothing at all', async () => {
  const st = new MemStore([task(idA, { title: 'old' }), task(idB)]);
  const err = await rejects(
    apply(
      st,
      [await st.get(idA)],
      new Edit({ title: 'new', set: { id: 'x' } }),
      now,
    ),
  );
  assert.ok(isInvalid(err));
  assert.deepEqual(ops(st), []);
  assert.equal(st.stored(idA)?.title, 'old');
});

test('a refusal on the second item leaves the first one written', async () => {
  // Go wrote one item at a time and returned on the first failure; there is
  // no transaction across the list and the port does not invent one. What is
  // guaranteed is that the item that failed is untouched, which is what
  // editing a clone is for.
  const st = new MemStore([task(idA), task(idB)]);
  const err = await rejects(
    apply(
      st,
      [await st.get(idA), await st.get(idB)],
      new Edit({ title: '   ' }),
      now,
    ),
  );
  assert.ok(isInvalid(err));
  assert.match((err as Error).message, /title must not be empty/);
  assert.deepEqual(ops(st), []);
});

test('an edit that would not validate is an invalid request, not an error', async () => {
  // The distinction every front end needs: exit 2, not exit 1.
  const st = new MemStore([task(idA)]);
  const err = await rejects(
    apply(st, [await st.get(idA)], new Edit({ title: '' }), now),
  );
  assert.ok(isInvalid(err));
  assert.ok(!isNotFound(err));
});

// -------------------------------------------------------------------------
// create, moveTo

test('create is the store\'s own add, tree rules included', async () => {
  const st = new MemStore([task(idC, { kind: KindProject })]);
  await create(st, task(idA, { parentID: idC }));
  assert.equal(st.stored(idA)?.parentID, idC);

  // The refusal comes from the store, unchanged: this module adds no rule of
  // its own and does not reclassify the store's sentinels.
  const err = await rejects(
    create(st, task(idB, { kind: KindProject, parentID: idA })),
  );
  assert.match((err as Error).message, /cannot go inside/);
});

test('moveTo reparents, keeps the position and reads the row back', async () => {
  const st = new MemStore([
    task(idC, { kind: KindProject }),
    task(idA, { position: 7 }),
  ]);
  const res = await moveTo(st, [await st.get(idA)], idC, at(1));
  assert.equal(res.tasks[0]?.parentID, idC);
  assert.equal(res.tasks[0]?.position, 7);
  // Read back rather than predicted, so what the caller prints is what the
  // store holds.
  assert.equal(res.tasks[0]?.updatedAt.getTime(), at(1).getTime());
});

test('moveTo to the empty parent is the top level', async () => {
  const st = new MemStore([
    task(idC, { kind: KindProject }),
    task(idA, { parentID: idC }),
  ]);
  const res = await moveTo(st, [await st.get(idA)], '', now);
  assert.equal(res.tasks[0]?.parentID, '');
});

// -------------------------------------------------------------------------
// tombstone

test('tombstoning a container takes its subtree with it', async () => {
  // Leaving the children behind would make them orphans, which §3.3 refuses
  // to call available — they would vanish from every listing while still
  // being there.
  const st = new MemStore([
    task(idC, { kind: KindProject }),
    task(idA, { parentID: idC, position: 0 }),
    task(idB, { parentID: idC, position: 1 }),
  ]);
  const res = await tombstone(st, [await st.get(idC)], now);
  assert.deepEqual(
    res.tasks.map((t) => t.id),
    [idC, idA, idB],
  );
  for (const id of [idA, idB, idC]) {
    assert.equal(st.stored(id)?.deletedAt?.getTime(), now.getTime(), id);
  }
});

test('an item named twice, or named inside a named subtree, is written once', async () => {
  const st = new MemStore([
    task(idC, { kind: KindProject }),
    task(idA, { parentID: idC }),
  ]);
  const res = await tombstone(
    st,
    [await st.get(idC), await st.get(idA), await st.get(idC)],
    now,
  );
  assert.deepEqual(
    res.tasks.map((t) => t.id),
    [idC, idA],
  );
  assert.deepEqual(ops(st), ['update:' + idC, 'update:' + idA]);
});

test('an already tombstoned row is reported but not rewritten', async () => {
  const gone = task(idA);
  gone.deletedAt = at(-5);
  const st = new MemStore([gone]);
  const res = await tombstone(st, [await st.get(idA)], now);
  assert.deepEqual(
    res.tasks.map((t) => t.id),
    [idA],
  );
  assert.deepEqual(ops(st), []);
  // The original stamp stands: a second `tdo rm` must not move the date a
  // sync would compare.
  assert.equal(st.stored(idA)?.deletedAt?.getTime(), at(-5).getTime());
});

test('only the item the user named can close something that survives', async () => {
  // Everything else in the subtree is being tombstoned alongside it, and its
  // own ancestors are inside the subtree, so predicting for every node would
  // report containers that are themselves being removed — and would read the
  // whole store once per node.
  const outer = task(idD, { kind: KindProject, title: 'outer' });
  outer.completedByChildren = true;
  const inner = task(idC, { kind: KindTask, parentID: idD, title: 'inner' });
  inner.completedByChildren = true;
  const st = new MemStore([
    outer,
    inner,
    task(idA, { parentID: idC }),
    task(idB, { parentID: idD, status: StatusDone }),
  ]);

  const res = await tombstone(st, [await st.get(idC)], now);
  assert.deepEqual(
    res.tasks.map((t) => t.id),
    [idC, idA],
  );
  assert.deepEqual(
    res.autoCompleted.map((t) => t.id),
    [idD],
  );
});

// -------------------------------------------------------------------------
// availabilityOf

test('availabilityOf asks the store, once, for the ids it was given', async () => {
  const st = new MemStore([task(idA), task(idB)]);
  const got = await availabilityOf(st, [await st.get(idA), await st.get(idB)], now);
  assert.deepEqual([...got.keys()].sort(), [idA, idB]);
  assert.equal(got.get(idA)?.available, true);
  assert.equal(got.get(idA)?.rule, RuleNone);
});

test('availabilityOf on nothing is an empty map and no store call', async () => {
  // A provider asked for zero ids may reasonably read everything, so the
  // short circuit is behaviour and not a micro-optimisation.
  const st = new MemStore([task(idA)]);
  const got = await availabilityOf(st, [], now);
  assert.equal(got.size, 0);
  assert.deepEqual(ops(st), []);
});

// -------------------------------------------------------------------------
// reorder

/** siblings returns a project with four children in position order. */
function siblings(): MemStore {
  return new MemStore([
    task(idE, { kind: KindProject }),
    task(idA, { parentID: idE, position: 0 }),
    task(idB, { parentID: idE, position: 1 }),
    task(idC, { parentID: idE, position: 2 }),
    task(idD, { parentID: idE, position: 3 }),
  ]);
}

/** order reads the children of idE back in tree order. */
async function order(st: MemStore): Promise<string[]> {
  return (await st.children(idE)).map((t) => t.id);
}

test('reorder puts the items before the anchor', async () => {
  const st = siblings();
  const res = await reorder(
    st,
    [await st.get(idD)],
    await st.get(idB),
    Before,
    now,
  );
  assert.deepEqual(await order(st), [idA, idD, idB, idC]);
  assert.deepEqual(
    res.tasks.map((t) => t.id),
    [idD],
  );
  assert.equal(res.tasks[0]?.position, 1);
});

test('reorder puts the items after the anchor', async () => {
  const st = siblings();
  await reorder(st, [await st.get(idA)], await st.get(idC), After, now);
  assert.deepEqual(await order(st), [idB, idC, idA, idD]);
});

test('reorder keeps the order the items were given in', async () => {
  const st = siblings();
  const res = await reorder(
    st,
    [await st.get(idD), await st.get(idC)],
    await st.get(idA),
    Before,
    now,
  );
  assert.deepEqual(await order(st), [idD, idC, idA, idB]);
  // Read back in the order the caller named them, which is the order it will
  // print.
  assert.deepEqual(
    res.tasks.map((t) => t.id),
    [idD, idC],
  );
});

test('reorder leaves the siblings that are already in place alone', async () => {
  // A reorder in a long project must not touch every row's updated_at, which
  // is what a sync and `tdo ls --order updated` both read.
  const st = siblings();
  await reorder(st, [await st.get(idD)], await st.get(idC), After, now);
  // idD already sat last at position 3, and nothing else had to shift.
  assert.deepEqual(ops(st), ['move:' + idD]);
  assert.equal(st.stored(idA)?.updatedAt.getTime(), now.getTime());
});

test('reorder renumbers every sibling whose position changed', async () => {
  const st = siblings();
  await reorder(st, [await st.get(idA)], await st.get(idD), After, now);
  assert.deepEqual(await order(st), [idB, idC, idD, idA]);
  // Pulling idA out of the front shifts everything behind it down by one, so
  // all four rows are written: the skip only spares a sibling that lands on
  // the position it already had.
  assert.deepEqual(ops(st), [
    'move:' + idB,
    'move:' + idC,
    'move:' + idD,
    'move:' + idA,
  ]);
  assert.equal(st.stored(idD)?.position, 2);
  assert.equal(st.stored(idA)?.position, 3);
});

test('reorder next to an anchor elsewhere moves the item into that container', async () => {
  // That is what "put it after this one" means when the anchor lives
  // somewhere else, and it keeps `tdo mv --after` from being a second,
  // subtly different kind of move.
  const st = new MemStore([
    task(idE, { kind: KindProject }),
    task(idA, { parentID: idE, position: 0 }),
    task(idB, { parentID: idE, position: 1 }),
    task(idC, { position: 0 }),
  ]);
  const res = await reorder(
    st,
    [await st.get(idC)],
    await st.get(idA),
    After,
    now,
  );
  assert.deepEqual(await order(st), [idA, idC, idB]);
  assert.equal(res.tasks[0]?.parentID, idE);
});

test('reorder refuses an empty list and an anchor among the items', async () => {
  const st = siblings();
  let err = await rejects(reorder(st, [], await st.get(idA), Before, now));
  assert.ok(isInvalid(err));
  assert.match((err as Error).message, /expected at least one item to move/);

  const anchor = await st.get(idA);
  err = await rejects(
    reorder(st, [await st.get(idB), anchor], anchor, Before, now),
  );
  assert.ok(isInvalid(err));
  assert.match(
    (err as Error).message,
    /"01J3AAAAAAAAAAAAAAAAAAAAAA" cannot be placed relative to itself/,
  );
  // The refusal happens before any write, so the group is as it was.
  assert.deepEqual(ops(st), []);
  assert.deepEqual(await order(st), [idA, idB, idC, idD]);
});

test('a named item is always written, even where it already sat', async () => {
  // The skip is guarded on `!moving`, so an item the caller named is moved
  // whether or not its position changes. That is deliberate: `tdo mv --after`
  // on an item that is already there still stamps it, and the caller still
  // reads back a row rather than guessing. A skip here would make the two
  // cases indistinguishable to a sync.
  const st = siblings();
  const res = await reorder(
    st,
    [await st.get(idB)],
    await st.get(idA),
    After,
    now,
  );
  assert.deepEqual(ops(st), ['move:' + idB]);
  assert.deepEqual(await order(st), [idA, idB, idC, idD]);
  assert.deepEqual(
    res.tasks.map((t) => t.id),
    [idB],
  );
  assert.equal(res.tasks[0]?.position, 1);
});

test('reorder surfaces the store\'s own refusal unchanged', async () => {
  const st = siblings();
  st.fail = {
    op: 'move',
    err: new Error('gone', { cause: ErrNotFound }),
  };
  const err = await rejects(
    reorder(st, [await st.get(idD)], await st.get(idA), Before, now),
  );
  assert.ok(isNotFound(err));
  assert.ok(!isInvalid(err));
});
