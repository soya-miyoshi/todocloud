// The tree, the inbox, availability, ordering and the three accessors that
// nothing else in the suite reaches on their own terms.

import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';

import {
  type Availability,
  AvailabilityAvailable,
  AvailabilityBlocked,
  AvailabilityDeferred,
  ErrBadParent,
  ErrCycle,
  ErrNotFound,
  Filter,
  type Kind,
  KindFolder,
  KindProject,
  Kinds,
  KindTask,
  New as newID,
  newTask,
  OrderCreated,
  OrderDue,
  OrderUpdated,
  type Rule,
  RuleAncestorDeferred,
  RuleAncestorSequential,
  RuleAncestorStatus,
  RuleDeferred,
  RuleDeleted,
  RuleNone,
  RuleNotActionable,
  RuleSequential,
  RuleStatus,
  Scope,
  StatusDone,
  StatusDropped,
  StatusOnHold,
  type Task,
} from '@todocloud/core';

import {
  at,
  describe,
  Failures,
  failed,
  type Fixture,
  hour,
  ids,
  list,
  requireIs,
  requireNoError,
  requireSet,
  requireTitles,
  reason,
  timeAt,
  titles,
  under,
} from './storetest.ts';

export async function testFreshStore(
  t: TestContext,
  f: Fixture,
): Promise<void> {
  const got = await f.list(new Filter());
  if (got.length !== 0) {
    assert.fail(
      `a store that was just created must hold nothing\n  it holds ${list(titles(got))}`,
    );
  }
  let version = 0;
  try {
    version = await f.s.schemaVersion();
  } catch (err) {
    requireNoError(t, 'SchemaVersion must report a version once Init has run', err);
  }
  if (version < 1) {
    assert.fail(`SchemaVersion must be at least 1 after Init, got ${version}`);
  }
  requireNoError(
    t,
    'Init must be idempotent, so a second call must succeed',
    await failed(() => f.s.init()),
  );
  requireNoError(
    t,
    'Ping must succeed on an initialized store',
    await failed(() => f.s.ping()),
  );
  requireNoError(
    t,
    'Migrate on a store at the current version must do nothing and succeed',
    await failed(() => f.s.migrate()),
  );
  if (f.s.describe() === '') {
    assert.fail(
      'Describe must say where the tasks are, credential-free, and must not be empty',
    );
  }
}

/**
 * testContainment walks the whole table of PLAN.md §3.1: a folder holds
 * folders and projects, a project holds tasks, a task holds tasks, and
 * anything at the top level is allowed.
 */
export async function testContainment(
  t: TestContext,
  f: Fixture,
): Promise<void> {
  const folder = await f.add(KindFolder, 'folder');
  const project = await f.add(KindProject, 'project', under(folder));
  const action = await f.add(KindTask, 'action', under(project));
  const parents = new Map<Kind, Task>([
    [KindFolder, folder],
    [KindProject, project],
    [KindTask, action],
  ]);

  const cases: Array<{ parent: Kind; child: Kind; allow: boolean }> = [
    { parent: KindFolder, child: KindFolder, allow: true },
    { parent: KindFolder, child: KindProject, allow: true },
    { parent: KindFolder, child: KindTask, allow: false },
    { parent: KindProject, child: KindFolder, allow: false },
    { parent: KindProject, child: KindProject, allow: false },
    { parent: KindProject, child: KindTask, allow: true },
    { parent: KindTask, child: KindFolder, allow: false },
    { parent: KindTask, child: KindProject, allow: false },
    { parent: KindTask, child: KindTask, allow: true },
  ];
  for (const c of cases) {
    const child = newTask(
      newID(),
      c.child,
      `${c.child} in ${c.parent}`,
      f.now,
    );
    child.parentID = (parents.get(c.parent) as Task).id;
    const err = await failed(() => f.s.add(child));
    if (c.allow && err !== undefined) {
      assert.fail(
        `PLAN.md §3.1 allows a ${c.child} inside a ${c.parent}, so Add must accept it\n  it failed: ${reason(err)}`,
      );
    } else if (!c.allow && err === undefined) {
      assert.fail(
        `PLAN.md §3.1 does not allow a ${c.child} inside a ${c.parent}, so Add must refuse it with ErrBadParent\n  it was accepted`,
      );
    } else if (!c.allow) {
      requireIs(
        t,
        'an illegal containment must be reported as ErrBadParent, which the command layer maps to exit 2',
        err,
        ErrBadParent,
      );
    }
  }

  for (const kind of Kinds()) {
    const top = newTask(newID(), kind, `top-level ${kind}`, f.now);
    requireNoError(
      t,
      `any kind may sit at the top level, so Add must accept a ${kind} with no parent`,
      await failed(() => f.s.add(top)),
    );
  }

  // The same table governs a move, not only a creation.
  requireIs(
    t,
    'Move must enforce the containment table too: a task cannot be moved directly into a folder',
    await failed(() => f.s.move(action.id, folder.id, 0, f.now)),
    ErrBadParent,
  );

  // And an unknown parent is a missing reference, not a bad one.
  const orphan = newTask(newID(), KindTask, 'orphan', f.now);
  orphan.parentID = newID();
  requireIs(
    t,
    'Add must refuse a parent that does not exist, since the alternative is an item no listing can reach',
    await failed(() => f.s.add(orphan)),
    ErrNotFound,
  );
}

export async function testCycles(t: TestContext, f: Fixture): Promise<void> {
  const root = await f.add(KindFolder, 'root');
  const mid = await f.add(KindFolder, 'mid', under(root));
  const leaf = await f.add(KindFolder, 'leaf', under(mid));

  requireIs(
    t,
    'an item made its own parent is a cycle and must be refused (PLAN.md §3.1)',
    await failed(() => f.s.move(root.id, root.id, 0, f.now)),
    ErrCycle,
  );
  requireIs(
    t,
    'moving an item under its own child is a cycle and must be refused',
    await failed(() => f.s.move(root.id, mid.id, 0, f.now)),
    ErrCycle,
  );
  requireIs(
    t,
    'moving an item under a deeper descendant is a cycle and must be refused',
    await failed(() => f.s.move(root.id, leaf.id, 0, f.now)),
    ErrCycle,
  );

  // Update is a reparenting operation too, so it is held to the same rule.
  const stored = await f.get(root.id);
  stored.parentID = leaf.id;
  requireIs(
    t,
    'Update must refuse a parent change that creates a cycle, exactly as Move does',
    await failed(() => f.s.update(stored)),
    ErrCycle,
  );

  // The refused moves must have changed nothing.
  const after = await f.get(root.id);
  if (after.parentID !== '') {
    assert.fail(
      `a refused move must leave the tree untouched\n  root now has parent ${JSON.stringify(after.parentID)}`,
    );
  }

  // A legal move still works, and moves the whole subtree with it.
  const sibling = await f.add(KindFolder, 'sibling');
  requireNoError(
    t,
    'moving a subtree under an unrelated folder is legal and must succeed',
    await failed(() => f.s.move(mid.id, sibling.id, 3, f.now)),
  );
  const moved = await f.get(mid.id);
  if (moved.parentID !== sibling.id || moved.position !== 3) {
    assert.fail(
      `Move must set both the parent and the position\n  parent is ${JSON.stringify(moved.parentID)} (expected ${JSON.stringify(sibling.id)}) and position is ${moved.position} (expected 3)`,
    );
  }
  let sub: Task[] = [];
  try {
    sub = await f.s.subtree(sibling.id);
  } catch (err) {
    requireNoError(
      t,
      'Subtree must return the container and everything beneath it',
      err,
    );
  }
  requireTitles(
    t,
    'a move carries the whole subtree: Subtree must return the container, then its children in tree order',
    sub,
    'sibling',
    'mid',
    'leaf',
  );
}

export async function testInbox(t: TestContext, f: Fixture): Promise<void> {
  const loose = await f.add(KindTask, 'loose action');
  const project = await f.add(KindProject, 'a project');
  await f.add(KindTask, 'filed action', under(project));
  await f.add(KindFolder, 'a folder');

  requireSet(
    t,
    'the inbox is the absence of a parent: it holds tasks with no parent and nothing else (PLAN.md §3.1)',
    await f.list(new Filter({ scope: new Scope({ inbox: true }) })),
    'loose action',
  );

  requireSet(
    t,
    'a top-level listing is every root, which is not the same thing as the inbox',
    await f.list(new Filter({ scope: new Scope({ children: true }) })),
    'loose action',
    'a project',
    'a folder',
  );

  // Filing a loose task empties the inbox without anything being created or
  // deleted: the inbox is not a container.
  requireNoError(
    t,
    'filing an inbox task under a project must succeed',
    await failed(() => f.s.move(loose.id, project.id, 0, f.now)),
  );
  const inbox = await f.list(new Filter({ scope: new Scope({ inbox: true }) }));
  if (inbox.length !== 0) {
    assert.fail(
      `a filed task must leave the inbox\n  the inbox still holds ${list(titles(inbox))}`,
    );
  }
  let children: Task[] = [];
  try {
    children = await f.s.children(project.id);
  } catch (err) {
    requireNoError(
      t,
      'Children must list the direct children of a container',
      err,
    );
  }
  requireSet(
    t,
    'the filed task must now be a child of the project it was moved into',
    children,
    'loose action',
    'filed action',
  );
}

/**
 * testAvailability is the truth table of PLAN.md §3.3, including the
 * interactions: the rule reported must be the most specific one, and an
 * ancestor's state must reach every item beneath it.
 */
export async function testAvailability(
  t: TestContext,
  f: Fixture,
): Promise<void> {
  const past = timeAt(f.now, -hour);
  const future = timeAt(f.now, hour);

  const parallel = await f.add(KindProject, 'parallel project');
  const onHold = await f.add(KindProject, 'project on hold', (x) => {
    x.status = StatusOnHold;
  });
  const deferredProject = await f.add(KindProject, 'deferred project', (x) => {
    x.deferAt = future;
  });
  const heldFolder = await f.add(KindFolder, 'folder on hold', (x) => {
    x.status = StatusOnHold;
  });
  const inHeldFolder = await f.add(
    KindProject,
    'project in a held folder',
    under(heldFolder),
  );
  const liveFolder = await f.add(KindFolder, 'live folder');
  const inLiveFolder = await f.add(
    KindProject,
    'project in a live folder',
    under(liveFolder),
  );

  const plain = await f.add(KindTask, 'plain', under(parallel));
  const held = await f.add(KindTask, 'held', under(parallel), (x) => {
    x.status = StatusOnHold;
  });
  const done = await f.add(KindTask, 'done', under(parallel), (x) => {
    x.status = StatusDone;
  });
  const dropped = await f.add(KindTask, 'dropped', under(parallel), (x) => {
    x.status = StatusDropped;
  });
  const deferredPast = await f.add(
    KindTask,
    'deferred to the past',
    under(parallel),
    (x) => {
      x.deferAt = past;
    },
  );
  const deferredNow = await f.add(
    KindTask,
    'deferred to exactly now',
    under(parallel),
    (x) => {
      x.deferAt = new Date(f.now.getTime());
    },
  );
  const deferredFuture = await f.add(
    KindTask,
    'deferred to the future',
    under(parallel),
    (x) => {
      x.deferAt = future;
    },
  );

  const underHold = await f.add(
    KindTask,
    'under a held project',
    under(onHold),
  );
  const underDeferred = await f.add(
    KindTask,
    'under a deferred project',
    under(deferredProject),
  );
  const underHeldFolder = await f.add(
    KindTask,
    'under a held folder',
    under(inHeldFolder),
  );
  const underLiveFolder = await f.add(
    KindTask,
    'under a live folder',
    under(inLiveFolder),
  );

  // A deferred child of a sequential project that is itself on hold: three
  // rules apply at once and the most specific one must win.
  const seqHold = await f.add(
    KindProject,
    'sequential project on hold',
    (x) => {
      x.sequential = true;
      x.status = StatusOnHold;
    },
  );
  const seqHoldFirst = await f.add(
    KindTask,
    'first under a held sequential project',
    under(seqHold),
    at(1),
  );
  const seqHoldDeferred = await f.add(
    KindTask,
    'deferred second under a held sequential project',
    under(seqHold),
    at(2),
    (x) => {
      x.deferAt = future;
    },
  );

  const seq = await f.add(KindProject, 'sequential project', (x) => {
    x.sequential = true;
  });
  const seqDone = await f.add(
    KindTask,
    'sequential first, done',
    under(seq),
    at(1),
    (x) => {
      x.status = StatusDone;
    },
  );
  const seqDropped = await f.add(
    KindTask,
    'sequential second, dropped',
    under(seq),
    at(2),
    (x) => {
      x.status = StatusDropped;
    },
  );
  const seqDeleted = await f.add(
    KindTask,
    'sequential third, deleted',
    under(seq),
    at(3),
    (x) => {
      x.deletedAt = new Date(f.now.getTime());
    },
  );
  const seqNext = await f.add(
    KindTask,
    'sequential fourth, the next action',
    under(seq),
    at(4),
  );
  const seqWaiting = await f.add(
    KindTask,
    'sequential fifth, waiting its turn',
    under(seq),
    at(5),
  );

  // Nesting: the second action group of a sequential project has not come up
  // yet, so nothing inside it has either. It needs a sequential project of
  // its own, because within one parent only one child can be next.
  const seqGroups = await f.add(
    KindProject,
    'sequential project of groups',
    (x) => {
      x.sequential = true;
    },
  );
  const groupFirst = await f.add(
    KindTask,
    'first action group',
    under(seqGroups),
    at(1),
  );
  const inGroupFirst = await f.add(
    KindTask,
    'inside the first group',
    under(groupFirst),
  );
  const groupSecond = await f.add(
    KindTask,
    'second action group',
    under(seqGroups),
    at(2),
  );
  const inGroupSecond = await f.add(
    KindTask,
    'inside the second group',
    under(groupSecond),
  );

  const tombstoned = await f.add(
    KindTask,
    'tombstoned',
    under(parallel),
    (x) => {
      x.deletedAt = new Date(f.now.getTime());
    },
  );

  const cases: Array<{
    item: Task;
    rule: Rule;
    by: Task | undefined;
    why: string;
  }> = [
    {
      item: plain,
      rule: RuleNone,
      by: undefined,
      why: 'an active task with no defer date under an active parallel project is available',
    },
    {
      item: held,
      rule: RuleStatus,
      by: held,
      why: 'rule 1: a task that is not active is not available',
    },
    {
      item: done,
      rule: RuleStatus,
      by: done,
      why: 'rule 1: a completed task is not available',
    },
    {
      item: dropped,
      rule: RuleStatus,
      by: dropped,
      why: 'rule 1: a dropped task is not available',
    },
    {
      item: deferredPast,
      rule: RuleNone,
      by: undefined,
      why: 'rule 2: a defer date in the past has arrived',
    },
    {
      item: deferredNow,
      rule: RuleNone,
      by: undefined,
      why: 'rule 2: a defer date of exactly now has arrived; the comparison is strict',
    },
    {
      item: deferredFuture,
      rule: RuleDeferred,
      by: deferredFuture,
      why: 'rule 2: a defer date in the future blocks the item itself',
    },
    {
      item: parallel,
      rule: RuleNone,
      by: undefined,
      why: 'a project is actionable, so an active project with no defer date is available',
    },
    {
      item: liveFolder,
      rule: RuleNotActionable,
      by: liveFolder,
      why: 'a folder organises and is never actionable, whatever its status',
    },
    {
      item: tombstoned,
      rule: RuleDeleted,
      by: tombstoned,
      why: 'a tombstoned item is never available',
    },
    {
      item: underHold,
      rule: RuleAncestorStatus,
      by: onHold,
      why: 'rule 3: putting a project on hold empties it from every list',
    },
    {
      item: underDeferred,
      rule: RuleAncestorDeferred,
      by: deferredProject,
      why: "rule 3: an ancestor's future defer date blocks everything beneath it",
    },
    {
      item: underHeldFolder,
      rule: RuleAncestorStatus,
      by: heldFolder,
      why: 'rule 3: a held folder blocks the projects filed in it, and their actions',
    },
    {
      item: underLiveFolder,
      rule: RuleNone,
      by: undefined,
      why: 'rule 3: an active folder blocks nothing; filing a project must not hide its actions',
    },
    {
      item: seqHoldFirst,
      rule: RuleAncestorStatus,
      by: seqHold,
      why: 'rule 3 before rule 4: the first child of a sequential project on hold is blocked by the hold',
    },
    {
      item: seqHoldDeferred,
      rule: RuleDeferred,
      by: seqHoldDeferred,
      why: "the item's own state is the most specific reason: its own defer date is reported, not its ancestor's hold",
    },
    {
      item: seqNext,
      rule: RuleNone,
      by: undefined,
      why: 'rule 4: a sequential parent skips children that are done, dropped or deleted, so the first still-open one is available',
    },
    {
      item: seqWaiting,
      rule: RuleSequential,
      by: seqNext,
      why: 'rule 4: a later child of a sequential parent is blocked by the child that is next',
    },
    {
      item: inGroupFirst,
      rule: RuleNone,
      by: undefined,
      why: 'rule 4 nests: the first action group of a sequential project has come up, so its contents have too',
    },
    {
      item: inGroupSecond,
      rule: RuleAncestorSequential,
      by: groupSecond,
      why: 'rule 4 nests: a later action group has not come up, so nothing inside it has either',
    },
  ];

  const allIDs = ids([
    plain,
    held,
    done,
    dropped,
    deferredPast,
    deferredNow,
    deferredFuture,
    parallel,
    liveFolder,
    tombstoned,
    underHold,
    underDeferred,
    underHeldFolder,
    underLiveFolder,
    seqHoldFirst,
    seqHoldDeferred,
    seqNext,
    seqWaiting,
    inGroupFirst,
    inGroupSecond,
    seqDone,
    seqDropped,
    seqDeleted,
    groupFirst,
  ]);
  const got = await f.availability(...allIDs);

  const failures = new Failures();
  for (const c of cases) {
    const a = got.get(c.item.id);
    if (a === undefined) {
      assert.fail(
        `Availability must return an answer for ${JSON.stringify(c.item.title)}, which exists`,
      );
    }
    const wantAvailable = c.rule === RuleNone;
    if (a.available !== wantAvailable) {
      failures.add(
        `${c.why}\n  ${JSON.stringify(c.item.title)} is ${describe(a)}, expected ${wantAvailable ? 'available' : 'blocked'}`,
      );
      continue;
    }
    if (wantAvailable) {
      continue;
    }
    if (a.rule !== c.rule) {
      failures.add(
        `${c.why}\n  ${JSON.stringify(c.item.title)} is ${describe(a)}, expected rule ${JSON.stringify(c.rule)}`,
      );
    }
    if (c.by !== undefined && a.blockedBy !== c.by.id) {
      failures.add(
        `${c.why}\n  blocked_by must name the item responsible: ${JSON.stringify(c.item.title)} is ${describe(a)}, expected it to name ${JSON.stringify(c.by.title)}`,
      );
    }
  }

  // The availability filter must agree with the computation, item for item: a
  // provider that pushes part of it into its query language has to arrive at
  // the same set.
  const listed = await f.list(
    new Filter({ availability: AvailabilityAvailable }),
  );
  const inListing = new Set(ids(listed));
  for (const c of cases) {
    const want = c.rule === RuleNone;
    if (inListing.has(c.item.id) !== want) {
      failures.add(
        `a listing filtered to available items must hold exactly the items Availability calls available\n  ${JSON.stringify(c.item.title)} is ${inListing.has(c.item.id) ? '' : 'not '}in the listing, and Availability says ${describe(got.get(c.item.id) as Availability)}`,
      );
    }
  }

  const blockedList = await f.list(
    new Filter({ availability: AvailabilityBlocked, includeDeleted: true }),
  );
  for (const item of blockedList) {
    if (got.get(item.id)?.available === true) {
      failures.add(
        `a listing filtered to blocked items must hold nothing that is available\n  ${JSON.stringify(item.title)} is in it and is available`,
      );
    }
  }
  failures.check();

  const deferredList = await f.list(
    new Filter({ availability: AvailabilityDeferred }),
  );
  requireSet(
    t,
    '`--deferred` asks what is waiting for a date, which is narrower than what is blocked: only the defer rules count',
    deferredList,
    'deferred project',
    'deferred to the future',
    'under a deferred project',
    'deferred second under a held sequential project',
  );
}

export async function testOrdering(
  t: TestContext,
  f: Fixture,
): Promise<void> {
  const project = await f.add(KindProject, 'project', at(0));
  const third = await f.add(KindTask, 'third', under(project), at(30));
  const first = await f.add(KindTask, 'first', under(project), at(10));
  const second = await f.add(KindTask, 'second', under(project), at(20));
  await f.add(KindProject, 'zzz later project', at(5));

  requireTitles(
    t,
    'the default order is tree order: a container, then its children by position, with ties broken by id',
    await f.list(new Filter()),
    'project',
    'first',
    'second',
    'third',
    'zzz later project',
  );

  requireTitles(
    t,
    '`--sort created` is id order, which is creation order (PLAN.md §3.7)',
    await f.list(new Filter({ order: OrderCreated })),
    'project',
    'third',
    'first',
    'second',
    'zzz later project',
  );

  // Touching one task must move it to the end of an updated-order listing.
  const later = timeAt(f.now, hour);
  const stored = await f.get(first.id);
  stored.updatedAt = later;
  await f.update(stored);
  const updated = await f.list(new Filter({ order: OrderUpdated }));
  const last = updated[updated.length - 1];
  if (last === undefined || last.id !== first.id) {
    assert.fail(
      `\`--sort updated\` must put the most recently updated task last\n  the listing ends with ${JSON.stringify(last?.title ?? '')}, expected ${JSON.stringify(first.title)}`,
    );
  }

  // Due order: soonest first, and the ones with no date last, because a
  // listing by deadline is about the items that have one.
  const withDue = await f.get(second.id);
  withDue.dueAt = timeAt(f.now, 48 * hour);
  await f.update(withDue);
  const sooner = await f.get(third.id);
  sooner.dueAt = timeAt(f.now, 24 * hour);
  await f.update(sooner);

  const byDue = await f.list(new Filter({ order: OrderDue }));
  if (byDue[0]?.id !== third.id || byDue[1]?.id !== second.id) {
    assert.fail(
      `\`--sort due\` must put the soonest deadline first\n  the listing starts ${list(titles(byDue).slice(0, 2))}`,
    );
  }
  for (const item of byDue.slice(2)) {
    if (item.dueAt !== undefined) {
      assert.fail(
        `\`--sort due\` must put the items with no due date last\n  the listing is ${list(titles(byDue))}`,
      );
    }
  }

  // Position ties break by id, which is creation order.
  const tieA = await f.add(KindTask, 'tie a', under(project), at(99));
  const tieB = await f.add(KindTask, 'tie b', under(project), at(99));
  const listed = await f.list(
    new Filter({ scope: new Scope({ children: true, parentID: project.id }) }),
  );
  const order = ids(listed);
  if (order.indexOf(tieA.id) > order.indexOf(tieB.id)) {
    assert.fail(
      `two siblings with the same position must be ordered by id, which is creation order\n  ${JSON.stringify(tieA.title)} came after ${JSON.stringify(tieB.title)}`,
    );
  }
}

/**
 * Children, Subtree and Availability are reachable from the command layer
 * directly, but the rest of this suite only ever reaches them through List. A
 * provider could therefore ship any of the three broken and still pass, so
 * they are driven here on their own terms.
 */
export async function testDirectAccessors(
  t: TestContext,
  f: Fixture,
): Promise<void> {
  const future = timeAt(f.now, hour);

  const folder = await f.add(KindFolder, 'folder');
  // The project is sequential, so the accessors are exercised against the
  // transitive rule of PLAN.md §3.3 rather than the easy case.
  const project = await f.add(KindProject, 'project', under(folder), (x) => {
    x.sequential = true;
  });
  const first = await f.add(KindTask, 'first', under(project), at(1));
  const group = await f.add(KindTask, 'group', under(project), at(2));
  const inGroup = await f.add(KindTask, 'inside the group', under(group));
  const deferred = await f.add(
    KindTask,
    'deferred',
    under(project),
    at(3),
    (x) => {
      x.deferAt = future;
    },
  );
  const loose = await f.add(KindTask, 'loose');

  // Children is one level, not a subtree, and it is the direct children of
  // the id given — not of its parent, and not every root.
  let children: Task[] = [];
  try {
    children = await f.s.children(project.id);
  } catch (err) {
    requireNoError(
      t,
      'Children must list the direct children of a container',
      err,
    );
  }
  requireSet(
    t,
    "Children must return one level only: the group's own child does not belong to the project's children",
    children,
    'first',
    'group',
    'deferred',
  );

  const failures = new Failures();
  let childless: Task[] = [];
  try {
    childless = await f.s.children(first.id);
  } catch (err) {
    requireNoError(t, 'Children of a leaf is empty, not an error', err);
  }
  if (childless.length !== 0) {
    failures.add(
      `a leaf must have no children\n  got ${list(titles(childless))}`,
    );
  }

  let roots: Task[] = [];
  try {
    roots = await f.s.children('');
  } catch (err) {
    requireNoError(t, 'Children of the empty id must list the top level', err);
  }
  requireSet(
    t,
    'the top level is every item with no parent, which includes an inbox task',
    roots,
    'folder',
    'loose',
  );

  // Subtree includes the item itself, or a caller cannot tell an empty
  // container from a missing one.
  let sub: Task[] = [];
  try {
    sub = await f.s.subtree(project.id);
  } catch (err) {
    requireNoError(
      t,
      'Subtree must return the item and everything beneath it',
      err,
    );
  }
  requireSet(
    t,
    'Subtree is transitive and includes the item it was asked about',
    sub,
    'project',
    'first',
    'group',
    'inside the group',
    'deferred',
  );

  let leafSub: Task[] = [];
  try {
    leafSub = await f.s.subtree(loose.id);
  } catch (err) {
    requireNoError(t, 'Subtree of a leaf is the leaf', err);
  }
  requireSet(
    t,
    'Subtree of a childless item is that item alone',
    leafSub,
    'loose',
  );

  // Availability answers for exactly the ids asked about, and agrees with
  // what a listing filtered on availability would have said.
  const got = await f.availability(
    first.id,
    deferred.id,
    inGroup.id,
    folder.id,
  );
  if (got.size !== 4) {
    assert.fail(
      `Availability must answer for every id it was given and no others\n  asked for 4, got ${got.size}`,
    );
  }
  const expected: Array<{
    id: string;
    title: string;
    available: boolean;
    rule: Rule;
  }> = [
    { id: first.id, title: 'first', available: true, rule: '' },
    // Its own deferral is more specific than its place in the sequence.
    {
      id: deferred.id,
      title: 'deferred',
      available: false,
      rule: RuleDeferred,
    },
    // The group's turn has not come, so nothing inside it is available.
    {
      id: inGroup.id,
      title: 'inside the group',
      available: false,
      rule: RuleAncestorSequential,
    },
    {
      id: folder.id,
      title: 'folder',
      available: false,
      rule: RuleNotActionable,
    },
  ];
  for (const tc of expected) {
    const a = got.get(tc.id);
    if (a === undefined) {
      failures.add(`Availability did not answer for ${JSON.stringify(tc.title)}`);
      continue;
    }
    if (a.available !== tc.available) {
      failures.add(
        `${JSON.stringify(tc.title)}: available = ${a.available}, want ${tc.available} (rule ${JSON.stringify(a.rule)})`,
      );
    }
    if (!tc.available && a.rule !== tc.rule) {
      failures.add(
        `${JSON.stringify(tc.title)}: blocked by rule ${JSON.stringify(a.rule)}, want ${JSON.stringify(tc.rule)}`,
      );
    }
  }

  // Asking for nothing is not asking for everything: a caller that built an
  // empty id list must not get the whole store back.
  let none = new Map<string, Availability>();
  try {
    none = await f.s.availability(f.now);
  } catch (err) {
    requireNoError(t, 'Availability with no ids is not an error', err);
  }
  if (none.size !== 0) {
    failures.add(
      `Availability with no ids must answer for nothing\n  got ${none.size} answer(s)`,
    );
  }
  failures.check();
}
