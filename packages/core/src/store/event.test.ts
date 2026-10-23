// The event model on its own: statuses, the occurred_at invariant and the
// JSON shape. What an event does to the items that wait for it is the Tree's
// job and is tested in availability.test.ts.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ErrEmptyEventTitle,
  EventCancelled,
  EventOccurred,
  EventPending,
  EventStatuses,
  eventStatusValid,
  newEvent,
} from './event.ts';

const now = new Date(Date.UTC(2026, 9, 20, 4, 11, 0));
const later = new Date(Date.UTC(2026, 9, 21, 9, 0, 0));

test('a new event is pending and valid', () => {
  const e = newEvent('01J3EVENT', 'reply from the vendor', now);
  assert.equal(e.status, EventPending);
  assert.equal(e.occurredAt, undefined);
  assert.equal(e.validate(), undefined);
});

test('only the three statuses are valid', () => {
  assert.deepEqual(EventStatuses(), [EventPending, EventOccurred, EventCancelled]);
  assert.ok(eventStatusValid('occurred'));
  assert.ok(!eventStatusValid('done'), 'done is a task status, not an event one');
  assert.ok(!eventStatusValid('active'));
  assert.ok(!eventStatusValid(''));
});

test('a blank title or id is refused', () => {
  const e = newEvent('01J3EVENT', '   ', now);
  assert.equal(e.validate(), ErrEmptyEventTitle);
  const noID = newEvent('', 'x', now);
  assert.match(String(noID.validate()?.message), /id must not be empty/);
});

test('occurring stamps occurred_at, and reopening clears it', () => {
  const e = newEvent('01J3EVENT', 'a call', now);
  e.setStatus(EventOccurred, later);
  assert.equal(e.status, EventOccurred);
  assert.deepEqual(e.occurredAt, later);
  assert.deepEqual(e.updatedAt, later);
  assert.equal(e.validate(), undefined);

  e.setStatus(EventPending, now);
  assert.equal(e.occurredAt, undefined, 'a reopened event has not occurred');
  assert.equal(e.validate(), undefined);
});

test('setting the status it already has changes nothing', () => {
  const e = newEvent('01J3EVENT', 'a call', now);
  e.setStatus(EventOccurred, later);
  const stamped = e.occurredAt;
  e.setStatus(EventOccurred, new Date(later.getTime() + 60_000));
  assert.deepEqual(e.occurredAt, stamped, 'a repeated occur must not move occurred_at');
});

test('a cancelled event has no occurred_at', () => {
  const e = newEvent('01J3EVENT', 'a call', now);
  e.setStatus(EventOccurred, later);
  e.setStatus(EventCancelled, later);
  assert.equal(e.occurredAt, undefined);
  assert.equal(e.validate(), undefined);
});

test('occurred_at must agree with the status', () => {
  const e = newEvent('01J3EVENT', 'a call', now);
  e.status = EventOccurred;
  assert.match(String(e.validate()?.message), /must say when it occurred/);
  e.status = EventPending;
  e.occurredAt = later;
  assert.match(String(e.validate()?.message), /only an occurred event/);
});

test('an event may belong to a project, and says so in its JSON', () => {
  const e = newEvent('01J3EVENT', 'a call', now);
  assert.equal(e.projectID, '', 'an event belongs to no project to begin with');
  e.projectID = '01J3PROJECT';
  assert.equal(e.validate(), undefined);
  assert.equal(e.toJSON()['project_id'], '01J3PROJECT');
  assert.equal(e.clone().projectID, '01J3PROJECT', 'clone keeps the project');
  e.projectID = e.id;
  assert.match(String(e.validate()?.message), /its own project/);
});

test('clone is deep', () => {
  const e = newEvent('01J3EVENT', 'a call', now);
  e.expectedAt = later;
  const c = e.clone();
  c.title = 'changed';
  c.expectedAt?.setUTCFullYear(2030);
  assert.equal(e.title, 'a call');
  assert.equal(e.expectedAt?.getUTCFullYear(), 2026);
});

test('toJSON is the documented shape, keys sorted, absent values null', () => {
  const e = newEvent('01J3EVENT', 'a call', now);
  assert.deepEqual(e.toJSON(), {
    created_at: '2026-10-20T04:11:00Z',
    expected_at: null,
    id: '01J3EVENT',
    note: null,
    occurred_at: null,
    project_id: null,
    status: 'pending',
    title: 'a call',
    updated_at: '2026-10-20T04:11:00Z',
  });
  assert.deepEqual(Object.keys(e.toJSON()), Object.keys(e.toJSON()).slice().sort());
  e.note = 'n';
  e.expectedAt = later;
  e.setStatus(EventOccurred, later);
  const j = e.toJSON();
  assert.equal(j['note'], 'n');
  assert.equal(j['expected_at'], '2026-10-21T09:00:00Z');
  assert.equal(j['occurred_at'], '2026-10-21T09:00:00Z');
});
