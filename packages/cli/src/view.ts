// Rendering: the one JSON shape, the human table and the detail block.
//
// Go attached the helpers here to the `*app` receiver; see the note in app.ts
// for why the port passes the app as the first parameter instead.

import * as exit from '@todocloud/core/exit';
import * as id from '@todocloud/core/id';
import { Detail, Row, Table } from '@todocloud/core/output/task';
import { NewTaskView, type TaskView, Views } from '@todocloud/core/output/view';
import {
  Availability,
  isBadParent,
  isCycle,
  RuleAncestorEvent,
  RuleEvent,
  type Store,
} from '@todocloud/core/store';
import { newTask, type Task } from '@todocloud/core/task';
import { availabilityOf as taskopsAvailabilityOf } from '@todocloud/core/taskops';

import { type App, asError } from './app.ts';
import { eventJSON, printEvents, projectEvents, projectTitles, waitingFor } from './eventview.ts';

/**
 * views pairs tasks with the availability answer for each of them. The shape
 * it renders lives in output, because `tdo serve` emits the same one.
 */
export function views(tasks: Task[], av: Map<string, Availability>): TaskView[] {
  return Views(tasks, av);
}

/**
 * availabilityOf asks the shared layer for §3.3 over these tasks: the rules
 * are computed in the store so that every provider and every command agree.
 */
export function availabilityOf(
  _a: App,
  st: Store,
  tasks: readonly Task[],
): Promise<Map<string, Availability>> {
  return taskopsAvailabilityOf(st, tasks, new Date());
}

/**
 * renderTask writes one task: the same JSON shape every other command uses,
 * {"tasks":[…],"count":n}, or a human detail block that says why the task is
 * blocked when it is.
 *
 * There used to be a second shape, {"task":{…}}, for the commands that act on
 * exactly one item. One shape costs a caller `.tasks[0]` where it knows there
 * is one item, and saves it from having to know which commands are which:
 * `jq '.task // .tasks[]'` was the only way to write a line that worked for
 * both. Nothing has been released, so the two were merged rather than kept
 * (PLAN.md §9).
 */
export async function renderTask(a: App, st: Store, t: Task): Promise<void> {
  const av = await availabilityOf(a, st, [t]);
  const answer = av.get(t.id);
  const asked = answer !== undefined;
  // A project also lists the events that belong to it: they are what its
  // outline waits on, and the project's own view is where to look for them.
  const owned = t.kind === 'project' ? await projectEvents(st, t) : [];
  const waiting = owned.length > 0 ? await waitingFor(st) : new Map<string, Task[]>();
  if (a.out.json) {
    a.out.emit({
      tasks: [NewTaskView(t, answer ?? emptyAvailability(), asked)],
      count: 1,
      ...(t.kind === 'project' ? { events: owned.map((e) => eventJSON(e, waiting)) } : {}),
    });
    return;
  }
  // The item holding this one back is usually somewhere else in the tree, so
  // it is fetched by id rather than inferred from what is on screen.
  let by: Task | undefined;
  if (
    answer !== undefined &&
    !answer.available &&
    answer.blockedBy !== '' &&
    answer.blockedBy !== t.id
  ) {
    try {
      if (answer.rule === RuleEvent || answer.rule === RuleAncestorEvent) {
        // The blocker is an event, which is not a task; Detail wants a task
        // to name, so the event stands in under its own title.
        const e = await st.getEvent(answer.blockedBy);
        by = newTask(e.id, 'task', e.title, e.createdAt);
      } else {
        by = await st.get(answer.blockedBy);
      }
    } catch {
      // Go ignored this error too: the blocking item being unreadable is no
      // reason to refuse to show the item the user asked for.
    }
  }
  Detail(
    a.out.out,
    new Row({ task: t, availability: answer ?? emptyAvailability(), asked }),
    by,
  );
  if (owned.length > 0) {
    a.out.printf('\nevents:\n');
    printEvents(a, owned, waiting, await projectTitles(st, owned));
  }
}

/**
 * renderTasks writes the bulk shape, {"tasks":[…],"count":n}, or a table.
 * extra adds keys to the JSON object — `tdo done` reports its successors
 * there — and is ignored for human output.
 */
export async function renderTasks(
  a: App,
  st: Store,
  tasks: Task[],
  extra: Record<string, unknown> | undefined,
): Promise<void> {
  const av = await availabilityOf(a, st, tasks);
  if (a.out.json) {
    a.out.emit({ tasks: views(tasks, av), count: tasks.length, ...(extra ?? {}) });
    return;
  }
  printTable(a, tasks, av, false);
}

/**
 * printTable writes the human listing. tree asks for the nesting to be shown
 * by indentation; depth is measured against the tasks actually listed, so a
 * row is never indented under something the filter hid.
 *
 * start is how many rows of the saved listing precede these, for a caller
 * that writes one listing as several tables — see `Table`.
 */
export function printTable(
  a: App,
  tasks: readonly Task[],
  av: Map<string, Availability>,
  tree: boolean,
  start = 0,
): void {
  const rows: Row[] = [];
  const depth = new Map<string, number>();
  const listed = new Set<string>();
  for (const t of tasks) {
    listed.add(t.id);
  }
  for (const t of tasks) {
    let d = 0;
    if (tree && t.parentID !== '' && listed.has(t.parentID)) {
      d = (depth.get(t.parentID) ?? 0) + 1;
    }
    depth.set(t.id, d);
    const answer = av.get(t.id);
    rows.push(
      new Row({
        task: t,
        depth: d,
        availability: answer ?? emptyAvailability(),
        asked: answer !== undefined,
      }),
    );
  }
  Table(a.out.out, rows, start);
}

/**
 * treeError turns the two tree rules of §3.1 into usage errors. An illegal
 * parent/kind pairing and a move that would make a cycle are mistakes at the
 * command line, not store failures, and §4.2 fixes them at exit 2.
 */
export function treeError(err: unknown): Error {
  const e = asError(err);
  if (isBadParent(e) || isCycle(e)) {
    return exit.usagef(e) as Error;
  }
  return e;
}

/**
 * countLine renders a count with the right noun, for the one-line summaries
 * the human output ends with.
 */
export function countLine(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * report adds the containers a write closed under §3.3a to a command's
 * output: a line on stderr for a human, and a "completed_with_last" array for
 * a machine. A project leaving `tdo ls` because its last action closed is not
 * something to discover later.
 */
export function report(
  a: App,
  completed: readonly Task[],
  extra: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (completed.length === 0) {
    return extra;
  }
  if (!a.out.json) {
    for (const container of completed) {
      a.out.hintf(`completed with its last action: ${id.Short(container.id, 8)} ${container.title}`);
    }
    return extra;
  }
  const out = extra ?? {};
  // Go passed a nil availability map, which reads as "never asked" for every
  // task; an empty map is the same answer.
  out['completed_with_last'] = views([...completed], new Map());
  return out;
}

/**
 * emptyAvailability is the zero value Go's map read gave for a missing key.
 * It is never rendered as an answer, because `asked` is false beside it.
 */
function emptyAvailability(): Availability {
  return new Availability();
}
