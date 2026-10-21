// The bytes of the one task shape. internal/output had no view_test.go — the
// shape was pinned from the command layer — but `TaskView` is the documented
// contract in docs/agents.md, and a change to these strings is a breaking
// change, so the bytes are pinned here, beside the code that writes them.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Availability,
  RuleAncestorStatus,
  RuleTagStatus,
  available,
  blocked,
  blockedByTag,
} from '../store/store.ts';
import { KeyPriority, KindTask, StatusActive, Task } from '../task.ts';
import { NewTaskView, Views } from './view.ts';

function sampleTask(): Task {
  const now = new Date('2026-10-20T04:11:00Z');
  const t = new Task();
  t.id = '01J3ZQK8V9XW5S6R7T8Y9Z0A1B';
  t.kind = KindTask;
  t.title = 'Pay the invoice';
  t.status = StatusActive;
  t.dueAt = new Date('2026-11-01T00:00:00Z');
  t.createdAt = now;
  t.updatedAt = now;
  t.fields = { [KeyPriority]: 2, client: 'acme' };
  t.setTags(['finance', 'ops']);
  return t;
}

// Every key, in the order Go's encoding/json wrote them: a map's keys sorted
// by byte value, with the user-defined `client` flattened in among them.
const sampleJSON =
  '{"available":true,"blocked_by":null,"client":"acme","completed_at":null,' +
  '"completed_by_children":false,"created_at":"2026-10-20T04:11:00Z","defer_at":null,' +
  '"deleted_at":null,"done":false,"dropped_at":null,"due_at":"2026-11-01T00:00:00Z","estimated_minutes":0,' +
  '"flagged":false,"id":"01J3ZQK8V9XW5S6R7T8Y9Z0A1B","kind":"task","last_reviewed_at":null,' +
  '"next_review_at":null,"note":null,"parent_id":null,"position":0,"priority":2,' +
  '"repeat":null,"review_interval":null,"sequential":false,"series_id":null,' +
  '"status":"active","tags":["finance","ops"],"title":"Pay the invoice",' +
  '"updated_at":"2026-10-20T04:11:00Z"}';

test('an available task carries available true and blocked_by null', () => {
  const view = NewTaskView(sampleTask(), available(), true);
  assert.equal(JSON.stringify(view), sampleJSON);
});

test('the derived keys sort in among the stored ones, not after them', () => {
  const keys = Object.keys(NewTaskView(sampleTask(), available(), true).toJSON());
  assert.deepEqual(keys, [...keys].sort());
  // Not at the end: available leads and next_review_at sits between
  // last_reviewed_at and note.
  assert.equal(keys[0], 'available');
  assert.equal(keys[1], 'blocked_by');
  assert.equal(keys[keys.indexOf('next_review_at') - 1], 'last_reviewed_at');
  assert.equal(keys[keys.indexOf('next_review_at') + 1], 'note');
});

test('a blocked task names the rule and the item responsible', () => {
  const view = NewTaskView(
    sampleTask(),
    blocked(RuleAncestorStatus, '01J3ZQK8V9XW5S6R7T8Y9Z0A1A'),
    true,
  );
  const out = JSON.stringify(view);
  assert.ok(
    out.includes(
      '"available":false,"blocked_by":{"rule":"ancestor_status","task_id":"01J3ZQK8V9XW5S6R7T8Y9Z0A1A"}',
    ),
    out,
  );
  // `tag` is absent, not null, for every rule but the two that name one.
  assert.ok(!out.includes('"tag"'), out);
});

test('the two tag rules carry the tag as well', () => {
  const view = NewTaskView(
    sampleTask(),
    blockedByTag(RuleTagStatus, '01J3ZQK8V9XW5S6R7T8Y9Z0A1B', 'errand'),
    true,
  );
  assert.ok(
    JSON.stringify(view).includes(
      '"available":false,"blocked_by":{"rule":"tag_status","task_id":"01J3ZQK8V9XW5S6R7T8Y9Z0A1B","tag":"errand"}',
    ),
    JSON.stringify(view),
  );
});

test('availability that was not computed is null, not blocked', () => {
  const view = NewTaskView(sampleTask(), new Availability(), false);
  const out = JSON.stringify(view);
  assert.ok(out.includes('"available":null,"blocked_by":null'), out);
  // Which is the available case's bytes with the two values replaced: nothing
  // else about the shape changes.
  assert.equal(out, sampleJSON.replace('"available":true', '"available":null'));
});

test('next_review_at is derived from the interval and the last review', () => {
  const t = sampleTask();
  t.reviewInterval = { every: '1w' };
  t.lastReviewedAt = new Date('2026-10-13T04:11:00Z');
  const out = JSON.stringify(NewTaskView(t, available(), true));
  assert.ok(out.includes('"next_review_at":"2026-10-20T04:11:00Z"'), out);

  // An item with an interval that has never been reviewed is due now, and
  // "now" for a rendering is the task's own updated_at.
  const never = sampleTask();
  never.reviewInterval = { every: '1w' };
  assert.ok(
    JSON.stringify(NewTaskView(never, available(), true)).includes(
      '"next_review_at":"2026-10-20T04:11:00Z"',
    ),
  );
});

test('Views asks for each task only where the map has an answer', () => {
  const first = sampleTask();
  const second = sampleTask();
  second.id = '01J3ZQK8V9XW5S6R7T8Y9Z0A1C';

  const views = Views(
    [first, second],
    new Map([[first.id, blocked(RuleAncestorStatus, '01J3ZQK8V9XW5S6R7T8Y9Z0A1A')]]),
  );
  assert.equal(views.length, 2);
  assert.ok(JSON.stringify(views[0]).includes('"available":false'));
  // No entry for the second: null rather than a claim that it is blocked.
  assert.ok(JSON.stringify(views[1]).includes('"available":null,"blocked_by":null'));
});
