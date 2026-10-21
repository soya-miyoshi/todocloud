import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  type Fields,
  KindTask,
  KeyPriority,
  KeyStatus,
  newTask as newTaskOf,
  StatusActive,
  StatusOnHold,
  Task,
} from '../task.ts';
import { Tree } from './availability.ts';
import { Filter, filterFromJSON } from './filter.ts';
import {
  apply,
  Availability,
  AvailabilityAvailable,
  Condition,
  OrderDue,
  RuleAncestorStatus,
  RuleMissingParent,
  Scope,
} from './store.ts';

const now = new Date(Date.UTC(2026, 9, 20, 4, 11, 0));

function newTask(fields?: Fields): Task {
  const t = newTaskOf(
    '01J3ZQK8V9XW5S6R7T8Y9Z0A1B',
    KindTask,
    'Pay the invoice',
    now,
  );
  t.fields = fields ?? {};
  return t;
}

test('the zero Condition filters nothing', () => {
  assert.ok(
    new Condition().empty(),
    'the zero Condition reported itself as filtering',
  );
  for (const [name, c] of Object.entries({
    priority: new Condition({ minPriority: 1 }),
    match: new Condition({ match: { k: 'v' } }),
  })) {
    assert.ok(
      !c.empty(),
      `Condition with ${name} reported itself as empty`,
    );
  }
  assert.ok(
    new Condition().matches(newTask()),
    'the zero Condition rejected a task',
  );
});

test('a Condition reads the user-defined fields', () => {
  const tests: Array<{
    name: string;
    cond: Condition;
    task: Task;
    match: boolean;
  }> = [
    {
      name: 'priority at the floor matches',
      cond: new Condition({ minPriority: 2 }),
      task: newTask({ [KeyPriority]: 2 }),
      match: true,
    },
    {
      name: 'priority below the floor does not',
      cond: new Condition({ minPriority: 3 }),
      task: newTask({ [KeyPriority]: 2 }),
      match: false,
    },
    {
      name: 'an unset priority is zero and fails any floor',
      cond: new Condition({ minPriority: 1 }),
      task: newTask(),
      match: false,
    },
    {
      name: 'a string field matches as written',
      cond: new Condition({ match: { owner: 'sam' } }),
      task: newTask({ owner: 'sam' }),
      match: true,
    },
    {
      name: 'a numeric field matches a number, not its spelling',
      cond: new Condition({ match: { estimate: '3' } }),
      task: newTask({ estimate: 3 }),
      match: true,
    },
    {
      name: 'a boolean field matches a boolean',
      cond: new Condition({ match: { blocked: 'true' } }),
      task: newTask({ blocked: true }),
      match: true,
    },
    {
      name: 'a required field is matchable by name too',
      cond: new Condition({ match: { [KeyStatus]: 'active' } }),
      task: newTask(),
      match: true,
    },
    {
      name: 'a field that is not there matches nothing',
      cond: new Condition({ match: { missing: 'x' } }),
      task: newTask(),
      match: false,
    },
  ];
  for (const tc of tests) {
    assert.equal(tc.cond.matches(tc.task), tc.match, tc.name);
  }
});

test('apply stops at the limit', () => {
  const tasks = [newTask(), newTask(), newTask()];
  assert.equal(
    apply(tasks, new Condition(), 2).length,
    2,
    'apply() must stop at the limit',
  );
  assert.equal(
    apply(tasks, new Condition(), 0).length,
    3,
    'a limit of zero means no limit',
  );
  assert.equal(
    apply(tasks, new Condition({ minPriority: 1 }), 0).length,
    0,
    'apply() kept tasks a condition rejects',
  );
});

// The availability truth table is exercised end to end by the conformance
// suite; what is checked here is the shape the --json caller sees and the
// cases the tree answers without a store at all.
test('Availability is serialised as true or a reason', () => {
  assert.equal(
    JSON.stringify(new Availability({ available: true })),
    'true',
    'an available item must be written as a bare true',
  );

  const encoded = JSON.stringify(
    new Availability({ rule: RuleAncestorStatus, blockedBy: '01J3' }),
  );
  const got = JSON.parse(encoded) as Record<string, unknown>;
  assert.deepEqual(
    got,
    { available: false, rule: 'ancestor_status', task_id: '01J3' },
    `blocked_by must name the rule and the item responsible, got ${encoded}`,
  );
});

test('a tree with a broken edge does not loop or lie', () => {
  // A parent that is not in the tree: a database edited by hand, or a
  // half-finished sync. The item must not be reported as available.
  const orphan = newTaskOf(
    '01J3ORPHAN0000000000000000',
    KindTask,
    'orphan',
    now,
  );
  orphan.parentID = '01J3MISSING000000000000000';
  let tr = new Tree([orphan]);
  const a = tr.availability(orphan.id, now);
  assert.ok(
    !a.available && a.rule === RuleMissingParent,
    `an item whose parent is missing must be blocked by ${RuleMissingParent}, got ${JSON.stringify(a)}`,
  );

  // Two items that are each other's parent. Nothing in this module can create
  // that, but the walk must terminate if it is ever read.
  const a1 = newTaskOf('01J3A00000000000000000000A', KindTask, 'a', now);
  const b1 = newTaskOf('01J3A00000000000000000000B', KindTask, 'b', now);
  a1.parentID = b1.id;
  b1.parentID = a1.id;
  tr = new Tree([a1, b1]);
  assert.ok(
    tr.ancestors(a1.id).length <= 2,
    'ancestors must stop rather than loop on a cycle',
  );
  tr.availability(a1.id, now);
  tr.subtree(a1.id);
});

test('an unknown id is absent from an availability answer', () => {
  const tr = new Tree(null);
  assert.equal(
    tr.availabilityOf(now, '01J3NOTHING000000000000000').size,
    0,
    'an unknown id must be absent from the result rather than invented',
  );
});

test('a filter refuses values a provider could not honour', () => {
  for (const [name, f] of Object.entries({
    kind: new Filter({ kinds: ['wish'] }),
    status: new Filter({ statuses: ['maybe'] }),
    availability: new Filter({ availability: 'someday' }),
    order: new Filter({ order: 'alphabetical' }),
    limit: new Filter({ limit: -1 }),
  })) {
    assert.notEqual(
      f.validate(),
      undefined,
      `a filter with an invalid ${name} must be refused, so that a bad perspective fails where it is read`,
    );
  }
  assert.equal(
    new Filter().validate(),
    undefined,
    'the zero filter is valid and matches everything live',
  );
});

test('a filter round-trips through JSON so a perspective can hold it', () => {
  const cut = now;
  const want = new Filter({
    kinds: [KindTask],
    statuses: [StatusActive, StatusOnHold],
    availability: AvailabilityAvailable,
    flagged: true,
    scope: new Scope({ subtree: '01J3' }),
    tags: ['home'],
    dueBefore: cut,
    order: OrderDue,
    limit: 5,
  });
  const got = filterFromJSON(JSON.stringify(want));
  assert.ok(
    got.order === want.order &&
      got.availability === want.availability &&
      got.scope.subtree === want.scope.subtree &&
      got.limit === want.limit &&
      got.flagged === true &&
      got.dueBefore !== undefined &&
      got.dueBefore.getTime() === cut.getTime(),
    'a perspective is a stored filter, so a filter must read back as itself',
  );
});
