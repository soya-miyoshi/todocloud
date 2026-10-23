// Events: the rows a task can wait for, and what the store does about it.
//
// The rule that an event holds its items back is the Tree's and is tested in
// core. What is tested here is what only a provider can get wrong: that the
// rows and the links round-trip, that every sentinel is where the contract
// says, that a link is checked at both ends and removed with either end, that
// the one availability call and a filtered listing both see events, and that
// ids are accepted in any case.

import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';

import {
  AvailabilityAvailable,
  AvailabilityBlocked,
  ErrAmbiguous,
  ErrBadParent,
  ErrExists,
  ErrNotFound,
  EventCancelled,
  EventOccurred,
  EventPending,
  Filter,
  KindFolder,
  KindProject,
  KindTask,
  New as newID,
  newEvent,
  RuleAncestorEvent,
  RuleEvent,
} from '@todocloud/core';

import {
  failed,
  type Fixture,
  requireAvailable,
  requireIs,
  requireNoError,
  titles,
  under,
} from './storetest.ts';

const day = 24 * 60 * 60 * 1000;

export async function testEvents(t: TestContext, f: Fixture): Promise<void> {
  // ---- rows round-trip -----------------------------------------------------
  const vendor = newEvent(newID(), 'reply from the vendor', f.now);
  vendor.note = 'chase on Friday';
  vendor.expectedAt = new Date(f.now.getTime() + 3 * day);
  requireNoError(t, 'AddEvent must accept a well-formed event', await failed(() => f.s.addEvent(vendor)));

  const got = await f.s.getEvent(vendor.id);
  assert.equal(got.title, vendor.title, 'GetEvent must return the title it stored');
  assert.equal(got.note, 'chase on Friday', 'GetEvent must return the note it stored');
  assert.equal(got.status, EventPending, 'a new event is pending');
  assert.deepEqual(got.expectedAt, vendor.expectedAt, 'expected_at must round-trip');
  assert.equal(got.occurredAt, undefined, 'a pending event has no occurred_at');
  assert.deepEqual(got.createdAt, vendor.createdAt, 'created_at must round-trip');

  requireIs(
    t,
    'AddEvent must report an id that is taken as ErrExists',
    await failed(() => f.s.addEvent(vendor)),
    ErrExists,
  );
  requireIs(
    t,
    'GetEvent must report an unknown id as ErrNotFound',
    await failed(() => f.s.getEvent(newID())),
    ErrNotFound,
  );
  const blank = newEvent(newID(), '   ', f.now);
  assert.ok(
    (await failed(() => f.s.addEvent(blank))) !== undefined,
    'AddEvent must refuse an event with a blank title',
  );
  const lying = newEvent(newID(), 'lying', f.now);
  lying.status = EventOccurred;
  assert.ok(
    (await failed(() => f.s.addEvent(lying))) !== undefined,
    'AddEvent must refuse an occurred event that does not say when',
  );

  // ---- listing -------------------------------------------------------------
  const call = newEvent(newID(), 'the call', new Date(f.now.getTime() + 1000));
  await f.s.addEvent(call);
  const all = await f.s.events();
  assert.deepEqual(
    all.map((e) => e.title),
    ['reply from the vendor', 'the call'],
    'Events must list every event, oldest first',
  );

  // ---- prefix lookup and ids in any case -----------------------------------
  const byPrefix = await f.s.findEventByPrefix(vendor.id.slice(0, 24).toLowerCase());
  assert.equal(byPrefix.id, vendor.id, 'FindEventByPrefix must accept a lower-case prefix');
  requireIs(
    t,
    'FindEventByPrefix must report no match as ErrNotFound',
    await failed(() => f.s.findEventByPrefix('ZZZZZZZZZZZZ')),
    ErrNotFound,
  );
  // Two events from one process share a long prefix; the empty prefix matches both.
  requireIs(
    t,
    'FindEventByPrefix must report two matches as ErrAmbiguous',
    await failed(() => f.s.findEventByPrefix('')),
    ErrAmbiguous,
  );
  const lower = await f.s.getEvent(vendor.id.toLowerCase());
  assert.equal(lower.id, vendor.id, 'GetEvent must accept an id in any case');

  // ---- update --------------------------------------------------------------
  const edited = got.clone();
  edited.title = 'reply from the vendor (again)';
  edited.note = '';
  edited.setStatus(EventOccurred, new Date(f.now.getTime() + 2 * day));
  requireNoError(t, 'UpdateEvent must accept a changed event', await failed(() => f.s.updateEvent(edited)));
  const after = await f.s.getEvent(vendor.id);
  assert.equal(after.title, 'reply from the vendor (again)');
  assert.equal(after.note, '', 'an emptied note must come back empty');
  assert.equal(after.status, EventOccurred);
  assert.deepEqual(after.occurredAt, edited.occurredAt, 'occurred_at must round-trip');
  assert.deepEqual(after.createdAt, vendor.createdAt, 'UpdateEvent must not change created_at');
  requireIs(
    t,
    'UpdateEvent must report an unknown id as ErrNotFound',
    await failed(() => f.s.updateEvent(newEvent(newID(), 'ghost', f.now))),
    ErrNotFound,
  );
  after.setStatus(EventPending, f.now);
  await f.s.updateEvent(after);
  assert.equal((await f.s.getEvent(vendor.id)).occurredAt, undefined, 'reopening must clear occurred_at');

  // ---- links ---------------------------------------------------------------
  const project = await f.add(KindProject, 'launch');
  const inside = await f.add(KindTask, 'announce', under(project));
  const loose = await f.add(KindTask, 'send the order');

  requireNoError(
    t,
    'SetWaits must accept a task and an event that both exist',
    await failed(() => f.s.setWaits(loose.id, [vendor.id, call.id])),
  );
  const links = await f.s.waits();
  assert.deepEqual(
    links.map((l) => `${l.taskID}>${l.eventID}`).sort(),
    [`${loose.id}>${vendor.id}`, `${loose.id}>${call.id}`].sort(),
    'Waits must list every link',
  );

  requireIs(
    t,
    'SetWaits must report an unknown task as ErrNotFound',
    await failed(() => f.s.setWaits(newID(), [vendor.id])),
    ErrNotFound,
  );
  requireIs(
    t,
    'SetWaits must report an unknown event as ErrNotFound',
    await failed(() => f.s.setWaits(loose.id, [vendor.id, newID()])),
    ErrNotFound,
  );
  assert.equal(
    (await f.s.waits()).length,
    2,
    'a SetWaits that was refused must leave the links exactly as they were',
  );

  // replacing, not adding
  await f.s.setWaits(loose.id, [call.id, call.id.toLowerCase()]);
  assert.deepEqual(
    (await f.s.waits()).map((l) => l.eventID),
    [call.id],
    'SetWaits must replace the set, and must not store one event twice',
  );
  await f.s.setWaits(loose.id, [vendor.id, call.id]);

  // ---- availability, from the store's own call ------------------------------
  const a = await f.answer(loose.id);
  assert.equal(a.available, false, 'a task waiting for a pending event is blocked');
  assert.equal(a.rule, RuleEvent);
  assert.equal(a.blockedBy < '' || a.blockedBy.length > 0, true);
  assert.deepEqual(
    [...a.waitsOn].sort(),
    [vendor.id, call.id].sort(),
    'the answer must say what the task waits for',
  );

  // The first pending event in id order is the one named.
  const firstID = [vendor.id, call.id].sort()[0] as string;
  assert.equal(a.blockedBy, firstID, 'the block must name the first pending event, in id order');

  // one occurs, the other does not
  const first = await f.s.getEvent(firstID);
  first.setStatus(EventOccurred, f.now);
  await f.s.updateEvent(first);
  const still = await f.answer(loose.id);
  assert.equal(still.available, false);
  assert.notEqual(still.blockedBy, firstID, 'an occurred event must stop being named');

  const second = await f.s.getEvent(still.blockedBy);
  second.setStatus(EventCancelled, f.now);
  await f.s.updateEvent(second);
  await requireAvailable(
    t,
    f,
    'a cancelled event does not release the task waiting for it',
    loose.id,
    false,
  );

  second.setStatus(EventOccurred, f.now);
  await f.s.updateEvent(second);
  await requireAvailable(t, f, 'once every event has occurred the task is available', loose.id, true);
  assert.equal((await f.answer(loose.id)).waitsOn.length, 2, 'the dependency is still reported');

  // a waiting project holds back what is inside it
  const gate = newEvent(newID(), 'budget signed off', f.now);
  await f.s.addEvent(gate);
  await f.s.setWaits(project.id, [gate.id]);
  const inner = await f.answer(inside.id);
  assert.equal(inner.available, false, 'a task inside a waiting project is blocked');
  assert.equal(inner.rule, RuleAncestorEvent);
  assert.equal(inner.blockedBy, gate.id, 'the block names the event, not the project');

  // ---- a filtered listing sees events too ------------------------------------
  const availableNow = await f.list(new Filter({ availability: AvailabilityAvailable }));
  assert.ok(
    !titles(availableNow).includes('announce'),
    'an available listing must leave out a task an event is holding back',
  );
  assert.ok(titles(availableNow).includes('send the order'), 'and keep one that is free');
  const blockedNow = await f.list(new Filter({ availability: AvailabilityBlocked }));
  assert.ok(titles(blockedNow).includes('announce'), 'a blocked listing must include it');

  gate.setStatus(EventOccurred, f.now);
  await f.s.updateEvent(gate);
  assert.ok(
    titles(await f.list(new Filter({ availability: AvailabilityAvailable }))).includes('announce'),
    'the event occurring must release the task in a listing, with nothing else written',
  );

  // ---- removal -----------------------------------------------------------------
  await f.s.setWaits(inside.id, [gate.id]);
  gate.setStatus(EventPending, f.now);
  await f.s.updateEvent(gate);
  assert.equal(await f.s.removeEvent(gate.id), 2, 'RemoveEvent must report how many links it dropped');
  requireIs(
    t,
    'a removed event is gone',
    await failed(() => f.s.getEvent(gate.id)),
    ErrNotFound,
  );
  requireIs(
    t,
    'RemoveEvent must report an unknown id as ErrNotFound',
    await failed(() => f.s.removeEvent(gate.id)),
    ErrNotFound,
  );
  assert.ok(
    !(await f.s.waits()).some((l) => l.eventID === gate.id),
    'removing an event must remove the links to it',
  );
  await requireAvailable(t, f, 'what waited for a removed event is free', inside.id, true);

  // purging a task removes its links, and the event stays
  await f.s.setWaits(loose.id, [vendor.id]);
  await f.s.purge(loose.id);
  assert.ok(
    !(await f.s.waits()).some((l) => l.taskID === loose.id),
    'purging a task must remove its links',
  );
  assert.equal((await f.s.getEvent(vendor.id)).id, vendor.id, 'the event outlives the task');

  // purging a subtree does the same
  const child = await f.add(KindTask, 'child of a waiting project', under(project));
  await f.s.setWaits(child.id, [vendor.id]);
  await f.s.purgeSubtree(project.id);
  assert.ok(
    (await f.s.waits()).length === 0,
    'purging a subtree must remove the links of everything in it',
  );
}

/**
 * testTagStatusInListing is here because it was found while wiring events
 * into listings: a listing that filters on availability builds its tree from
 * the rows, and a provider that forgot to hand that tree the tag statuses
 * would show a task whose tag is on hold. The availability call got it right;
 * the listing did not.
 */
export async function testTagStatusInListing(t: TestContext, f: Fixture): Promise<void> {
  const held = await f.add(KindTask, 'errand', (x) => x.setTags(['car']));
  const free = await f.add(KindTask, 'email', (x) => x.setTags(['anywhere']));
  await f.s.setTagStatus('car', 'on_hold', f.now);
  await requireAvailable(t, f, 'a tag on hold holds its task back', held.id, false);
  const listed = titles(await f.list(new Filter({ availability: AvailabilityAvailable })));
  assert.ok(
    !listed.includes(held.title),
    `an available listing must leave out a task whose tag is on hold, got ${JSON.stringify(listed)}`,
  );
  assert.ok(listed.includes(free.title), 'and keep the one that is free');
}

/**
 * testEventProjects: an event may belong to a project, so the project's own
 * view can list it. The store checks that the project exists and is one, keeps
 * the event when the project is purged, and lets the owner be changed.
 */
export async function testEventProjects(t: TestContext, f: Fixture): Promise<void> {
  const project = await f.add(KindProject, 'launch');
  const other = await f.add(KindProject, 'migration');
  const folder = await f.add(KindFolder, 'work');
  const task = await f.add(KindTask, 'a task');

  const e = newEvent(newID(), 'sign-off', f.now);
  e.projectID = project.id;
  requireNoError(t, 'AddEvent must accept an event that belongs to a project', await failed(() => f.s.addEvent(e)));
  assert.equal((await f.s.getEvent(e.id)).projectID, project.id, 'project_id must round-trip');
  assert.equal(
    (await f.s.events()).find((x) => x.id === e.id)?.projectID,
    project.id,
    'Events must carry the project too',
  );

  const free = newEvent(newID(), 'a free event', f.now);
  await f.s.addEvent(free);
  assert.equal((await f.s.getEvent(free.id)).projectID, '', 'an event may belong to no project');

  // the id is accepted in any case
  const lower = newEvent(newID(), 'lower case', f.now);
  lower.projectID = project.id.toLowerCase();
  await f.s.addEvent(lower);
  assert.equal((await f.s.getEvent(lower.id)).projectID, project.id, 'the project id is stored canonically');

  // both ends are checked
  const ghost = newEvent(newID(), 'ghost project', f.now);
  ghost.projectID = newID();
  requireIs(
    t,
    'AddEvent must report a project that does not exist as ErrNotFound',
    await failed(() => f.s.addEvent(ghost)),
    ErrNotFound,
  );
  for (const [what, parent] of [
    ['a task', task],
    ['a folder', folder],
  ] as const) {
    const bad = newEvent(newID(), `under ${what}`, f.now);
    bad.projectID = parent.id;
    requireIs(
      t,
      `AddEvent must refuse ${what} as the owner of an event, as ErrBadParent`,
      await failed(() => f.s.addEvent(bad)),
      ErrBadParent,
    );
  }
  assert.equal(
    (await f.s.events()).filter((x) => x.title === 'ghost project' || x.title.startsWith('under ')).length,
    0,
    'a refused event must not be stored',
  );

  // moving it between projects, and out of one
  const moved = (await f.s.getEvent(e.id)).clone();
  moved.projectID = other.id;
  await f.s.updateEvent(moved);
  assert.equal((await f.s.getEvent(e.id)).projectID, other.id, 'UpdateEvent must move an event to another project');
  const cleared = (await f.s.getEvent(e.id)).clone();
  cleared.projectID = '';
  await f.s.updateEvent(cleared);
  assert.equal((await f.s.getEvent(e.id)).projectID, '', 'an empty project takes it out of the project');
  const bad = (await f.s.getEvent(e.id)).clone();
  bad.projectID = task.id;
  requireIs(
    t,
    'UpdateEvent must refuse a task as the owner too',
    await failed(() => f.s.updateEvent(bad)),
    ErrBadParent,
  );

  // purging the project keeps the event, which still holds what waits for it
  const kept = (await f.s.getEvent(e.id)).clone();
  kept.projectID = other.id;
  await f.s.updateEvent(kept);
  const waiter = await f.add(KindTask, 'waits elsewhere');
  await f.s.setWaits(waiter.id, [e.id]);
  await f.s.purgeSubtree(other.id);
  const survivor = await f.s.getEvent(e.id);
  assert.equal(survivor.projectID, '', 'purging a project must leave its events, owned by no one');
  await requireAvailable(
    t,
    f,
    'and what waits for such an event is still held back',
    waiter.id,
    false,
  );

  // removing the event leaves the project alone
  await f.s.removeEvent(e.id);
  assert.equal((await f.get(project.id)).id, project.id);
}
