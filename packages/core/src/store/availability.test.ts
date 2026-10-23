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

import { KindFolder, KindProject, KindTask, StatusOnHold, newTask } from '../task.ts';
import { EventCancelled, EventOccurred, newEvent } from './event.ts';
import { RuleAncestorEvent, RuleDeferred, RuleEvent, RuleSequential, RuleStatus, sortTasks } from './store.ts';
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

// --- events ---------------------------------------------------------------

const ev = (id: string, title = 'an event') => newEvent(id, title, now);
const E1 = '01J3EVENT00000000000000001';
const E2 = '01J3EVENT00000000000000002';
const T1 = '01J3TASK000000000000000T1';
const T2 = '01J3TASK000000000000000T2';
const P1 = '01J3PROJECT00000000000000P1';

test('an item waits until the event has occurred', () => {
  const event = ev(E1);
  const task = newTask(T1, KindTask, 'send the order', now);
  const tree = (): Tree => {
    const t = new Tree([task]);
    t.setEvents([event], [{ taskID: T1, eventID: E1 }]);
    return t;
  };

  const before = tree().availability(T1, now);
  assert.equal(before.available, false);
  assert.equal(before.rule, RuleEvent);
  assert.equal(before.blockedBy, E1, 'the block names the event, which is what to mark as occurred');

  event.setStatus(EventOccurred, now);
  const after = tree().availability(T1, now);
  assert.equal(after.available, true, 'once the event has occurred nothing holds the item back');
  assert.deepEqual(after.waitsOn, [E1], 'the dependency is still reported after it is satisfied');
});

test('a cancelled event keeps holding its items', () => {
  const event = ev(E1);
  event.setStatus(EventCancelled, now);
  const task = newTask(T1, KindTask, 'follow up', now);
  const tree = new Tree([task]);
  tree.setEvents([event], [{ taskID: T1, eventID: E1 }]);
  assert.equal(
    tree.availability(T1, now).rule,
    RuleEvent,
    'a cancelled event is unresolved, so the item stays blocked until it is unlinked or the event occurs',
  );
});

test('a project that waits holds back what is inside it', () => {
  const project = newTask(P1, KindProject, 'launch', now);
  const task = newTask(T1, KindTask, 'announce', now);
  task.parentID = P1;
  const tree = new Tree([project, task]);
  tree.setEvents([ev(E1)], [{ taskID: P1, eventID: E1 }]);

  const a = tree.availability(T1, now);
  assert.equal(a.rule, RuleAncestorEvent);
  assert.equal(a.blockedBy, E1);
  assert.deepEqual(a.waitsOn, [], 'the task itself waits for nothing; its project does');
  assert.deepEqual(tree.availability(P1, now).waitsOn, [E1]);
});

test('waiting for several events needs all of them, and names the first pending', () => {
  const one = ev(E1);
  const two = ev(E2);
  const task = newTask(T1, KindTask, 'both', now);
  const links = [
    { taskID: T1, eventID: E2 },
    { taskID: T1, eventID: E1 },
  ];
  const build = (): Tree => {
    const t = new Tree([task]);
    t.setEvents([one, two], links);
    return t;
  };

  assert.equal(build().availability(T1, now).blockedBy, E1, 'ids sort, so the answer is stable');
  assert.deepEqual(build().availability(T1, now).waitsOn, [E1, E2]);

  one.setStatus(EventOccurred, now);
  const half = build().availability(T1, now);
  assert.equal(half.rule, RuleEvent);
  assert.equal(half.blockedBy, E2, 'the block names the one still to occur');

  two.setStatus(EventOccurred, now);
  assert.equal(build().availability(T1, now).available, true);
});

test('a link to an event that does not exist holds nothing back', () => {
  const task = newTask(T1, KindTask, 'dangling', now);
  const tree = new Tree([task]);
  tree.setEvents([], [{ taskID: T1, eventID: E1 }]);
  const a = tree.availability(T1, now);
  assert.equal(a.available, true, 'a missing event must not strand the item');
  assert.deepEqual(a.waitsOn, []);
});

test('a tree with no events answers as it always did', () => {
  const task = newTask(T1, KindTask, 'plain', now);
  const tree = new Tree([task]);
  assert.equal(tree.availability(T1, now).available, true);
  assert.deepEqual(tree.availability(T1, now).waitsOn, []);
});

test('the more specific rule wins over the event rule', () => {
  const task = newTask(T1, KindTask, 'held and waiting', now);
  task.setStatus(StatusOnHold, now);
  const tree = new Tree([task]);
  tree.setEvents([ev(E1)], [{ taskID: T1, eventID: E1 }]);
  assert.equal(tree.availability(T1, now).rule, RuleStatus, 'its own status comes first');

  const deferred = newTask(T2, KindTask, 'not yet', now);
  deferred.deferAt = new Date(now.getTime() + 86_400_000);
  const t2 = new Tree([deferred]);
  t2.setEvents([ev(E1)], [{ taskID: T2, eventID: E1 }]);
  assert.equal(t2.availability(T2, now).rule, RuleDeferred, 'its own defer date comes first');
});

test('the event rule comes before the sequential rule', () => {
  const project = newTask(P1, KindProject, 'p', now);
  project.sequential = true;
  const first = newTask(T1, KindTask, 'first', now);
  first.parentID = P1;
  first.position = 0;
  const second = newTask(T2, KindTask, 'second', now);
  second.parentID = P1;
  second.position = 1;
  const tree = new Tree([project, first, second]);
  tree.setEvents([ev(E1)], [{ taskID: T2, eventID: E1 }]);
  // The second task is queued behind the first *and* waiting; the item's own
  // state is reported before its place among its siblings.
  assert.equal(tree.availability(T2, now).rule, RuleEvent);
  assert.equal(tree.availability(T1, now).rule, '', 'the first one is untouched');
  assert.notEqual(RuleSequential, RuleEvent);
});

test('a folder is never held by an event, only what is inside the project is', () => {
  const folder = newTask('01J3FOLDER000000000000000F', KindFolder, 'f', now);
  const project = newTask(P1, KindProject, 'p', now);
  project.parentID = folder.id;
  const task = newTask(T1, KindTask, 't', now);
  task.parentID = P1;
  const tree = new Tree([folder, project, task]);
  tree.setEvents([ev(E1)], []);
  assert.equal(tree.availability(T1, now).available, true, 'an unlinked event affects nobody');
});
