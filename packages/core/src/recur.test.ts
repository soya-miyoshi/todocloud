import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Every,
  ErrNoRepeat,
  complete,
  ensureSeries,
  isNoRepeat,
  markReviewed,
  nextReviewAt,
  parseEvery,
  successor,
} from './recur.ts';
import {
  type RepeatMethod,
  type Task,
  KindProject,
  KindTask,
  RepeatDeferAnother,
  RepeatFixed,
  RepeatFromCompletion,
  StatusActive,
  StatusDone,
  formatTime,
  newTask,
  parseTime,
} from './task.ts';

/** The Go test's `at`: an RFC 3339 literal, as an instant. */
function at(s: string): Date {
  return parseTime(s);
}

test('parseEvery reads the spellings PLAN.md documents', () => {
  for (const input of ['3d', '2w', '1mo', '1y', '1mo:last-friday', '2y:first-monday']) {
    const e = parseEvery(input);
    assert.equal(
      e.toString(),
      input,
      `an interval must render back as it was written: ${input} became ${e.toString()}`,
    );
  }
});

test('parseEvery refuses what it cannot mean', () => {
  for (const input of [
    '',
    'd',
    '0w',
    '-1d',
    '1',
    '1week',
    '1w:last-friday',
    '1mo:last-caturday',
    '1mo:friday',
  ]) {
    assert.throws(
      () => parseEvery(input),
      `parseEvery(${JSON.stringify(input)}) must fail: an interval that cannot ` +
        `be meant must be reported, not guessed at`,
    );
  }
});

test('interval arithmetic clamps rather than overflowing', () => {
  const tests: Array<{ every: string; from: string; want: string }> = [
    { every: '3d', from: '2026-01-01T09:00:00Z', want: '2026-01-04T09:00:00Z' },
    { every: '2w', from: '2026-01-01T09:00:00Z', want: '2026-01-15T09:00:00Z' },
    { every: '1mo', from: '2026-01-15T09:00:00Z', want: '2026-02-15T09:00:00Z' },
    // One month after 31 January is the end of February, not 3 March: a
    // monthly chore set on the 31st must not drift into the next month.
    { every: '1mo', from: '2026-01-31T09:00:00Z', want: '2026-02-28T09:00:00Z' },
    { every: '1y', from: '2024-02-29T09:00:00Z', want: '2025-02-28T09:00:00Z' },
    {
      every: '1mo:last-friday',
      from: '2026-01-05T09:00:00Z',
      want: '2026-02-27T09:00:00Z',
    },
    {
      every: '1mo:first-monday',
      from: '2026-01-05T09:00:00Z',
      want: '2026-02-02T09:00:00Z',
    },
    // A fifth weekday the month does not have falls back to the last one.
    {
      every: '1mo:fifth-monday',
      from: '2026-01-05T09:00:00Z',
      want: '2026-02-23T09:00:00Z',
    },
  ];
  for (const tc of tests) {
    const e = parseEvery(tc.every);
    assert.equal(
      formatTime(e.next(at(tc.from))),
      tc.want,
      `${tc.every} after ${tc.from}`,
    );
  }
});

/**
 * The clamp above is the one place the port could silently disagree with Go,
 * so the normalising behaviour it exists to defeat is pinned as well: 31
 * January plus a month is 3 March both in Go's AddDate and in JavaScript's
 * setUTCMonth, and February has to be read for the clamp to be right.
 */
test('the clamp is what stops a month-end date from overflowing', () => {
  const normalised = new Date(Date.UTC(2026, 0, 31, 9));
  normalised.setUTCMonth(normalised.getUTCMonth() + 1);
  assert.equal(
    formatTime(normalised),
    '2026-03-03T09:00:00Z',
    'the raw setter normalises, which is the behaviour addMonths replaces',
  );

  const clamped: Array<[string, string, string]> = [
    // Every month end that exists, from a 31st, for a whole year.
    ['1mo', '2026-01-31T00:00:00Z', '2026-02-28T00:00:00Z'],
    ['1mo', '2024-01-31T00:00:00Z', '2024-02-29T00:00:00Z'],
    ['1mo', '2026-03-31T00:00:00Z', '2026-04-30T00:00:00Z'],
    ['1mo', '2026-05-31T00:00:00Z', '2026-06-30T00:00:00Z'],
    ['1mo', '2026-08-31T00:00:00Z', '2026-09-30T00:00:00Z'],
    ['1mo', '2026-10-31T00:00:00Z', '2026-11-30T00:00:00Z'],
    // A day that exists in both months is untouched, and so is the year roll.
    ['1mo', '2026-12-31T23:59:59Z', '2027-01-31T23:59:59Z'],
    ['2mo', '2026-12-31T00:00:00Z', '2027-02-28T00:00:00Z'],
    ['13mo', '2024-01-31T00:00:00Z', '2025-02-28T00:00:00Z'],
    ['1y', '2026-02-28T00:00:00Z', '2027-02-28T00:00:00Z'],
    ['4y', '2024-02-29T00:00:00Z', '2028-02-29T00:00:00Z'],
    // Day and week arithmetic crosses a month, a year and a leap day without
    // a clamp, because adding days cannot land on a date that does not exist.
    ['1d', '2024-02-28T09:00:00Z', '2024-02-29T09:00:00Z'],
    ['1d', '2026-12-31T09:00:00Z', '2027-01-01T09:00:00Z'],
    ['2w', '2026-12-25T09:00:00Z', '2027-01-08T09:00:00Z'],
  ];
  for (const [every, from, want] of clamped) {
    assert.equal(formatTime(parseEvery(every).next(at(from))), want, `${every} after ${from}`);
  }
});

/**
 * The arithmetic is UTC throughout, so it must not move with the machine's
 * zone. `TZ` is read when the process starts, so this checks the property the
 * zone could break — that only the UTC accessors are consulted — by asserting
 * a time of day that a local-time implementation would shift.
 */
test('the arithmetic stays in UTC and keeps the time of day', () => {
  const e = parseEvery('1mo');
  const from = at('2026-03-29T01:30:00Z'); // inside Europe's DST transition.
  assert.equal(formatTime(e.next(from)), '2026-04-29T01:30:00Z');
  assert.equal(
    formatTime(parseEvery('1d').next(at('2026-03-28T23:30:00Z'))),
    '2026-03-29T23:30:00Z',
  );
  // Sub-second precision is preserved rather than truncated by the trip
  // through the calendar parts.
  const withMs = new Date(at('2026-01-31T09:00:00Z').getTime() + 123);
  assert.equal(parseEvery('1mo').next(withMs).getUTCMilliseconds(), 123);
});

/** A snap is resolved inside the month the interval landed in. */
test('a snapped interval names a weekday of the month it lands in', () => {
  const cases: Array<[string, string, string]> = [
    // March 2026 has five Mondays (2, 9, 16, 23, 30).
    ['2mo:fifth-monday', '2026-01-05T09:00:00Z', '2026-03-30T09:00:00Z'],
    ['2mo:last-monday', '2026-01-05T09:00:00Z', '2026-03-30T09:00:00Z'],
    ['2mo:first-sunday', '2026-01-05T09:00:00Z', '2026-03-01T09:00:00Z'],
    ['1mo:second-wednesday', '2026-01-05T09:00:00Z', '2026-02-11T09:00:00Z'],
    ['1mo:third-saturday', '2026-01-05T09:00:00Z', '2026-02-21T09:00:00Z'],
    ['1mo:fourth-thursday', '2026-01-05T09:00:00Z', '2026-02-26T09:00:00Z'],
    // A snap in February 2026 (28 days, starting on a Sunday) exercises the
    // fifth-falls-back-to-last path in the shortest month there is.
    ['1mo:fifth-sunday', '2026-01-05T09:00:00Z', '2026-02-22T09:00:00Z'],
    ['1mo:last-saturday', '2026-01-05T09:00:00Z', '2026-02-28T09:00:00Z'],
    // A year snap resolves in the month the year arithmetic landed in.
    ['1y:first-tuesday', '2026-01-05T09:00:00Z', '2027-01-05T09:00:00Z'],
  ];
  for (const [every, from, want] of cases) {
    assert.equal(formatTime(parseEvery(every).next(at(from))), want, `${every} after ${from}`);
  }
});

test('an interval built by hand renders and advances like a parsed one', () => {
  const e = new Every(1, 'mo');
  assert.equal(e.snapped(), false);
  assert.equal(e.toString(), '1mo');
  const snapped = parseEvery('1mo:last-friday');
  assert.equal(snapped.snapped(), true);
  assert.equal(snapped.ordinal, -1);
  assert.equal(snapped.weekday, 5);
  // Spelling is normalised to lower case on the way in, so a shouted
  // interval round-trips to the canonical spelling.
  assert.equal(parseEvery('  1MO:LAST-FRIDAY ').toString(), '1mo:last-friday');
});

function repeating(method: RepeatMethod, every: string): Task {
  const t = newTask(
    '01J3ZQK8V9XW5S6R7T8Y9Z0A1B',
    KindTask,
    'water the plants',
    at('2026-01-01T09:00:00Z'),
  );
  t.repeat = { method, every };
  return t;
}

// The three methods differ only in what the next instance's dates are
// computed from, which is the whole of PLAN.md §3.4.
test('the three methods differ only in what the dates come from', () => {
  const completed = at('2026-01-10T18:00:00Z');

  const fixed = repeating(RepeatFixed, '3d');
  fixed.deferAt = at('2026-01-01T09:00:00Z');
  fixed.dueAt = at('2026-01-02T09:00:00Z');
  let next = successor(fixed, completed, '01J3SUCCESSOR00000000000A');
  assert.equal(
    formatTime(next.deferAt!) + ' ' + formatTime(next.dueAt!),
    '2026-01-04T09:00:00Z 2026-01-05T09:00:00Z',
    "fixed advances from the previous instance's own dates, so a late completion falls behind",
  );

  const fromCompletion = repeating(RepeatFromCompletion, '3d');
  fromCompletion.deferAt = at('2026-01-01T09:00:00Z');
  fromCompletion.dueAt = at('2026-01-02T09:00:00Z');
  next = successor(fromCompletion, completed, '01J3SUCCESSOR00000000000B');
  assert.equal(
    formatTime(next.dueAt!),
    '2026-01-13T18:00:00Z',
    'from_completion advances the deadline from the moment of completion',
  );
  assert.equal(
    formatTime(next.deferAt!),
    '2026-01-12T18:00:00Z',
    'from_completion keeps the gap the user left between deferring and the deadline',
  );

  const deferAnother = repeating(RepeatDeferAnother, '3d');
  deferAnother.deferAt = at('2026-01-01T09:00:00Z');
  deferAnother.dueAt = at('2026-01-02T09:00:00Z');
  next = successor(deferAnother, completed, '01J3SUCCESSOR00000000000C');
  assert.equal(
    formatTime(next.deferAt!),
    '2026-01-13T18:00:00Z',
    'defer_another moves the defer date from completion',
  );
  assert.equal(
    formatTime(next.dueAt!),
    '2026-01-02T09:00:00Z',
    'defer_another leaves the deadline where it was: a real date does not move because the work was touched',
  );
});

test('a successor is a fresh instance of the same series', () => {
  const original = repeating(RepeatFromCompletion, '1w');
  original.setTags(['home']);
  original.fields = { owner: 'sam' };
  original.flagged = true;
  original.parentID = '01J3PARENT0000000000000000';
  original.position = 4;

  const completed = at('2026-01-10T18:00:00Z');
  const next = complete(original, completed, '01J3SUCCESSOR00000000000A');
  assert.ok(next !== undefined, 'a repeating task has a successor');

  assert.equal(original.status, StatusDone, 'complete must close the instance it was given');
  assert.notEqual(original.completedAt, undefined);
  assert.equal(
    original.seriesID,
    original.id,
    'the first instance names the series, so series_id must be minted from its own id',
  );
  assert.equal(next.seriesID, original.seriesID, 'the successor must carry the same series_id');
  assert.notEqual(next.id, original.id, 'the successor is a new row with a fresh id');
  assert.equal(next.status, StatusActive, 'the successor starts active');
  assert.equal(next.completedAt, undefined, 'the successor is uncompleted');
  assert.equal(next.parentID, original.parentID);
  assert.equal(next.position, original.position);
  assert.equal(next.flagged, true);
  assert.equal(next.hasTag('home'), true);
  assert.equal(next.fields['owner'], 'sam');
  assert.equal(
    formatTime(next.createdAt),
    formatTime(completed),
    'the successor is created at the moment the previous one was completed',
  );
});

test('completing a task that does not repeat makes nothing', () => {
  const plain = newTask('01J3', KindTask, 'once', at('2026-01-01T09:00:00Z'));
  const next = complete(plain, at('2026-01-02T09:00:00Z'), '01J3NEW');
  assert.equal(
    next,
    undefined,
    'a task that does not repeat has no successor; nothing may be manufactured',
  );
  assert.equal(plain.done(), true, 'the task must still be completed');

  let caught: unknown;
  assert.throws(() => {
    try {
      successor(plain, at('2026-01-02T09:00:00Z'), '01J3NEW');
    } catch (err) {
      caught = err;
      throw err;
    }
  });
  assert.equal(
    isNoRepeat(caught),
    true,
    'successor on a task that does not repeat must report ErrNoRepeat',
  );
  assert.equal(
    isNoRepeat(ErrNoRepeat),
    true,
    'the sentinel is itself, the way errors.Is(err, err) holds',
  );
  assert.equal(isNoRepeat(new Error('something else')), false);
  assert.equal(isNoRepeat(undefined), false);
});

test('a repeat with no dates simply comes back', () => {
  const checklist = repeating(RepeatFromCompletion, '1d');
  const next = successor(checklist, at('2026-01-10T18:00:00Z'), '01J3NEW');
  assert.equal(
    next.deferAt,
    undefined,
    'a repeating item with no dates keeps having none: it is simply available again',
  );
  assert.equal(next.dueAt, undefined);
});

/**
 * The error cases of `successor`, which Go reported through its second return
 * value. None of them may leave the task it was given half-changed, because
 * `tdo done` writes the task and the successor both or neither.
 */
test('a successor that cannot be computed changes nothing', () => {
  const unreadable = repeating(RepeatFixed, 'every so often');
  assert.throws(() => successor(unreadable, at('2026-01-10T18:00:00Z'), '01J3NEW'), /interval/);
  assert.throws(() => complete(unreadable, at('2026-01-10T18:00:00Z'), '01J3NEW'), /interval/);
  assert.equal(unreadable.status, StatusActive, 'a refused completion leaves the task open');
  assert.equal(unreadable.completedAt, undefined);

  const noID = repeating(RepeatFixed, '1d');
  assert.throws(() => successor(noID, at('2026-01-10T18:00:00Z'), ''), /needs an id/);

  const badMethod = repeating('sometimes', '1d');
  assert.throws(
    () => successor(badMethod, at('2026-01-10T18:00:00Z'), '01J3NEW'),
    /not one of fixed, from_completion or defer_another/,
  );
});

/** `ensureSeries` is reached through `complete`, and is also its own call. */
test('ensureSeries mints a series id once and only for a repeat', () => {
  const plain = newTask('01J3', KindTask, 'once', at('2026-01-01T09:00:00Z'));
  assert.equal(ensureSeries(plain), false, 'a task that does not repeat has no series');
  assert.equal(plain.seriesID, '');

  const t = repeating(RepeatFixed, '1d');
  assert.equal(ensureSeries(t), true);
  assert.equal(t.seriesID, t.id);
  assert.equal(ensureSeries(t), false, 'a series id already minted is not reminted');

  const joined = repeating(RepeatFixed, '1d');
  joined.seriesID = '01J3SERIES00000000000000AA';
  assert.equal(ensureSeries(joined), false);
  assert.equal(joined.seriesID, '01J3SERIES00000000000000AA');
});

test('next review is derived and never stale', () => {
  const now = at('2026-06-01T12:00:00Z');
  const project = newTask('01J3', KindProject, 'a project', now);

  assert.equal(
    nextReviewAt(project, now),
    undefined,
    'an item with no review interval is never due for review',
  );

  project.reviewInterval = { every: '1w' };
  let got = nextReviewAt(project, now);
  assert.equal(
    got === undefined ? 'none' : formatTime(got),
    formatTime(now),
    'an item never reviewed is due now, which is the honest answer',
  );

  markReviewed(project, now);
  got = nextReviewAt(project, now);
  assert.equal(
    got === undefined ? 'none' : formatTime(got),
    '2026-06-08T12:00:00Z',
    'next_review_at is last_reviewed_at plus the interval',
  );
  assert.equal(formatTime(project.updatedAt), formatTime(now), 'markReviewed touches updated_at');

  // An interval this binary cannot read must surface the item rather than
  // hide it, which is how the user finds out about it.
  project.reviewInterval = { every: 'every so often' };
  got = nextReviewAt(project, now);
  assert.equal(
    got === undefined ? 'none' : formatTime(got),
    formatTime(now),
    'an unreadable interval must make the item due now rather than invisible',
  );
});
