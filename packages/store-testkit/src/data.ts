// What a store holds rather than how it is shaped: tombstones, tags and the
// status a tag carries, perspectives, repeats, review, the sentinels, id
// normalization, the user-defined fields and the filters.

import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';

import {
  cloneRepeat,
  Condition,
  ErrAmbiguous,
  ErrExists,
  ErrNotEmpty,
  ErrNotFound,
  Fields as FieldsOf,
  type Fields,
  Filter,
  KindFolder,
  KindProject,
  KindTask,
  New as newID,
  newTask,
  Normalize as normalizeID,
  OrderDefer,
  OrderDue,
  type Perspective,
  RepeatFromCompletion,
  repeatEqual,
  RuleAncestorTagStatus,
  RuleTagStatus,
  Scope,
  StatusActive,
  StatusDone,
  StatusDropped,
  StatusOnHold,
  type Tag,
  tagKey,
  type Task,
  AvailabilityAvailable,
  AvailabilityDeferred,
} from '@todocloud/core';

import {
  day,
  Failures,
  failed,
  type Fixture,
  hour,
  list,
  requireAvailable,
  requireIs,
  requireNoError,
  requireSet,
  requireTitles,
  reason,
  timeAt,
  titles,
  under,
  wrapsSentinel,
} from './storetest.ts';

export async function testTombstones(
  t: TestContext,
  f: Fixture,
): Promise<void> {
  await f.add(KindTask, 'kept');
  const removed = await f.add(KindTask, 'removed');

  const stored = await f.get(removed.id);
  stored.deletedAt = new Date(f.now.getTime());
  await f.update(stored);

  requireSet(
    t,
    'removal is a tombstone, and a tombstoned task is out of an ordinary listing (PLAN.md §3.7)',
    await f.list(new Filter()),
    'kept',
  );
  requireSet(
    t,
    '`--deleted` must show the tombstoned tasks and nothing else',
    await f.list(new Filter({ onlyDeleted: true })),
    'removed',
  );
  requireSet(
    t,
    'a listing that includes deleted tasks must hold both',
    await f.list(new Filter({ includeDeleted: true })),
    'kept',
    'removed',
  );

  const got = await f.get(removed.id);
  if (!got.deleted()) {
    assert.fail(
      'Get must return a tombstoned task, tombstone and all: a tombstone is a state, not an absence',
    );
  }

  requireNoError(
    t,
    'a tombstoned leaf may be purged',
    await failed(() => f.s.purge(removed.id)),
  );
  requireIs(
    t,
    'a purged task is gone for good, so Get must report it as not found',
    await failed(() => f.s.get(removed.id)),
    ErrNotFound,
  );
}

export async function testTags(t: TestContext, f: Fixture): Promise<void> {
  const home = await f.add(KindTask, 'mow the lawn', (x) => {
    x.setTags(['Home', 'home', ' errand ', '']);
  });
  const both = await f.add(KindTask, 'call the plumber', (x) => {
    x.setTags(['home', 'phone']);
  });
  await f.add(KindTask, 'think');

  const stored = await f.get(home.id);
  if (stored.tags.join('\u0000') !== ['errand', 'Home'].join('\u0000')) {
    assert.fail(
      `tags are a set compared case-insensitively, kept in the spelling first typed and sorted by name\n  stored tags are ${list(stored.tags)}, expected [errand Home]`,
    );
  }

  requireSet(
    t,
    'a tag filter is case-insensitive, because a tag is typed',
    await f.list(new Filter({ tags: ['HOME'] })),
    'mow the lawn',
    'call the plumber',
  );
  requireSet(
    t,
    'several tags mean all of them unless the filter says any',
    await f.list(new Filter({ tags: ['home', 'phone'] })),
    'call the plumber',
  );
  requireSet(
    t,
    '`tags_any` means any one of them',
    await f.list(new Filter({ tags: ['errand', 'phone'], tagsAny: true })),
    'mow the lawn',
    'call the plumber',
  );

  let counts: Tag[] = [];
  try {
    counts = await f.s.tags();
  } catch (err) {
    requireNoError(t, 'Tags must list the tags in use', err);
  }
  const want = new Map([
    ['errand', 1],
    ['Home', 2],
    ['phone', 1],
  ]);
  if (counts.length !== want.size) {
    assert.fail(
      `Tags must return one row per distinct tag with its count\n  got ${list(counts.map((c) => `${c.name}=${c.count}`))}, expected ${list([...want].map(([n, c]) => `${n}=${c}`))}`,
    );
  }
  for (const c of counts) {
    if ((want.get(c.name) ?? 0) !== c.count) {
      assert.fail(
        `Tags must count the live tasks carrying each tag\n  ${JSON.stringify(c.name)} has count ${c.count}, expected ${want.get(c.name) ?? 0}`,
      );
    }
    if (c.status !== StatusActive) {
      assert.fail(
        `a tag nobody has put on hold must come back active\n  ${JSON.stringify(c.name)} is ${JSON.stringify(c.status)}`,
      );
    }
  }

  // Setting the tags of a task replaces them: `tdo edit --tag` is subtractive
  // as well as additive.
  stored.setTags(['garden']);
  await f.update(stored);
  requireSet(
    t,
    'updating a task replaces its tags rather than adding to them',
    await f.list(new Filter({ tags: ['home'] })),
    'call the plumber',
  );
  const after = await f.get(home.id);
  if (after.tags.length !== 1 || after.tags[0] !== 'garden') {
    assert.fail(
      `the stored tags must be the ones last written\n  got ${list(after.tags)}, expected [garden]`,
    );
  }

  // A tombstoned task no longer counts towards its tags. The tag itself stays
  // listed at zero: it has a row of its own now, and a context must not
  // disappear because the last task filed under it went in the bin.
  const deleted = await f.get(both.id);
  deleted.deletedAt = new Date(f.now.getTime());
  await f.update(deleted);
  try {
    counts = await f.s.tags();
  } catch (err) {
    requireNoError(t, 'Tags must still work once something is tombstoned', err);
  }
  for (const c of counts) {
    if (c.name.toLowerCase() === 'phone' && c.count !== 0) {
      assert.fail(
        `Tags must count live tasks only\n  ${JSON.stringify(c.name)} has count ${c.count} although its only task is tombstoned`,
      );
    }
  }
}

/**
 * testTagStatus is the promoted half of a tag: a row that carries a status,
 * and the two availability rules that status drives (§3.3).
 */
export async function testTagStatus(
  t: TestContext,
  f: Fixture,
): Promise<void> {
  const project = await f.add(KindProject, 'file the return');
  const call = await f.add(KindTask, 'call the accountant', (x) => {
    x.parentID = project.id;
    x.setTags(['Phone']);
  });
  const think = await f.add(KindTask, 'decide what to claim', (x) => {
    x.parentID = project.id;
    x.setTags(['anywhere']);
  });

  await requireAvailable(
    t,
    f,
    'a task carrying an active tag is available',
    call.id,
    true,
  );

  // A status may be set on a tag nobody has used yet: putting a context on
  // hold before filing anything under it is ordinary.
  requireNoError(
    t,
    'SetTagStatus must accept a tag that is not in use yet',
    await failed(() => f.s.setTagStatus('someday', StatusOnHold, f.now)),
  );
  requireNoError(
    t,
    'SetTagStatus must put a tag in use on hold',
    await failed(() => f.s.setTagStatus('phone', StatusOnHold, f.now)),
  );

  const av = await f.availability(call.id, think.id);
  const forCall = av.get(call.id);
  const forThink = av.get(think.id);
  if (forCall === undefined || forThink === undefined) {
    assert.fail('Availability must answer for both ids it was given');
  }
  if (forCall.available || forCall.rule !== RuleTagStatus) {
    assert.fail(
      `a tag on hold must hold back the task carrying it, with rule ${JSON.stringify(RuleTagStatus)}\n  got available=${forCall.available} rule=${JSON.stringify(forCall.rule)}`,
    );
  }
  if ((forCall.tag ?? '').toLowerCase() !== 'phone') {
    assert.fail(
      `the block must name the tag responsible, in its stored spelling\n  got ${JSON.stringify(forCall.tag ?? '')}, expected Phone`,
    );
  }
  if (!forThink.available) {
    assert.fail(
      `a tag on hold must hold back nothing but the items carrying it\n  ${JSON.stringify(think.title)} came back blocked by ${JSON.stringify(forThink.rule)}`,
    );
  }

  // The status is case-insensitive in and out, and it survives a listing.
  let tags: Tag[] = [];
  try {
    tags = await f.s.tags();
  } catch (err) {
    requireNoError(t, 'Tags must list the statuses it was given', err);
  }
  const status = new Map(tags.map((tag) => [tagKey(tag.name), tag.status]));
  if (
    status.get('phone') !== StatusOnHold ||
    status.get('someday') !== StatusOnHold
  ) {
    assert.fail(
      `Tags must report the status each tag carries\n  got ${list([...status].map(([n, s]) => `${n}=${s}`))}`,
    );
  }
  if (status.get('anywhere') !== StatusActive) {
    assert.fail(
      `a tag nobody has touched must stay active\n  got ${JSON.stringify(status.get('anywhere') ?? '')}`,
    );
  }

  // A tag on a container holds back what is inside it, exactly as putting the
  // container itself on hold would.
  const stored = await f.get(project.id);
  stored.setTags(['waiting']);
  await f.update(stored);
  requireNoError(
    t,
    "SetTagStatus must put a container's tag on hold",
    await failed(() => f.s.setTagStatus('waiting', StatusOnHold, f.now)),
  );
  const held = await f.answer(think.id);
  if (held.available || held.rule !== RuleAncestorTagStatus) {
    assert.fail(
      `a container's tag on hold must hold back its children, with rule ${JSON.stringify(RuleAncestorTagStatus)}\n  got available=${held.available} rule=${JSON.stringify(held.rule)}`,
    );
  }
  requireNoError(
    t,
    'SetTagStatus must lift a hold again',
    await failed(() => f.s.setTagStatus('waiting', StatusActive, f.now)),
  );
  await requireAvailable(
    t,
    f,
    'an active tag blocks nothing',
    think.id,
    true,
  );

  // Renaming carries the tasks over and keeps the destination's status.
  requireNoError(
    t,
    'RenameTag must rename a tag in use',
    await failed(() => f.s.renameTag('phone', 'calls', f.now)),
  );
  requireSet(
    t,
    'renaming a tag moves the tasks filed under it',
    await f.list(new Filter({ tags: ['calls'] })),
    'call the accountant',
  );
  if ((await f.answer(call.id)).available) {
    assert.fail(
      `a renamed tag must keep the status it was holding; ${JSON.stringify(call.title)} became available`,
    );
  }
  let err = await failed(() => f.s.removeTag('nothing-is-filed-here'));
  if (!wrapsSentinel(err, ErrNotFound)) {
    assert.fail(
      `RemoveTag must report an unknown tag as ErrNotFound, got ${reason(err)}`,
    );
  }
  err = await failed(() => f.s.renameTag('nothing-is-filed-here', 'x', f.now));
  if (!wrapsSentinel(err, ErrNotFound)) {
    assert.fail(
      `RenameTag must report an unknown source tag as ErrNotFound, got ${reason(err)}`,
    );
  }

  // Removing a tag takes it off every task and forgets its status, which also
  // lifts the hold it was putting on them.
  let n = 0;
  try {
    n = await f.s.removeTag('calls');
  } catch (e) {
    requireNoError(t, 'RemoveTag must remove a tag in use', e);
  }
  if (n !== 1) {
    assert.fail(
      `RemoveTag must report how many tasks it changed\n  got ${n}, expected 1`,
    );
  }
  const bare = await f.get(call.id);
  if (bare.tags.length !== 0) {
    assert.fail(
      `RemoveTag must take the tag off the tasks carrying it\n  ${JSON.stringify(bare.title)} still has ${list(bare.tags)}`,
    );
  }
  await requireAvailable(
    t,
    f,
    'removing the tag that was holding a task lifts the hold',
    call.id,
    true,
  );
  if ((await failed(() => f.s.setTagStatus('phone', 'done', f.now))) === undefined) {
    assert.fail(
      'a tag is never done: SetTagStatus must refuse the status `done`',
    );
  }
}

export async function testPerspectives(
  t: TestContext,
  f: Fixture,
): Promise<void> {
  const p: Perspective = {
    name: 'Next',
    filter: new Filter({
      kinds: [KindTask],
      statuses: [StatusActive],
      availability: AvailabilityAvailable,
      flagged: true,
      tags: ['home'],
      order: OrderDue,
      limit: 10,
    }),
    createdAt: f.now,
    updatedAt: f.now,
  };
  requireNoError(
    t,
    'SavePerspective must store a named filter',
    await failed(() => f.s.savePerspective(p)),
  );

  let got: Perspective | undefined;
  try {
    got = await f.s.perspective('next');
  } catch (err) {
    requireNoError(
      t,
      'a perspective must be found by name, compared case-insensitively since it is typed',
      err,
    );
  }
  if (got === undefined) {
    assert.fail('Perspective returned nothing for a perspective just saved');
  }
  if (got.name !== 'Next') {
    assert.fail(
      `a perspective must keep the spelling it was saved with\n  got ${JSON.stringify(got.name)}, expected "Next"`,
    );
  }
  requireSameFilter(
    'a perspective is a saved filter and nothing more, so it must read back as the filter it was saved with (PLAN.md §3.6)',
    got.filter,
    p.filter,
  );

  // Saving again under the same name replaces it rather than making a second
  // one.
  p.filter.limit = 20;
  p.updatedAt = timeAt(f.now, hour);
  requireNoError(
    t,
    'saving a perspective of the same name must replace it',
    await failed(() => f.s.savePerspective(p)),
  );
  let all: Perspective[] = [];
  try {
    all = await f.s.perspectives();
  } catch (err) {
    requireNoError(t, 'Perspectives must list what is saved', err);
  }
  if (all.length !== 1) {
    assert.fail(
      `saving the same name twice must leave one perspective, not two\n  there are ${all.length}`,
    );
  }
  if (all[0]?.filter.limit !== 20) {
    assert.fail(
      `a replaced perspective must hold the new filter\n  its limit is ${all[0]?.filter.limit ?? 0}, expected 20`,
    );
  }

  requireNoError(
    t,
    'a second perspective must be storable alongside the first',
    await failed(() =>
      f.s.savePerspective({
        name: 'Admin',
        filter: new Filter(),
        createdAt: f.now,
        updatedAt: f.now,
      }),
    ),
  );
  try {
    all = await f.s.perspectives();
  } catch (err) {
    requireNoError(t, 'Perspectives must list all of them', err);
  }
  if (all.length !== 2 || all[0]?.name !== 'Admin') {
    assert.fail(
      `Perspectives must be sorted by name\n  got ${list(all.map((x) => x.name))}`,
    );
  }

  // Every field of a filter narrows a listing, so a field a provider drops on
  // the way to the database or back makes the saved query wider than the one
  // the user saved — and a wider listing is acted on rather than reported.
  // Both providers store the filter as one JSON document, and this is what
  // says they must keep all of it.
  const whole: Perspective = {
    name: 'Everything set',
    filter: new Filter({
      kinds: [KindFolder, KindProject, KindTask],
      statuses: [StatusActive, StatusOnHold, StatusDone, StatusDropped],
      availability: AvailabilityDeferred,
      flagged: true,
      scope: new Scope({
        parentID: '01J3ZQK8V9XW5S6R7T8Y9Z0A1B',
        children: true,
        subtree: '01J3ZQK8V9XW5S6R7T8Y9Z0A1C',
        inbox: true,
      }),
      tags: ['home', 'errand'],
      tagsAny: true,
      deferBefore: timeAt(f.now, hour),
      deferAfter: timeAt(f.now, 2 * hour),
      dueBefore: timeAt(f.now, 3 * hour),
      dueAfter: timeAt(f.now, 4 * hour),
      hasDue: true,
      reviewDueBefore: timeAt(f.now, 5 * hour),
      includeDeleted: true,
      onlyDeleted: true,
      order: OrderDefer,
      limit: 7,
    }),
    createdAt: f.now,
    updatedAt: f.now,
  };
  requireNoError(
    t,
    'a filter using every field must be storable',
    await failed(() => f.s.savePerspective(whole)),
  );
  let back: Perspective | undefined;
  try {
    back = await f.s.perspective('everything set');
  } catch (err) {
    requireNoError(
      t,
      'a perspective using every filter field must be readable',
      err,
    );
  }
  if (back === undefined) {
    assert.fail('Perspective returned nothing for the all-fields perspective');
  }
  requireSameFilter(
    'every field of a saved filter must survive the store, or the perspective runs as a different and usually wider query (PLAN.md §3.6)',
    back.filter,
    whole.filter,
  );
  requireNoError(
    t,
    'tidying up the all-fields perspective',
    await failed(() => f.s.deletePerspective('everything set')),
  );

  requireNoError(
    t,
    'a perspective is a query, so deleting one is a real delete',
    await failed(() => f.s.deletePerspective('NEXT')),
  );
  requireIs(
    t,
    'a deleted perspective must be reported as not found',
    await failed(() => f.s.perspective('next')),
    ErrNotFound,
  );
  requireIs(
    t,
    'deleting a perspective that is not there must be reported as not found',
    await failed(() => f.s.deletePerspective('nothing')),
    ErrNotFound,
  );
}

/**
 * requireSameFilter is Go's `reflect.DeepEqual` over two filters. A Filter is
 * a class with every field initialized, so a structural comparison is exact:
 * a field a provider dropped comes back as its zero value and differs.
 */
function requireSameFilter(rule: string, got: Filter, want: Filter): void {
  try {
    assert.deepStrictEqual(got, want);
  } catch {
    assert.fail(
      `${rule}\n  got  ${JSON.stringify(got.toJSON())}\n  want ${JSON.stringify(want.toJSON())}`,
    );
  }
}

export async function testRepetition(
  t: TestContext,
  f: Fixture,
): Promise<void> {
  const repeating = await f.add(KindTask, 'water the plants', (x) => {
    x.repeat = { method: RepeatFromCompletion, every: '3d' };
    x.seriesID = '';
    x.dueAt = timeAt(f.now, day);
  });

  // The store persists the repeat and the series; generating the successor is
  // domain logic and happens above it (PLAN.md §3.4), so the store is only
  // asked to carry both unchanged.
  const stored = await f.get(repeating.id);
  if (
    !repeatEqual(stored.repeat, {
      method: RepeatFromCompletion,
      every: '3d',
    })
  ) {
    assert.fail(
      `a repeat must round-trip exactly, including a spelling this binary may not understand\n  got ${JSON.stringify(stored.repeat ?? null)}`,
    );
  }

  stored.seriesID = stored.id;
  await f.update(stored);

  const successor = newTask(
    newID(),
    KindTask,
    'water the plants',
    timeAt(f.now, 72 * hour),
  );
  successor.repeat = cloneRepeat(stored.repeat);
  successor.seriesID = stored.seriesID;
  await f.mustAdd(successor);

  stored.setStatus(StatusDone, timeAt(f.now, 72 * hour));
  await f.update(stored);

  const done = await f.get(repeating.id);
  if (done.status !== StatusDone || done.completedAt === undefined) {
    assert.fail(
      `completing a task must store the status and the moment it happened\n  status is ${JSON.stringify(done.status)} and completed_at is ${String(done.completedAt)}`,
    );
  }
  const next = await f.get(successor.id);
  if (next.seriesID !== done.seriesID || next.seriesID === '') {
    assert.fail(
      `the instances of a repeat are tied together by series_id\n  the successor has ${JSON.stringify(next.seriesID)} and the completed instance has ${JSON.stringify(done.seriesID)}`,
    );
  }
  if (next.id === done.id) {
    assert.fail(
      'a successor is a new row with a fresh id, not an edit of the instance that was completed',
    );
  }

  // Ending a series leaves its history: the repeat goes, the rows stay.
  next.repeat = undefined;
  await f.update(next);
  const ended = await f.get(successor.id);
  if (ended.repeat !== undefined) {
    assert.fail(
      `\`tdo repeat --stop\` clears the repeat, so an absent repeat must be stored as no repeat\n  got ${JSON.stringify(ended.repeat)}`,
    );
  }
  if (ended.seriesID === '') {
    assert.fail(
      'ending a series must leave its history: series_id stays on the instances that were part of it',
    );
  }
}

export async function testReview(t: TestContext, f: Fixture): Promise<void> {
  const weekly = await f.add(KindProject, 'weekly project', (x) => {
    x.reviewInterval = { every: '1w' };
    x.lastReviewedAt = timeAt(f.now, -8 * day);
  });
  await f.add(KindProject, 'recently reviewed', (x) => {
    x.reviewInterval = { every: '1w' };
    x.lastReviewedAt = timeAt(f.now, -day);
  });
  await f.add(KindFolder, 'never reviewed', (x) => {
    x.reviewInterval = { every: '1mo' };
  });
  await f.add(KindProject, 'not on review');

  const stored = await f.get(weekly.id);
  if (stored.reviewInterval?.every !== '1w') {
    assert.fail(
      `a review interval must round-trip\n  got ${JSON.stringify(stored.reviewInterval ?? null)}`,
    );
  }

  const soon = timeAt(f.now, 60 * 1000);
  requireSet(
    t,
    '`tdo review` lists what is due: next_review_at is last_reviewed_at plus the interval, and an item never reviewed is due now (PLAN.md §3.5)',
    await f.list(new Filter({ reviewDueBefore: soon })),
    'weekly project',
    'never reviewed',
  );

  // Marking one reviewed takes it out of the listing without touching the
  // interval, because next_review_at is derived and not stored.
  stored.lastReviewedAt = f.now;
  await f.update(stored);
  requireSet(
    t,
    'an item marked reviewed drops out of the review listing until its interval comes round again',
    await f.list(new Filter({ reviewDueBefore: soon })),
    'never reviewed',
  );
}

export async function testSentinels(
  t: TestContext,
  f: Fixture,
): Promise<void> {
  const missing = newID();

  requireIs(
    t,
    'Get on an unknown id must report ErrNotFound, which the command layer maps to exit 5',
    await failed(() => f.s.get(missing)),
    ErrNotFound,
  );

  const ghost = newTask(missing, KindTask, 'ghost', f.now);
  requireIs(
    t,
    'Update on an unknown id must report ErrNotFound rather than quietly inserting a row',
    await failed(() => f.s.update(ghost)),
    ErrNotFound,
  );
  requireIs(
    t,
    'Purge on an unknown id must report ErrNotFound',
    await failed(() => f.s.purge(missing)),
    ErrNotFound,
  );
  requireIs(
    t,
    'Subtree on an unknown id must report ErrNotFound',
    await failed(() => f.s.subtree(missing)),
    ErrNotFound,
  );
  requireIs(
    t,
    'PurgeSubtree on an unknown id must report ErrNotFound',
    await failed(() => f.s.purgeSubtree(missing)),
    ErrNotFound,
  );
  requireIs(
    t,
    'Move of an unknown id must report ErrNotFound',
    await failed(() => f.s.move(missing, '', 0, f.now)),
    ErrNotFound,
  );

  const existing = await f.add(KindTask, 'existing');
  const duplicate = newTask(existing.id, KindTask, 'duplicate', f.now);
  requireIs(
    t,
    'Add must refuse an id that is already stored rather than overwriting it, so that a generator bug cannot destroy data',
    await failed(() => f.s.add(duplicate)),
    ErrExists,
  );
  const untouched = await f.get(existing.id);
  if (untouched.title !== 'existing') {
    assert.fail(
      `a refused duplicate must leave the stored task alone\n  its title is now ${JSON.stringify(untouched.title)}`,
    );
  }

  // Two ids sharing a prefix: one is a lookup, two is ambiguity.
  const a = await f.mustAdd(
    newTask('01J0000000000000000000000A', KindTask, 'prefix a', f.now),
  );
  await f.mustAdd(
    newTask('01J0000000000000000000000B', KindTask, 'prefix b', f.now),
  );
  let found: Task | undefined;
  try {
    found = await f.s.findByPrefix('01J0000000000000000000000A');
  } catch (err) {
    requireNoError(
      t,
      'an id prefix that matches one task must resolve to it',
      err,
    );
  }
  if (found?.id !== a.id) {
    assert.fail(
      `FindByPrefix must return the task whose id starts with the prefix\n  got ${JSON.stringify(found?.id ?? '')}`,
    );
  }
  requireIs(
    t,
    'an id prefix matching several tasks must report ErrAmbiguous, which the command layer maps to exit 6',
    await failed(() => f.s.findByPrefix('01J0')),
    ErrAmbiguous,
  );
  requireIs(
    t,
    'an id prefix matching nothing must report ErrNotFound',
    await failed(() => f.s.findByPrefix('ZZZZZZ')),
    ErrNotFound,
  );

  // LIKE metacharacters are data, not syntax.
  requireIs(
    t,
    'a prefix of LIKE metacharacters must match nothing: a prefix is data, never pattern syntax',
    await failed(() => f.s.findByPrefix('%')),
    ErrNotFound,
  );
  requireIs(
    t,
    'an underscore in a prefix must not match an arbitrary character',
    await failed(() => f.s.findByPrefix('_1J0000000000000000000000A')),
    ErrNotFound,
  );

  // A container is not purged out from under its children.
  const project = await f.add(KindProject, 'a project with contents');
  const child = await f.add(KindTask, 'contents', under(project));
  requireIs(
    t,
    'purging a container that still holds items would orphan them, so it must be refused with ErrNotEmpty (PLAN.md §3.1)',
    await failed(() => f.s.purge(project.id)),
    ErrNotEmpty,
  );
  const stillThere = await failed(() => f.s.get(child.id));
  if (stillThere !== undefined) {
    assert.fail(
      `a refused purge must leave the subtree intact\n  the child is gone: ${reason(stillThere)}`,
    );
  }
  let n = 0;
  try {
    n = await f.s.purgeSubtree(project.id);
  } catch (err) {
    requireNoError(
      t,
      'PurgeSubtree is how a container is really deleted',
      err,
    );
  }
  if (n !== 2) {
    assert.fail(
      `PurgeSubtree must report how many rows went\n  it reported ${n}, expected 2`,
    );
  }
  if (!wrapsSentinel(await failed(() => f.s.get(child.id)), ErrNotFound)) {
    assert.fail(
      'PurgeSubtree must remove the children as well as the container\n  the child is still there',
    );
  }
}

export async function testIDNormalization(
  t: TestContext,
  f: Fixture,
): Promise<void> {
  // Base32 is case-insensitive, so an id pasted in lower case addresses the
  // same task. Every id-addressed call must agree about that, or a row
  // written through one is unreachable through another.
  const upper = newID();
  const lower = upper.toLowerCase();

  await f.mustAdd(
    newTask(lower, KindProject, 'written in lower case', f.now),
  );

  if ((await f.get(upper)).title !== 'written in lower case') {
    assert.fail(
      'Add must store the canonical spelling of an id, so Get with the upper-case form must find it',
    );
  }
  const canonical = await f.get(lower);
  if (canonical.id !== normalizeID(upper)) {
    assert.fail(
      `Get must normalise the id it is given and return the canonical one\n  got ${JSON.stringify(canonical.id)}`,
    );
  }

  const edited = newTask(
    lower,
    KindProject,
    'edited through the lower-case id',
    f.now,
  );
  requireNoError(
    t,
    'Update must normalise the id the same way Add does, or an edit silently inserts nothing',
    await failed(() => f.s.update(edited)),
  );
  if ((await f.get(upper)).title !== 'edited through the lower-case id') {
    assert.fail(
      'an Update addressed by a lower-case id must reach the stored row',
    );
  }

  const child = newTask(
    newID().toLowerCase(),
    KindTask,
    'child',
    f.now,
  );
  child.parentID = lower;
  requireNoError(
    t,
    'a parent reference must be normalised too, or the edge points at nothing',
    await failed(() => f.s.add(child)),
  );
  const storedChild = await f.get(child.id);
  if (storedChild.parentID !== normalizeID(upper)) {
    assert.fail(
      `the stored parent edge must be the canonical id\n  got ${JSON.stringify(storedChild.parentID)}`,
    );
  }

  requireNoError(
    t,
    'Move must accept an id in either case',
    await failed(() => f.s.move(child.id.toUpperCase(), '', 0, f.now)),
  );
  requireNoError(
    t,
    'Purge must normalise the id it is given',
    await failed(() => f.s.purge(child.id.toLowerCase())),
  );
  if (!wrapsSentinel(await failed(() => f.s.get(child.id)), ErrNotFound)) {
    assert.fail(
      'a purge addressed by a lower-case id must remove the row\n  it is still there',
    );
  }
}

/**
 * hostileFields are values that have broken a store before: a key that looks
 * like SQL, a value holding a quote or a NUL, numbers at the edge of what the
 * runtime holds exactly.
 *
 * Go's edges were `math.MaxInt64` and `math.MinInt64`, which JavaScript cannot
 * hold in a `number` at all. The equivalent edges here are the safe-integer
 * boundary — past which a provider that round-trips a number through text can
 * lose the last digit — and a value far beyond it, which is where Go's
 * `1e19` sat relative to int64.
 */
export function hostileFields(): Fields {
  return {
    quote: 'it\'s "quoted" -- not a comment',
    semicolon: 'a; DROP TABLE tasks;--',
    nul: 'before\u0000after',
    unicode: '日本語 ‮ rtl',
    json: { nested: [1, 'two', true] },
    max_safe_integer: Number.MAX_SAFE_INTEGER,
    min_safe_integer: -Number.MAX_SAFE_INTEGER,
    past_safe_integer: 1e19,
    whole_float: 2 ** 53,
    empty: '',
    "'; DELETE --": 'a key that looks like SQL is a key, not syntax',
    percent_like: '100%_done',
    deep: { a: { b: { c: 1 } } },
    long: 'x'.repeat(4096),
  };
}

export async function testOpenFields(
  t: TestContext,
  f: Fixture,
): Promise<void> {
  const stored = await f.add(KindTask, 'hostile', (x) => {
    x.fields = hostileFields();
    x.note = "a note with 'quotes' and a \u0000 byte";
    x.estimatedMinutes = 45;
    x.flagged = true;
  });

  const got = await f.get(stored.id);
  const want = hostileFields();
  FieldsOf.normalize(want);
  const failures = new Failures();
  for (const [key, wantValue] of Object.entries(want)) {
    if (!Object.hasOwn(got.fields, key)) {
      assert.fail(
        `a user-defined field must survive the round trip\n  ${JSON.stringify(key)} is missing from the task that came back`,
      );
    }
    const gotValue = got.fields[key];
    try {
      assert.deepStrictEqual(gotValue, wantValue);
    } catch {
      failures.add(
        `a user-defined value must come back as it went in, with the same JSON type\n  ${JSON.stringify(key)} is ${JSON.stringify(gotValue ?? null)}, expected ${JSON.stringify(wantValue)}`,
      );
    }
  }
  failures.check();
  if (got.note !== stored.note) {
    assert.fail(
      `a note is stored as data, byte for byte\n  got ${JSON.stringify(got.note)}, expected ${JSON.stringify(stored.note)}`,
    );
  }
  if (got.estimatedMinutes !== 45 || !got.flagged) {
    assert.fail(
      `the required fields must round-trip\n  estimated_minutes is ${got.estimatedMinutes} and flagged is ${got.flagged}`,
    );
  }

  // A `--where` condition is evaluated on the client, over whatever came
  // back, and must see the same values.
  const c = new Condition({ match: { percent_like: '100%_done' } });
  if (!c.matches(got)) {
    assert.fail(
      'a client-side condition must see the user-defined values exactly as they were stored',
    );
  }
}

export async function testFilters(t: TestContext, f: Fixture): Promise<void> {
  const folder = await f.add(KindFolder, 'folder');
  const project = await f.add(KindProject, 'project', under(folder));
  await f.add(KindTask, 'flagged', under(project), (x) => {
    x.flagged = true;
  });
  await f.add(KindTask, 'due soon', under(project), (x) => {
    x.dueAt = timeAt(f.now, hour);
  });
  await f.add(KindTask, 'due later', under(project), (x) => {
    x.dueAt = timeAt(f.now, 72 * hour);
  });
  await f.add(KindTask, 'held', under(project), (x) => {
    x.status = StatusOnHold;
  });
  await f.add(KindTask, 'elsewhere');

  requireSet(
    t,
    'a kind filter keeps only those kinds',
    await f.list(new Filter({ kinds: [KindFolder, KindProject] })),
    'folder',
    'project',
  );
  requireSet(
    t,
    'a status filter keeps only those statuses',
    await f.list(new Filter({ statuses: [StatusOnHold] })),
    'held',
  );
  requireSet(
    t,
    'an empty status filter does not filter: it is the command layer that decides what `tdo ls` defaults to',
    await f.list(new Filter({ kinds: [KindTask] })),
    'flagged',
    'due soon',
    'due later',
    'held',
    'elsewhere',
  );
  requireSet(
    t,
    'a flagged filter of true keeps the flagged items',
    await f.list(new Filter({ flagged: true })),
    'flagged',
  );

  const cutoff = timeAt(f.now, 24 * hour);
  requireSet(
    t,
    '`--due-before` keeps the items with a due date strictly before the instant, and drops the ones with no due date at all',
    await f.list(new Filter({ dueBefore: cutoff })),
    'due soon',
  );
  requireSet(
    t,
    '`--due-after` is its mirror',
    await f.list(new Filter({ dueAfter: cutoff })),
    'due later',
  );
  requireSet(
    t,
    'a has-due filter of false keeps only the items with no deadline',
    await f.list(new Filter({ kinds: [KindTask], hasDue: false })),
    'flagged',
    'held',
    'elsewhere',
  );

  requireSet(
    t,
    'a children scope is one level, not the whole subtree',
    await f.list(
      new Filter({ scope: new Scope({ children: true, parentID: folder.id }) }),
    ),
    'project',
  );
  requireSet(
    t,
    'a subtree scope holds the container and everything beneath it',
    await f.list(new Filter({ scope: new Scope({ subtree: folder.id }) })),
    'folder',
    'project',
    'flagged',
    'due soon',
    'due later',
    'held',
  );

  const limited = await f.list(new Filter({ limit: 2 }));
  if (limited.length !== 2) {
    assert.fail(
      `a limit caps the listing\n  it returned ${limited.length} item(s), expected 2`,
    );
  }
  const full = await f.list(new Filter());
  requireTitles(
    t,
    'a limit takes the first n of the listing the filter would have returned, in the same order',
    limited,
    ...titles(full).slice(0, 2),
  );
}
