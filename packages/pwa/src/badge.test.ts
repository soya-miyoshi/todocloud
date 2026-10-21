// `arrived` and `showBadge`: which tasks count, and what is drawn.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { arrived, showBadge } from './badge.ts';
import { Task, KindTask, KindProject, StatusActive, StatusDone } from '@todocloud/core/task';

const now = new Date('2026-10-22T09:00:00Z');

function task(over: Partial<Task>): Task {
  return Object.assign(new Task(), { kind: KindTask, status: StatusActive, title: 't' }, over);
}

test('counts a task due today, overdue, or deferred until today or earlier', () => {
  const tasks = [
    task({ dueAt: new Date('2026-10-22T18:00:00Z') }),
    task({ dueAt: new Date('2026-10-01T00:00:00Z') }),
    task({ deferAt: new Date('2026-10-22T00:00:00Z') }),
    task({ deferAt: new Date('2026-10-10T00:00:00Z') }),
  ];
  assert.equal(arrived(tasks, now), 4);
});

test('leaves out the future, the finished, the undated and projects', () => {
  const tasks = [
    task({ dueAt: new Date('2026-10-23T00:00:00Z') }),
    task({ deferAt: new Date('2026-10-30T00:00:00Z') }),
    task({ dueAt: new Date('2026-10-01T00:00:00Z'), status: StatusDone }),
    task({}),
    task({ kind: KindProject, dueAt: new Date('2026-10-01T00:00:00Z') }),
  ];
  assert.equal(arrived(tasks, now), 0);
});

test('showBadge sets a count, clears at zero, and swallows a refusal', async () => {
  const calls: string[] = [];
  const api = {
    setAppBadge: async (n: number) => void calls.push(`set ${n}`),
    clearAppBadge: async () => void calls.push('clear'),
  };
  await showBadge(api, 3);
  await showBadge(api, 0);
  assert.deepEqual(calls, ['set 3', 'clear']);
  await showBadge({ ...api, setAppBadge: async () => Promise.reject(new Error('no')) }, 1);
  await showBadge(undefined, 1);
});
