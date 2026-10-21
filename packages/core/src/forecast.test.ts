import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  type ForecastDay,
  ForecastHorizonDays,
  ForecastWeekDays,
  beyondHorizon,
  calendarDays,
  dueOn,
  forecast,
  forecastDay,
  forecastDays,
  forecastOn,
  forecastOrder,
  inForecast,
  landed,
  pastDue,
  startsOn,
} from './forecast.ts';
import {
  KindProject,
  KindTask,
  StatusDone,
  StatusDropped,
  StatusOnHold,
  newTask,
  parseTime,
  type Task,
} from './task.ts';

// Mid-morning, so that "due at midnight today" is already in the past and the
// calendar-day rule has something to say that an hourly one would get wrong.
const now = parseTime('2026-10-22T10:00:00Z');

function make(title: string, opts: { defer?: string; due?: string } = {}): Task {
  const t = newTask(`id-${title}`, KindTask, title, now);
  if (opts.defer !== undefined) {
    t.deferAt = parseTime(opts.defer);
  }
  if (opts.due !== undefined) {
    t.dueAt = parseTime(opts.due);
  }
  return t;
}

const titles = (ts: Task[]): string[] => ts.map((t) => t.title);

test('calendarDays counts calendar days in UTC, not elapsed hours', () => {
  assert.equal(calendarDays(parseTime('2026-10-22T00:00:00Z'), now), 0);
  assert.equal(calendarDays(parseTime('2026-10-22T23:59:00Z'), now), 0);
  assert.equal(calendarDays(parseTime('2026-10-21T23:59:00Z'), now), -1);
  assert.equal(calendarDays(parseTime('2026-10-23T00:00:00Z'), now), 1);
  assert.equal(calendarDays(parseTime('2026-11-01T00:00:00Z'), now), 10);
});

test('inForecast takes open tasks with either date, and nothing else', () => {
  assert.ok(inForecast(make('due only', { due: '2026-10-30T00:00:00Z' })));
  assert.ok(inForecast(make('defer only', { defer: '2026-11-01T00:00:00Z' })));
  assert.ok(inForecast(make('both', { defer: '2026-10-25T00:00:00Z', due: '2026-10-30T00:00:00Z' })));
  assert.ok(!inForecast(make('no dates')));

  const held = make('on hold', { due: '2026-10-30T00:00:00Z' });
  held.status = StatusOnHold;
  assert.ok(inForecast(held), 'on hold is still open');

  for (const status of [StatusDone, StatusDropped]) {
    const closed = make('closed', { due: '2026-10-30T00:00:00Z' });
    closed.status = status;
    assert.ok(!inForecast(closed), status);
  }

  const gone = make('tombstoned', { due: '2026-10-30T00:00:00Z' });
  gone.deletedAt = now;
  assert.ok(!inForecast(gone));

  // A project's own due date is a fact about the container, not work to do.
  const project = make('project', { due: '2026-10-30T00:00:00Z' });
  project.kind = KindProject;
  assert.ok(!inForecast(project));
});

test('landed is due today or earlier, and only for open tasks', () => {
  assert.ok(landed(make('earlier today', { due: '2026-10-22T00:00:00Z' }), now));
  assert.ok(landed(make('later today', { due: '2026-10-22T18:00:00Z' }), now));
  assert.ok(landed(make('yesterday', { due: '2026-10-21T00:00:00Z' }), now));
  assert.ok(!landed(make('tomorrow', { due: '2026-10-23T00:00:00Z' }), now));
  assert.ok(!landed(make('no due', { defer: '2026-10-01T00:00:00Z' }), now));

  const done = make('done', { due: '2026-10-21T00:00:00Z' });
  done.status = StatusDone;
  assert.ok(!landed(done, now));
});

test('beyondHorizon folds a defer date more than seven days out', () => {
  assert.equal(ForecastHorizonDays, 7);
  assert.ok(!beyondHorizon(make('day 7', { defer: '2026-10-29T00:00:00Z' }), now));
  assert.ok(beyondHorizon(make('day 8', { defer: '2026-10-30T00:00:00Z' }), now));
  // Only a defer date folds an item; a far-off deadline does not.
  assert.ok(!beyondHorizon(make('far due', { due: '2027-01-01T00:00:00Z' }), now));
});

test('defer order falls back to the due date, due order to the defer date', () => {
  const tasks = [
    make('c: defer 25th', { defer: '2026-10-25T00:00:00Z' }),
    make('a: due 20th, no defer', { due: '2026-10-20T00:00:00Z' }),
    make('b: defer 23rd, due 31st', { defer: '2026-10-23T00:00:00Z', due: '2026-10-31T00:00:00Z' }),
  ];
  assert.deepEqual(titles(forecast(tasks, 'defer', now).near), [
    'a: due 20th, no defer',
    'b: defer 23rd, due 31st',
    'c: defer 25th',
  ]);
  assert.deepEqual(titles(forecast(tasks, 'due', now).near), [
    'a: due 20th, no defer',
    'c: defer 25th',
    'b: defer 23rd, due 31st',
  ]);
});

test('ties break on the title, and the input is left alone', () => {
  const tasks = [
    make('banana', { due: '2026-10-25T00:00:00Z' }),
    make('apple', { due: '2026-10-25T00:00:00Z' }),
  ];
  const before = titles(tasks);
  assert.deepEqual(titles(forecast(tasks, 'due', now).near), ['apple', 'banana']);
  assert.deepEqual(titles(tasks), before);
});

test('the tail is split off in order, and count agrees with what it hides', () => {
  const tasks = [
    make('far', { defer: '2026-12-01T00:00:00Z' }),
    make('soon', { defer: '2026-10-24T00:00:00Z' }),
    make('farther', { defer: '2027-01-01T00:00:00Z' }),
    make('plain'),
  ];
  const { near, later } = forecast(tasks, 'defer', now);
  assert.deepEqual(titles(near), ['soon']);
  assert.deepEqual(titles(later), ['far', 'farther']);
});

test('forecastOrder accepts the two orders and nothing else', () => {
  assert.equal(forecastOrder('defer'), 'defer');
  assert.equal(forecastOrder('due'), 'due');
  assert.equal(forecastOrder('title'), undefined);
  assert.equal(forecastOrder(''), undefined);
});

// --- the week ------------------------------------------------------------

/** dayOf is `forecastDay`, with the undefined a test never wants taken off. */
function dayOf(key: string): ForecastDay {
  const day = forecastDay(key, now);
  assert.notEqual(day, undefined, `no such day: ${key}`);
  return day as ForecastDay;
}

test('pastDue is an earlier day, which is not the same as an hour overdue', () => {
  // Due at midnight today, read mid-morning: the deadline has passed, but the
  // item is today's work and not an earlier day's. This is the distinction
  // the Forecast colours by, and the reason it needs no Past bucket.
  assert.equal(pastDue(make('Today', { due: '2026-10-22T00:00:00Z' }), now), false);
  assert.equal(pastDue(make('Tonight', { due: '2026-10-22T23:00:00Z' }), now), false);
  assert.equal(pastDue(make('Yesterday', { due: '2026-10-21T23:59:00Z' }), now), true);
  // landed covers both, which is what a badge counts.
  assert.equal(landed(make('Today', { due: '2026-10-22T00:00:00Z' }), now), true);
});

test('the week is seven days from today, with stable keys and no Past cell', () => {
  const days = forecastDays(now);
  assert.equal(days.length, ForecastWeekDays);
  assert.deepEqual(days.map((d) => d.key), ['today', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6']);
  assert.deepEqual(days.map((d) => d.label), ['Today', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue', 'Wed']);
  assert.equal(days[0]?.today, true);
  assert.equal(days[0]?.date.toISOString(), '2026-10-22T00:00:00.000Z');
  assert.equal(days[6]?.date.toISOString(), '2026-10-28T00:00:00.000Z');
  assert.equal(forecastDay('d3', now)?.label, 'Sun');
  assert.equal(forecastDay('past', now), undefined);
});

test('today carries every deadline already due; no other day looks backwards', () => {
  const tasks = [
    make('Last week', { due: '2026-10-15T00:00:00Z' }),
    make('Today', { due: '2026-10-22T09:00:00Z' }),
    make('Tomorrow', { due: '2026-10-23T00:00:00Z' }),
  ];
  assert.deepEqual(titles(dueOn(tasks, dayOf('today'), now)), ['Last week', 'Today']);
  assert.deepEqual(titles(dueOn(tasks, dayOf('d1'), now)), ['Tomorrow']);
});

test('a defer date that has passed belongs to no day, today included', () => {
  // It is not news that something was released last week: it is available,
  // which is what the Next perspective is for.
  const tasks = [
    make('Released then', { defer: '2026-10-19T00:00:00Z' }),
    make('Released today', { defer: '2026-10-22T00:00:00Z' }),
  ];
  assert.deepEqual(titles(startsOn(tasks, dayOf('today'), now)), ['Released today']);
});

test('a day lists its deadlines and its releases once each, in order', () => {
  const tasks = [
    make('Due and released', { defer: '2026-10-23T00:00:00Z', due: '2026-10-23T00:00:00Z' }),
    make('Only released', { defer: '2026-10-23T00:00:00Z' }),
    make('Another day', { due: '2026-10-24T00:00:00Z' }),
  ];
  const got = forecastOn(tasks, dayOf('d1'), 'defer', now);
  // The deadline first, then what is merely released, and the task that is
  // both is one row rather than two.
  assert.deepEqual(titles(got), ['Due and released', 'Only released']);
});
