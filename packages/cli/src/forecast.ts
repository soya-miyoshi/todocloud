// `tdo forecast`: the tasks the viewer's Forecast shows, in the order it shows
// them. The selection, the order and the fold all come from
// `@todocloud/core/forecast`, so the viewer can be moved onto the same
// definition without this command changing.

import { Filter } from '@todocloud/core/store/filter';
import { AvailabilityAny, OrderPosition, type Store } from '@todocloud/core/store';
import { KindTask, type Task } from '@todocloud/core/task';
import {
  type ForecastDay,
  type ForecastOrder,
  ForecastHorizonDays,
  ForecastWeekDays,
  dueOn,
  forecast,
  forecastDay,
  forecastDays,
  forecastOn,
  forecastOrder,
  landed,
  pastDue,
  startsOn,
} from '@todocloud/core/forecast';
import { openStatuses } from '@todocloud/core/taskops/select';

import { type App, type Command, type Context, usagef } from './app.ts';
import { saveListing } from './refs.ts';
import { availabilityOf, countLine, printTable, views } from './view.ts';

/**
 * forecastCommand is `tdo forecast`: a pure read. It lists every open task
 * that carries a defer or a due date, so a task waiting on its defer date is
 * here although `tdo ls` hides it.
 */
export function forecastCommand(a: App): Command {
  return {
    name: 'forecast',
    usage: 'list the tasks with a defer or due date, as the viewer\'s Forecast does',
    store: 'read',
    flags: {
      sort: {
        type: 'string',
        placeholder: 'ORDER',
        usage: 'order by defer (the default) or due; the other date stands in where one is missing',
      },
      day: {
        type: 'string',
        placeholder: 'DAY',
        usage: 'one day of the week: today (which carries everything already due), or d1 to d6',
      },
      week: {
        type: 'boolean',
        usage: 'group the next seven days under their own headings',
      },
    },
    async run(ctx: Context): Promise<void> {
      if (ctx.args.length > 0) {
        throw usagef('forecast takes no arguments; pass --sort due to read it by deadline');
      }
      const sort = ctx.string('sort').trim();
      const order = sort === '' ? 'defer' : forecastOrder(sort);
      if (order === undefined) {
        throw usagef(`--sort must be defer or due, not ${JSON.stringify(sort)}`);
      }
      const asked = ctx.string('day').trim();
      const week = ctx.bool('week');
      if (asked !== '' && week) {
        throw usagef('--day names one day and --week asks for all of them; pass one or the other');
      }

      const st: Store = ctx.store();
      // Tombstones stay out by default. Availability is not the question: a
      // deferred task is the point of this view.
      const open = await st.list(
        new Filter({
          kinds: [KindTask],
          statuses: openStatuses(),
          availability: AvailabilityAny,
          order: OrderPosition,
        }),
      );
      const now = new Date();
      // The week is the viewer's own shape, and both of these are read from
      // the same `open` listing as the flat list below: one query, three
      // presentations of it.
      if (asked !== '') {
        const day = forecastDay(asked, now);
        if (day === undefined) {
          throw usagef(
            `--day must be today or d1 to d${ForecastWeekDays - 1}, not ${JSON.stringify(asked)}`,
          );
        }
        await printDay(a, st, day, forecastOn(open, day, order, now), now);
        return;
      }
      if (week) {
        await printWeek(a, st, open, order, now);
        return;
      }

      const { near, later } = forecast(open, order, now);
      const tasks: Task[] = [...near, ...later];
      const av = await availabilityOf(a, st, tasks);

      if (a.out.json) {
        // The shape of every listing, plus `later`: how many of the last
        // `tasks` are deferred past the horizon. Nothing is dropped, so a
        // caller that wants the viewer's folded view takes the first
        // `count - later`. Machine output never refreshes the short-number
        // cache; see saveListing.
        a.out.emit({ tasks: views(tasks, av), count: tasks.length, later: later.length });
        return;
      }
      saveListing(a, st, tasks);
      if (tasks.length === 0) {
        a.out.hintf('Nothing has a defer or due date. `tdo add <title> --due <date>` adds one.');
        return;
      }
      printTable(a, tasks, av, false);

      const arrived = tasks.filter((t) => landed(t, now)).length;
      if (arrived > 0) {
        a.out.hintf(`${countLine(arrived, 'task is', 'tasks are')} due today or earlier.`);
      }
      if (later.length > 0) {
        a.out.hintf(
          `${countLine(later.length, 'task is', 'tasks are')} deferred more than ${ForecastHorizonDays} days out, listed last.`,
        );
      }
    },
  };
}

/**
 * printDay writes one day of the week. The human form marks what is from an
 * earlier day, because today's column carries those too and the date column
 * alone makes a reader do the subtraction.
 */
async function printDay(
  a: App,
  st: Store,
  day: ForecastDay,
  tasks: Task[],
  now: Date,
): Promise<void> {
  const av = await availabilityOf(a, st, tasks);
  const late = tasks.filter((t) => pastDue(t, now)).length;
  if (a.out.json) {
    // The listing shape, plus which day this is and how much of it arrived
    // before today. Nothing is dropped.
    a.out.emit({
      day: day.key,
      label: day.label,
      date: day.date.toISOString().slice(0, 10),
      tasks: views(tasks, av),
      count: tasks.length,
      past_due: late,
    });
    return;
  }
  saveListing(a, st, tasks);
  a.out.hintf(`${day.label} — ${day.date.toISOString().slice(0, 10)}`);
  if (tasks.length === 0) {
    a.out.hintf('Nothing on this day.');
    return;
  }
  printTable(a, tasks, av, false);
  if (late > 0) {
    a.out.hintf(`${countLine(late, 'task is', 'tasks are')} from an earlier day.`);
  }
}

/**
 * printWeek writes the seven days under their own headings — the viewer's
 * week, in a terminal. A day with nothing on it still gets its heading: the
 * shape of the week is the information, which is the same reason an empty
 * column does not disappear on screen.
 */
async function printWeek(
  a: App,
  st: Store,
  open: readonly Task[],
  order: ForecastOrder,
  now: Date,
): Promise<void> {
  const days = forecastDays(now);
  const listed: Task[] = [];
  const sections = days.map((day) => {
    const tasks = forecastOn(open, day, order, now);
    listed.push(...tasks);
    return { day, tasks };
  });

  if (a.out.json) {
    const av = await availabilityOf(a, st, listed);
    a.out.emit({
      days: sections.map(({ day, tasks }) => ({
        day: day.key,
        label: day.label,
        date: day.date.toISOString().slice(0, 10),
        tasks: views(tasks, av),
        count: tasks.length,
        due: dueOn(open, day, now).length,
        starting: startsOn(open, day, now).length,
        past_due: tasks.filter((t) => pastDue(t, now)).length,
      })),
      count: listed.length,
    });
    return;
  }

  const av = await availabilityOf(a, st, listed);
  // One listing for the short numbers, in the order the week is printed, so
  // that `tdo done 3` means the third row the reader can see. The tables are
  // written per day out of that one listing, which is what `start` is for:
  // each day picks up where the day above it stopped.
  saveListing(a, st, listed);
  let start = 0;
  for (const { day, tasks } of sections) {
    a.out.hintf(`${day.label} — ${day.date.toISOString().slice(0, 10)}`);
    if (tasks.length === 0) {
      continue;
    }
    printTable(a, tasks, av, false, start);
    start += tasks.length;
  }
  const arrived = listed.filter((t) => landed(t, now)).length;
  if (arrived > 0) {
    a.out.hintf(`${countLine(arrived, 'task is', 'tasks are')} due today or earlier.`);
  }
}
