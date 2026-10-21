// The availability truth table and the tree rules are exercised end to end by
// the conformance suite, and the cases the tree answers on its own are in
// store.test.ts, where Go's store_test.go put them.
//
// What is here is the one thing the Go tests had no reason to check, because
// Go could not get it wrong: Tree.sortKey offsets a position past zero by
// 2^62, and in a language whose only number is a double that addition throws
// the position away unless it is done in BigInt. If it regresses, every
// sibling gets the same key and a listing silently falls back to id order —
// which looks like a plausible listing, so nothing else would notice.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { KindProject, KindTask, newTask } from '../task.ts';
import { sortTasks } from './store.ts';
import { Tree } from './availability.ts';

const now = new Date(Date.UTC(2026, 9, 20, 4, 11, 0));

test('sortKey keeps a position that a double would round away', () => {
  const parent = newTask('01J3PARENT00000000000000PP', KindProject, 'p', now);
  const first = newTask('01J3CHILD000000000000000AA', KindTask, 'a', now);
  const second = newTask('01J3CHILD000000000000000BB', KindTask, 'b', now);
  // Positions one apart: 2^62 and 2^62 + 1 are the same double, so number
  // arithmetic would render both keys identically.
  first.parentID = parent.id;
  first.position = 0;
  second.parentID = parent.id;
  second.position = 1;
  const tr = new Tree([parent, first, second]);

  const a = tr.sortKey(first);
  const b = tr.sortKey(second);
  assert.notDeepEqual(
    a,
    b,
    'two siblings one position apart must not share a sort key',
  );
  assert.ok(
    (a[1] as string) < (b[1] as string),
    `position 0 must sort before position 1, got ${JSON.stringify(a)} and ${JSON.stringify(b)}`,
  );
});

test('a negative position still sorts before everything', () => {
  const before = newTask('01J3CHILD000000000000000ZZ', KindTask, 'z', now);
  before.position = -5;
  const after = newTask('01J3CHILD000000000000000AA', KindTask, 'a', now);
  after.position = 0;
  const tr = new Tree([before, after]);

  assert.ok(
    (tr.sortKey(before)[0] as string) < (tr.sortKey(after)[0] as string),
    'the offset exists so that a negative position compares as text in numeric order',
  );

  // And the order a listing actually gets, which is what the key is for.
  const tasks = [after, before];
  sortTasks(tasks, '', (t) => tr.sortKey(t));
  assert.deepEqual(
    tasks.map((t) => t.id),
    [before.id, after.id],
  );
});

test('a container sorts before the items inside it', () => {
  const parent = newTask('01J3PARENT00000000000000PP', KindProject, 'p', now);
  const child = newTask('01J3CHILD000000000000000AA', KindTask, 'a', now);
  child.parentID = parent.id;
  const tr = new Tree([parent, child]);

  const tasks = [child, parent];
  sortTasks(tasks, '', (t) => tr.sortKey(t));
  assert.deepEqual(
    tasks.map((t) => t.id),
    [parent.id, child.id],
    'tree order prints a container, then what is in it',
  );
});
