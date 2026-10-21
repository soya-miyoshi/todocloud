// Module recur turns a completed repeating item into its successor.
//
// It is domain logic with no I/O: it reads a task and returns a new one, and
// the command layer is what writes either of them. That is deliberate. PLAN.md
// §3.4 makes it a safety property that a new instance appears only as the
// direct result of an explicit `tdo done` — nothing is generated in the
// background, on a timer, or during a read, because a tool an agent drives
// must not manufacture rows while it is being read. A module that cannot
// reach a store cannot break that rule by accident.
//
// Port notes, where TypeScript cannot hold the Go shape exactly:
//
//   - Go returns `(value, error)`. `parseEvery`, `successor` and `complete`
//     throw instead, the way `task.parseTime` does: an interval that cannot
//     be read is not an answer the caller can carry on with. `ErrNoRepeat`
//     stays a sentinel value and is attached as the thrown error's `cause`,
//     which is how `exit.classify` already walks a Go `%w` chain.
//   - `NextReviewAt` returned `(time.Time, bool)`; it returns
//     `Date | undefined` here, which is the same information in one value.
//   - Go's `time.Weekday` is an integer with Sunday = 0, which is also what
//     `Date.prototype.getUTCDay` returns, so a weekday is a plain number.
//   - Go's `time.Time` carries nanoseconds and a `Date` carries only
//     milliseconds. Nothing in this module reads sub-second precision; it
//     only has to be preserved across the arithmetic, and it is.

import {
  type Task,
  RepeatDeferAnother,
  RepeatFixed,
  RepeatFromCompletion,
  StatusActive,
  StatusDone,
} from './task.ts';

/**
 * ErrNoRepeat is the error reported when a task that does not repeat is asked
 * for its successor. The caller — `tdo done` — treats it as "nothing more to
 * do". It is thrown wrapped in an error naming the task, with this value as
 * the `cause`, so `isNoRepeat` recognises it the way `errors.Is` did.
 */
export const ErrNoRepeat = new Error('task does not repeat');

/** Reports whether err, or anything it wraps, is ErrNoRepeat. */
export function isNoRepeat(err: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur !== null && cur !== undefined && !seen.has(cur)) {
    if (cur === ErrNoRepeat) {
      return true;
    }
    seen.add(cur);
    cur = typeof cur === 'object' && 'cause' in cur ? cur.cause : undefined;
  }
  return false;
}

/** Unit is the calendar unit of an interval. */
export type Unit = 'd' | 'w' | 'mo' | 'y';

export const UnitDay: Unit = 'd';
export const UnitWeek: Unit = 'w';
export const UnitMonth: Unit = 'mo';
export const UnitYear: Unit = 'y';

/**
 * Weekday is Go's `time.Weekday`: Sunday = 0 through Saturday = 6, the same
 * numbering `Date.prototype.getUTCDay` uses.
 */
export type Weekday = number;

export const Sunday: Weekday = 0;
export const Monday: Weekday = 1;
export const Tuesday: Weekday = 2;
export const Wednesday: Weekday = 3;
export const Thursday: Weekday = 4;
export const Friday: Weekday = 5;
export const Saturday: Weekday = 6;

const weekdayNames = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

const ordinalNames: Record<number, string> = {
  1: 'first',
  2: 'second',
  3: 'third',
  4: 'fourth',
  5: 'fifth',
  [-1]: 'last',
};

const ordinals: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  last: -1,
};

const weekdays: Record<string, Weekday> = {
  sunday: Sunday,
  monday: Monday,
  tuesday: Tuesday,
  wednesday: Wednesday,
  thursday: Thursday,
  friday: Friday,
  saturday: Saturday,
};

/**
 * Every is a parsed interval: a count of a calendar unit, optionally snapped
 * to a weekday within the period it lands in ("1mo:last-friday").
 */
export class Every {
  n: number;
  unit: Unit;
  /** ordinal is 1..5 for first..fifth and -1 for last; 0 means no snap. */
  ordinal: number;
  weekday: Weekday;

  constructor(n: number, unit: Unit, ordinal = 0, weekday: Weekday = Sunday) {
    this.n = n;
    this.unit = unit;
    this.ordinal = ordinal;
    this.weekday = weekday;
  }

  /** snapped reports whether the interval names a weekday. */
  snapped(): boolean {
    return this.ordinal !== 0;
  }

  /**
   * toString renders the interval back in the spelling it was parsed from, so
   * a round trip through the store changes nothing. Go spelled this `String`.
   */
  toString(): string {
    const s = String(this.n) + this.unit;
    if (!this.snapped()) {
      return s;
    }
    return `${s}:${ordinalNames[this.ordinal] ?? ''}-${weekdayNames[this.weekday] ?? ''}`;
  }

  /**
   * next returns the instant one interval after from, in UTC.
   *
   * Month and year arithmetic clamps rather than overflowing: one month after
   * 31 January is 28 or 29 February, not 2 or 3 March, because a monthly
   * chore set on the 31st should not drift into the following month. Both
   * Go's AddDate and JavaScript's date setters normalise instead, so the
   * clamp is done here.
   */
  next(from: Date): Date {
    const at = from;
    let out: Date;
    switch (this.unit) {
      case UnitDay:
        out = addDays(at, this.n);
        break;
      case UnitWeek:
        out = addDays(at, 7 * this.n);
        break;
      case UnitMonth:
        out = addMonths(at, this.n);
        break;
      case UnitYear:
        out = addMonths(at, 12 * this.n);
        break;
      default:
        out = new Date(at.getTime());
    }
    if (this.snapped()) {
      out = snapWeekday(out, this.ordinal, this.weekday);
    }
    return out;
  }
}

/**
 * parseEvery reads the duration-with-calendar spelling of §3.4: "3d", "2w",
 * "1mo", "1y", and "1mo:last-friday" for the calendar cases.
 *
 * The messages name what was expected, because this string is typed by a user
 * at a terminal and the spelling is the whole interface.
 */
export function parseEvery(s: string): Every {
  const raw = s.trim().toLowerCase();
  if (raw === '') {
    throw new Error(
      'an interval must say how often, for example 1w or 1mo:last-friday',
    );
  }
  // Go's strings.Cut: everything before the first ":", and whether there was
  // one at all. An empty snap after a ":" is not the same as no ":".
  const colon = raw.indexOf(':');
  const hasSnap = colon >= 0;
  const period = hasSnap ? raw.slice(0, colon) : raw;
  const snap = hasSnap ? raw.slice(colon + 1) : '';

  let digits = 0;
  while (digits < period.length && period[digits]! >= '0' && period[digits]! <= '9') {
    digits++;
  }
  if (digits === 0) {
    throw new Error(
      `interval ${quote(s)} must start with a number, for example 1w`,
    );
  }
  const n = Number(period.slice(0, digits));
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(
      `interval ${quote(s)} must repeat at least once, for example 1w`,
    );
  }
  const rest = period.slice(digits);
  if (rest !== UnitDay && rest !== UnitWeek && rest !== UnitMonth && rest !== UnitYear) {
    throw new Error(
      `interval ${quote(s)} uses unit ${quote(rest)}; expected d, w, mo or y`,
    );
  }
  const unit: Unit = rest;

  if (!hasSnap) {
    return new Every(n, unit);
  }
  const dash = snap.indexOf('-');
  const name = dash >= 0 ? snap.slice(0, dash) : snap;
  const day = dash >= 0 ? snap.slice(dash + 1) : '';
  const ordinal = ordinals[name];
  const weekday = weekdays[day];
  if (dash < 0 || ordinal === undefined || weekday === undefined) {
    throw new Error(
      `interval ${quote(s)}: expected a calendar day like last-friday or first-monday`,
    );
  }
  if (unit !== UnitMonth && unit !== UnitYear) {
    // A weekday within a week or a day is either a no-op or a contradiction;
    // refusing it is clearer than guessing which.
    throw new Error(
      `interval ${quote(s)}: a calendar day only makes sense with mo or y, not ${unit}`,
    );
  }
  return new Every(n, unit, ordinal, weekday);
}

/** Go's %q on a string, which is what the error messages were written for. */
function quote(s: string): string {
  return JSON.stringify(s);
}

/**
 * utc builds an instant from UTC calendar parts, normalising overflow the way
 * Go's time.Date does.
 *
 * `Date.UTC` and `new Date(y, …)` remap a year in 0..99 onto 1900..1999;
 * `setUTCFullYear` does not, so the parts go in through the setters. Nothing
 * in this repository stores a first-century timestamp, but a silent
 * century-shift is the kind of bug that only shows up in someone's export.
 */
function utc(
  year: number,
  month: number,
  day: number,
  hours: number,
  minutes: number,
  seconds: number,
  ms: number,
): Date {
  const d = new Date(0);
  d.setUTCFullYear(year, month, day);
  d.setUTCHours(hours, minutes, seconds, ms);
  return d;
}

/** addDays advances by whole days; Go's AddDate(0, 0, days) in UTC. */
function addDays(at: Date, days: number): Date {
  return utc(
    at.getUTCFullYear(),
    at.getUTCMonth(),
    at.getUTCDate() + days,
    at.getUTCHours(),
    at.getUTCMinutes(),
    at.getUTCSeconds(),
    at.getUTCMilliseconds(),
  );
}

/**
 * addMonths advances by whole months, clamping the day to the last day of the
 * target month.
 */
function addMonths(at: Date, months: number): Date {
  const year0 = at.getUTCFullYear();
  // getUTCMonth is already 0-based, where Go's time.Month is 1-based and the
  // Go code subtracted one here.
  let year = year0;
  let total = at.getUTCMonth() + months;
  year += Math.trunc(total / 12);
  total %= 12;
  if (total < 0) {
    total += 12;
    year--;
  }
  let day = at.getUTCDate();
  const last = daysIn(year, total);
  if (day > last) {
    day = last;
  }
  return utc(
    year,
    total,
    day,
    at.getUTCHours(),
    at.getUTCMinutes(),
    at.getUTCSeconds(),
    at.getUTCMilliseconds(),
  );
}

/** daysIn is the length of month (0-based) in year; Go's day 0 of the next. */
function daysIn(year: number, month: number): number {
  return utc(year, month + 1, 0, 0, 0, 0, 0).getUTCDate();
}

/**
 * snapWeekday moves at to the nth given weekday of its own month, keeping the
 * time of day. A fifth weekday that the month does not have falls back to the
 * last one, which is what a user who wrote "fifth-monday" meant by it.
 */
function snapWeekday(at: Date, ordinal: number, weekday: Weekday): Date {
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth();
  const h = at.getUTCHours();
  const m = at.getUTCMinutes();
  const s = at.getUTCSeconds();
  const ms = at.getUTCMilliseconds();

  const first = utc(year, month, 1, h, m, s, ms);
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  let day = 1 + offset;

  const last = daysIn(year, month);
  if (ordinal < 0) {
    while (day + 7 <= last) {
      day += 7;
    }
  } else {
    day += 7 * (ordinal - 1);
    while (day > last) {
      day -= 7;
    }
  }
  return utc(year, month, day, h, m, s, ms);
}

/**
 * ensureSeries gives a repeating task a series id if it has none, minting it
 * from its own id: the first instance names the series, so no second
 * generator is needed and the series is readable in an export. It reports
 * whether it changed anything.
 */
export function ensureSeries(t: Task): boolean {
  if (t.repeat === undefined || t.seriesID !== '') {
    return false;
  }
  t.seriesID = t.id;
  return true;
}

/**
 * successor returns the next instance of a repeating task, with the id the
 * caller minted for it. It does not touch t; `complete` is the entry point
 * that also closes the current instance.
 *
 * The three methods differ only in what the dates are computed from (§3.4).
 * A repeating task with no dates at all keeps having none: the successor is
 * simply available again, which is what a repeating checklist item is.
 */
export function successor(t: Task, completedAt: Date, newID: string): Task {
  if (t.repeat === undefined) {
    throw new Error(`${t.id}: ${ErrNoRepeat.message}`, { cause: ErrNoRepeat });
  }
  if (newID === '') {
    throw new Error('a successor needs an id');
  }
  let every: Every;
  try {
    every = parseEvery(t.repeat.every);
  } catch (err) {
    throw new Error(`${t.id}: ${messageOf(err)}`, { cause: err });
  }
  const at = new Date(completedAt.getTime());

  const next = t.clone();
  next.id = newID;
  next.status = StatusActive;
  next.completedAt = undefined;
  next.droppedAt = undefined;
  next.deletedAt = undefined;
  next.lastReviewedAt = undefined;
  next.createdAt = at;
  next.updatedAt = at;
  next.seriesID = t.seriesID;
  if (next.seriesID === '') {
    next.seriesID = t.id;
  }

  switch (t.repeat.method) {
    case RepeatFixed:
      // From the previous instance's own dates, so a schedule kept this way
      // is a calendar and can fall behind when it is done late.
      next.deferAt = shift(every, t.deferAt);
      next.dueAt = shift(every, t.dueAt);
      break;
    case RepeatFromCompletion:
      // From the moment of completion: "every 3 days after I actually do
      // it". The gap the user left between deferring and the deadline is
      // part of the shape of the task, so it is carried over.
      if (t.dueAt !== undefined) {
        const due = every.next(at);
        next.dueAt = due;
        if (t.deferAt !== undefined) {
          const lead = t.dueAt.getTime() - t.deferAt.getTime();
          next.deferAt = new Date(due.getTime() - lead);
        }
      } else if (t.deferAt !== undefined) {
        next.deferAt = every.next(at);
      }
      break;
    case RepeatDeferAnother:
      // Only the defer date moves, and it moves from completion: put this
      // out of sight for another interval. A deadline, if there is one, is a
      // real date and does not move because the work was touched.
      next.deferAt = every.next(at);
      next.dueAt = cloneTime(t.dueAt);
      break;
    default:
      throw new Error(
        `${t.id}: repeat method ${quote(t.repeat.method)} is not one of fixed, from_completion or defer_another`,
      );
  }
  return next;
}

/**
 * complete marks t done and returns its successor, or undefined when t does
 * not repeat. It is the one call `tdo done` makes, so that minting the series
 * id onto the current instance cannot be forgotten: the caller writes t back
 * and adds the successor, both or neither.
 *
 * `tdo done --no-repeat` simply does not call this.
 */
export function complete(t: Task, now: Date, newID: string): Task | undefined {
  const at = new Date(now.getTime());
  if (t.repeat === undefined) {
    t.setStatus(StatusDone, at);
    return undefined;
  }
  ensureSeries(t);
  // Go set the status only after Successor returned, so a failure leaves the
  // task untouched and `tdo done` writes nothing. Throwing keeps that.
  const next = successor(t, at, newID);
  t.setStatus(StatusDone, at);
  return next;
}

/**
 * nextReviewAt derives when a folder or project is next due to be looked at:
 * last_reviewed_at plus the interval (§3.5). It is derived rather than stored
 * so it cannot drift out of sync with either half. It is undefined when the
 * item has no review interval, which is the `next_review_at: null` of
 * docs/agents.md.
 *
 * An item with a review interval that has never been reviewed is due now,
 * which is the honest answer: nobody has looked at it.
 */
export function nextReviewAt(t: Task, now: Date): Date | undefined {
  if (t.reviewInterval === undefined) {
    return undefined;
  }
  let every: Every;
  try {
    every = parseEvery(t.reviewInterval.every);
  } catch {
    // An interval this binary cannot read must not hide the item from
    // `tdo review`; surfacing it is how the user finds out.
    return new Date(now.getTime());
  }
  if (t.lastReviewedAt === undefined) {
    return new Date(now.getTime());
  }
  return every.next(t.lastReviewedAt);
}

/**
 * markReviewed records that the item was looked at now. The caller writes it
 * back; next_review_at follows from it.
 */
export function markReviewed(t: Task, now: Date): void {
  const at = new Date(now.getTime());
  t.lastReviewedAt = at;
  t.updatedAt = at;
}

function shift(e: Every, at: Date | undefined): Date | undefined {
  if (at === undefined) {
    return undefined;
  }
  return e.next(at);
}

function cloneTime(at: Date | undefined): Date | undefined {
  if (at === undefined) {
    return undefined;
  }
  return new Date(at.getTime());
}

/** The message of a thrown value, whatever it turned out to be. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
