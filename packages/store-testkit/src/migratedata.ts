// The rows the harness migrates. They are written with raw SQL, because a
// store at an old version does not necessarily have the columns today's
// provider writes, and they are read back through the Store API, because what
// matters is not that the bytes survived but that the tool still understands
// them.
//
// They are deliberately not a minimal row: a tree with a real parent edge, a
// tombstone, a tag whose spelling differs from its key, a user-defined field,
// and a saved perspective. Those are the things a migration that rebuilds a
// table silently drops.

import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';

import {
  Fields as FieldsOf,
  Filter,
  KindTask,
  type Perspective,
  type Store,
  StatusOnHold,
  type Tag,
  type Task,
} from '@todocloud/core';

import type { VersionData } from './migrate.ts';
import { Failures, ids, list, reason } from './storetest.ts';

// Ids are fixed so a failure names the same row every time. They are
// well-formed ULIDs and obviously synthetic.
const migrateProjectID = '01J9A00000000000000000000P';
const migrateTaskID = '01J9A00000000000000000000T';
const migrateGoneID = '01J9A00000000000000000000X';

const v1Rows: string[] = [
  `INSERT INTO tasks (id, kind, title, parent_id, position, status, flagged, sequential,
	  completed_by_children, defer_at, due_at, estimated_minutes, note, repeat, series_id,
	  review_interval, last_reviewed_at, created_at, updated_at, completed_at, dropped_at,
	  deleted_at, fields)
	 VALUES ('${migrateProjectID}', 'project', 'Move house', NULL, 1, 'active', 0, 1,
	  0, NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL,
	  '2026-01-02T03:04:05Z', '2026-01-02T03:04:05Z', NULL, NULL, NULL, '{}')`,

  `INSERT INTO tasks (id, kind, title, parent_id, position, status, flagged, sequential,
	  completed_by_children, defer_at, due_at, estimated_minutes, note, repeat, series_id,
	  review_interval, last_reviewed_at, created_at, updated_at, completed_at, dropped_at,
	  deleted_at, fields)
	 VALUES ('${migrateTaskID}', 'task', 'Book the van', '${migrateProjectID}', 2, 'on_hold', 1, 0,
	  0, '2026-02-01T00:00:00Z', '2026-03-01T00:00:00Z', 45, 'ring them in the morning', NULL, NULL, NULL, NULL,
	  '2026-01-02T03:04:06Z', '2026-01-02T03:04:07Z', NULL, NULL, NULL, '{"priority":2,"ref":"3.0.1"}')`,

  // A tombstone, because `tdo rm` is the common case and a migration that
  // loses deleted_at resurrects everything the user removed.
  `INSERT INTO tasks (id, kind, title, parent_id, position, status, flagged, sequential,
	  completed_by_children, defer_at, due_at, estimated_minutes, note, repeat, series_id,
	  review_interval, last_reviewed_at, created_at, updated_at, completed_at, dropped_at,
	  deleted_at, fields)
	 VALUES ('${migrateGoneID}', 'task', 'Cancel the skip', '${migrateProjectID}', 3, 'active', 0, 0,
	  0, NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL,
	  '2026-01-02T03:04:08Z', '2026-01-02T03:04:09Z', NULL, NULL, '2026-01-03T00:00:00Z', '{}')`,

  // tag keeps the spelling the user typed; tag_key is what is matched on.
  `INSERT INTO task_tags (task_id, tag, tag_key) VALUES ('${migrateTaskID}', 'Errands', 'errands')`,

  `INSERT INTO perspectives (name_key, name, filter, created_at, updated_at)
	 VALUES ('weekend', 'Weekend', '{"kinds":["task"],"flagged":true}',
	  '2026-01-02T03:04:05Z', '2026-01-02T03:04:05Z')`,
];

async function verifyV1(_t: TestContext, s: Store): Promise<void> {
  const failures = new Failures();

  let got: Task;
  try {
    got = await s.get(migrateTaskID);
  } catch (err) {
    assert.fail(
      `a task that existed before the migration must still be readable afterwards, but Get failed: ${reason(err)}`,
    );
  }
  // Go's switch reported the first of these only; the whole list is more use
  // to someone reading one failure.
  if (got.title !== 'Book the van') {
    failures.add(
      `the migrated task's title is ${JSON.stringify(got.title)}, it was "Book the van"`,
    );
  }
  if (got.parentID !== migrateProjectID) {
    failures.add(
      `the migrated task's parent is ${JSON.stringify(got.parentID)}, it was the project ${JSON.stringify(migrateProjectID)}; a migration that drops the tree leaves every item in the inbox`,
    );
  }
  if (got.status !== StatusOnHold) {
    failures.add(
      `the migrated task's status is ${JSON.stringify(got.status)}, it was on_hold; a status that changes meaning changes what \`tdo ls\` shows`,
    );
  }
  if (!got.flagged) {
    failures.add('the migrated task was flagged and is not any more');
  }
  if (got.estimatedMinutes !== 45) {
    failures.add(
      `the migrated task's estimate is ${got.estimatedMinutes} minutes, it was 45`,
    );
  }
  if (got.deferAt === undefined || got.dueAt === undefined) {
    failures.add(
      'the migrated task had both a defer and a due date and has lost one of them',
    );
  }
  const ref = FieldsOf.string(got.fields, 'ref');
  if (ref !== '3.0.1') {
    failures.add(
      `a user-defined field must survive a migration untouched; ref came back ${JSON.stringify(ref ?? null)}`,
    );
  }
  const prio = FieldsOf.int(got.fields, 'priority');
  if (prio !== 2) {
    failures.add(
      `a user-defined number must survive a migration as a number; priority came back ${JSON.stringify(prio ?? null)}`,
    );
  }

  let gone: Task;
  try {
    gone = await s.get(migrateGoneID);
  } catch (err) {
    assert.fail(
      `a tombstoned task must survive a migration, since it is how \`tdo rm\` is undone, but Get failed: ${reason(err)}`,
    );
  }
  if (gone.deletedAt === undefined) {
    failures.add(
      'a tombstoned task came back without its tombstone; a migration that loses deleted_at resurrects everything the user removed',
    );
  }

  let tags: Tag[];
  try {
    tags = await s.tags();
  } catch (err) {
    assert.fail(`Tags must work after a migration, but it failed: ${reason(err)}`);
  }
  if (tags.length !== 1 || tags[0]?.name !== 'Errands' || tags[0]?.count !== 1) {
    failures.add(
      `the tag rows must survive with the spelling the user typed; tags() = ${list(tags.map((x) => `${x.name}=${x.count}`))}`,
    );
  }
  let found: Task[];
  try {
    found = await s.list(new Filter({ tags: ['ERRANDS'] }));
  } catch (err) {
    assert.fail(`listing by tag after a migration failed: ${reason(err)}`);
  }
  if (found.length !== 1 || found[0]?.id !== migrateTaskID) {
    failures.add(
      `a tag must still match case-insensitively after a migration; listing by ERRANDS returned ${found.length} item(s)`,
    );
  }

  let p: Perspective;
  try {
    p = await s.perspective('weekend');
  } catch (err) {
    assert.fail(
      `a saved perspective must survive a migration, but reading it failed: ${reason(err)}`,
    );
  }
  if (
    p.name !== 'Weekend' ||
    p.filter.kinds.length !== 1 ||
    p.filter.kinds[0] !== KindTask
  ) {
    failures.add(
      `the saved perspective came back as ${JSON.stringify({ name: p.name, filter: p.filter.toJSON() })}; its name and its filter are both part of it`,
    );
  }
  if (p.filter.flagged !== true) {
    failures.add(
      "the saved perspective's flagged condition did not survive the migration",
    );
  }

  let children: Task[];
  try {
    children = await s.children(migrateProjectID);
  } catch (err) {
    assert.fail(
      `Children must work after a migration, but it failed: ${reason(err)}`,
    );
  }
  if (children.length !== 2) {
    failures.add(
      `the project had two children including the tombstoned one, and has ${children.length} after the migration: ${list(ids(children))}`,
    );
  }

  // An id is base32 and case-insensitive, and the migrated rows must stay
  // reachable through the same normalization every other call uses.
  try {
    await s.get(migrateTaskID.toLowerCase());
  } catch (err) {
    failures.add(
      `a migrated row must still be reachable by a lower-cased id, but Get failed: ${reason(err)}`,
    );
  }

  failures.check();
}

/**
 * DefaultData is the representative data for each released version. A version
 * absent from the map is migrated empty, which still checks the schema but
 * proves nothing about the rows.
 */
export const DefaultData: Map<number, VersionData> = new Map([
  [1, { insert: v1Rows, verify: verifyV1 }],
]);
