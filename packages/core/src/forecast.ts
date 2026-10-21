// The Forecast: which tasks belong to it, in what order, and which of them are
// folded behind the horizon. It is written once as pure functions over tasks so
// that the list a terminal prints and the list a browser draws can share one
// definition and not drift apart. `tdo forecast` reads it today; the viewer's
// `app.js` still carries its own copy of these rules, to be replaced by it.
//
// The rules were first written inside the viewer's `app.js` (the `PERSPECTIVES`
// entry keyed `due`, `byDateThen`, `beyondHorizon` and `landed`); this is that
// logic, copied. A Forecast is not a saved perspective: it is not a filter the
// store can run, because it sorts by one date and falls back to the other,
// and folds a tail by a calendar distance from now.
//
// This module must run in a browser, so it imports only the task model.

import { type Task, KindTask, statusClosed } from './task.ts';

/** The two orders a Forecast is read in. */
export type ForecastOrder = 'defer' | 'due';

/** The orders, in the order a front end offers them; defer is the default. */
export const ForecastOrders: readonly ForecastOrder[] = ['defer', 'due'];

/**
 * ForecastHorizonDays is how far ahead the Forecast looks. A Forecast is about
 * the week in front of you: what is already here, and what arrives over the
 * next seven days. Something released in three weeks is a fact about the list
 * and not news about today, so it is still in the view — folded to the end,
 * not filtered away, which would be a different and more dishonest thing.
 */
export const ForecastHorizonDays = 7;

const msPerDay = 86_400_000;

/**
 * calendarDays counts whole calendar days from `now` to `at`, in UTC. It is a
 * calendar question and not an hourly one: an item due at midnight this
 * morning is still due today, an hour overdue, and calling that "yesterday" is
 * how a list starts lying to its reader. UTC is the same frame `--due
 * 2026-11-01` is written in, which is that day at 00:00:00Z.
 */
export function calendarDays(at: Date, now: Date): number {
  const a = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  const n = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((a - n) / msPerDay);
}

/**
 * inForecast reports whether a task belongs to the Forecast: a task, not
 * finished or dropped, carrying either date.
 *
 * Tasks only. A project carries a due date of its own, which read as work to
 * do and was not: a project is a container, and the thing to do is whichever
 * of its tasks is next. Either date qualifies, because defer is the order the
 * Forecast is read in out of the box, and a default order over a list the date
 * is missing from would leave out exactly the items it is sorted by.
 */
export function inForecast(t: Task): boolean {
  return (
    t.kind === KindTask &&
    !statusClosed(t.status) &&
    !t.deleted() &&
    (t.dueAt !== undefined || t.deferAt !== undefined)
  );
}

/**
 * landed reports whether the day an item is due has come: due today or on any
 * day before it. It is what the Forecast's badge counts — a calendar question,
 * so something due at 18:00 has landed at breakfast, and a forecast that waits
 * until 18:01 to say so is useless in the morning.
 */
export function landed(t: Task, now: Date): boolean {
  return t.dueAt !== undefined && !statusClosed(t.status) && calendarDays(t.dueAt, now) <= 0;
}

/**
 * pastDue reports that an item is from an earlier day: due on any day before
 * today. It is a different question from "overdue", which is about the
 * instant, and it is the one a Forecast needs. A due date written as a day is
 * midnight, so everything due today is overdue by breakfast — true, and
 * useless for telling today's work apart from last week's. There is no Past
 * bucket to separate them (see `forecastDays`), so this is what a front end
 * colours by and what a terminal can mark.
 */
export function pastDue(t: Task, now: Date): boolean {
  return t.dueAt !== undefined && !statusClosed(t.status) && calendarDays(t.dueAt, now) < 0;
}

/** beyondHorizon reports whether a task is deferred past the horizon. */
export function beyondHorizon(t: Task, now: Date): boolean {
  return t.deferAt !== undefined && calendarDays(t.deferAt, now) > ForecastHorizonDays;
}

/**
 * byDateThen orders by the date named first, standing in the other date where
 * the named one is missing: an item with no defer date is available already,
 * so in defer order it belongs where its deadline puts it rather than dumped
 * at the end — and an overdue item at the bottom of a forecast is exactly the
 * failure to avoid. Ties break on the title so the order is stable between
 * runs.
 */
function byDateThen(first: 'deferAt' | 'dueAt', second: 'deferAt' | 'dueAt') {
  const keyOf = (t: Task): number | undefined => (t[first] ?? t[second])?.getTime();
  return (a: Task, b: Task): number => {
    const x = keyOf(a);
    const y = keyOf(b);
    if (x === undefined) {
      return y === undefined ? 0 : 1;
    }
    if (y === undefined) {
      return -1;
    }
    return x - y || a.title.localeCompare(b.title);
  };
}

const sorts: Record<ForecastOrder, (a: Task, b: Task) => number> = {
  defer: byDateThen('deferAt', 'dueAt'),
  due: byDateThen('dueAt', 'deferAt'),
};

/** What `forecast` returns: the two parts of one list, each already in order. */
export interface ForecastList {
  /** near is what is on screen: everything not deferred past the horizon. */
  near: Task[];
  /** later is the tail behind the fold. */
  later: Task[];
}

/**
 * forecast selects, orders and splits the Forecast out of any list of tasks.
 * One function, because the fold's own count and the rows it hides have to
 * agree. The input is not modified.
 */
export function forecast(tasks: readonly Task[], order: ForecastOrder, now: Date): ForecastList {
  const items = tasks.filter(inForecast).sort(sorts[order]);
  return {
    near: items.filter((t) => !beyondHorizon(t, now)),
    later: items.filter((t) => beyondHorizon(t, now)),
  };
}

/** forecastOrder validates a user-supplied order, or returns undefined. */
export function forecastOrder(value: string): ForecastOrder | undefined {
  return (ForecastOrders as readonly string[]).includes(value) ? (value as ForecastOrder) : undefined;
}

// --- the week ------------------------------------------------------------

/**
 * ForecastDay is one column of the week: the day itself, and the two
 * questions a day asks of a task. The two are separate on purpose — a
 * deadline that has passed belongs to today, a defer date that has passed is
 * nothing but availability and belongs to no day at all.
 */
export interface ForecastDay {
  /** key is stable across midnight (`today`, `d1`…`d6`) and is what a URL or a flag carries. */
  readonly key: string;
  /** label is what to call it on screen: `Today`, or the weekday's short name. */
  readonly label: string;
  /** date is the day itself, at 00:00:00Z. */
  readonly date: Date;
  /** today marks the first cell, the one that carries everything already due. */
  readonly today: boolean;
  /** dueMatch answers whether a deadline this many calendar days away is this day's. */
  dueMatch(days: number): boolean;
  /** startMatch answers the same for a defer date. */
  startMatch(days: number): boolean;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** ForecastWeekDays is how many columns the week has: today and six more. */
export const ForecastWeekDays = 7;

/**
 * ForecastMaxDays is the longest run of days a caller may ask for. The limit
 * is not about cost — the days are cut out of a list already in memory — but
 * about the answer staying one: past a couple of months of headings the
 * reader is no longer looking at a forecast, and `tdo ls --sort due` is the
 * question they actually have.
 */
export const ForecastMaxDays = 60;

/**
 * forecastDays is the week, today first.
 *
 * `count` is how many days to lay out, the week by default. A shorter run is
 * the same days cut short; a longer one keeps going past the fold, which is
 * deliberate: `ForecastHorizonDays` is where the *flat* list stops trusting a
 * defer date to be news, and a reader who asked for thirty days of headings
 * has said they want the days anyway.
 *
 * There is no "Past" column. **Today carries everything already due**, which
 * is what a day opened in the morning has to say: an overdue bill is today's
 * problem, and filing it under a day that has gone is how it stops being
 * looked at. What separates the two inside today's list is `pastDue` — a
 * colour in the viewer, a mark in the terminal — not a bucket of its own.
 *
 * The keys are stable while the labels are not: Thursday is `d4` today and
 * `d3` tomorrow, and a view held open across midnight should follow the day
 * it means rather than the name it had.
 */
export function forecastDays(now: Date, count: number = ForecastWeekDays): ForecastDay[] {
  const days: ForecastDay[] = [];
  for (let i = 0; i < count; i += 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + i * msPerDay);
    const today = i === 0;
    days.push({
      key: today ? 'today' : `d${i}`,
      label: today ? 'Today' : (WEEKDAYS[date.getUTCDay()] as string),
      date,
      today,
      dueMatch: today ? (d: number): boolean => d <= 0 : (d: number): boolean => d === i,
      startMatch: (d: number): boolean => d === i,
    });
  }
  return days;
}

/**
 * forecastDay looks a day up by key, or returns undefined. `count` is the run
 * of days the key is looked for in, the week by default.
 */
export function forecastDay(
  key: string,
  now: Date,
  count: number = ForecastWeekDays,
): ForecastDay | undefined {
  return forecastDays(now, count).find((d) => d.key === key);
}

/**
 * dueOn is what a day's number counts: the deadlines that land on it. Tasks
 * only, as `inForecast` has it, so that the number is the number of rows the
 * day opens.
 */
export function dueOn(tasks: readonly Task[], day: ForecastDay, now: Date): Task[] {
  return tasks.filter(
    (t) => inForecast(t) && t.dueAt !== undefined && day.dueMatch(calendarDays(t.dueAt, now)),
  );
}

/**
 * startsOn is the other half: what becomes available that day. It is counted
 * apart from the deadlines, because a deadline and a release are not the same
 * news — a day showing "5" that turns out to be five things that merely became
 * available reads as pressure that is not there, and the one real deadline
 * hides inside it.
 */
export function startsOn(tasks: readonly Task[], day: ForecastDay, now: Date): Task[] {
  return tasks.filter(
    (t) => inForecast(t) && t.deferAt !== undefined && day.startMatch(calendarDays(t.deferAt, now)),
  );
}

/**
 * forecastOn is one day of the week: everything it has to say, deadlines
 * first and then what is released, never the same task twice, in the order
 * the whole Forecast is read in.
 */
export function forecastOn(
  tasks: readonly Task[],
  day: ForecastDay,
  order: ForecastOrder,
  now: Date,
): Task[] {
  const items = dueOn(tasks, day, now);
  const seen = new Set(items.map((t) => t.id));
  for (const t of startsOn(tasks, day, now)) {
    if (!seen.has(t.id)) {
      items.push(t);
    }
  }
  return items.sort(sorts[order]);
}
