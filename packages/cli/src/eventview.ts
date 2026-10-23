// How an event is shown: the one JSON shape, the human table, and what is
// waiting for it. They live apart from `event.ts` because a project's own view
// (`tdo show`, `tdo project <ref>`) lists the events that belong to it, and
// `view.ts` cannot import the command that imports `view.ts`.

import * as id from '@todocloud/core/id';
import type { Store } from '@todocloud/core/store';
import { type EventItem, EventOccurred } from '@todocloud/core/store/event';
import { formatTime, type Task, StatusDone, StatusDropped } from '@todocloud/core/task';

import type { App } from './app.ts';

/** waitingFor returns the open items that wait for each event, by event id. */
export async function waitingFor(st: Store): Promise<Map<string, Task[]>> {
  const links = await st.waits();
  const out = new Map<string, Task[]>();
  const cache = new Map<string, Task | undefined>();
  for (const l of links) {
    let t = cache.get(l.taskID);
    if (!cache.has(l.taskID)) {
      try {
        t = await st.get(l.taskID);
      } catch {
        t = undefined;
      }
      cache.set(l.taskID, t);
    }
    if (t === undefined || t.deleted() || t.status === StatusDone || t.status === StatusDropped) {
      continue;
    }
    out.set(l.eventID, [...(out.get(l.eventID) ?? []), t]);
  }
  return out;
}

/**
 * stillWaiting is who is held by the event now: the open items linked to it,
 * unless it has occurred, when nothing is. An item stays linked to an event
 * that occurred — the dependency is history worth keeping — but it is not
 * waiting any more, and a count that said otherwise would read as a hold.
 */
export function stillWaiting(e: EventItem, waiting: ReadonlyMap<string, Task[]>): Task[] {
  return e.status === EventOccurred ? [] : (waiting.get(e.id) ?? []);
}

/** eventJSON is one event with the ids of the open items waiting for it. */
export function eventJSON(e: EventItem, waiting: ReadonlyMap<string, Task[]>): Record<string, unknown> {
  return { ...e.toJSON(), waiting: stillWaiting(e, waiting).map((t) => t.id) };
}

/** printEvents writes the human listing of events. */
export function printEvents(
  a: App,
  events: readonly EventItem[],
  waiting: ReadonlyMap<string, Task[]>,
  projects: ReadonlyMap<string, string> = new Map(),
): void {
  const rows = events.map((e) => ({
    id: id.Short(e.id, 8),
    status: e.status,
    title: e.title,
    project: e.projectID === '' ? '' : (projects.get(e.projectID) ?? id.Short(e.projectID, 8)),
    expected: e.expectedAt === undefined ? '' : formatTime(e.expectedAt).slice(0, 10),
    waiting: String(stillWaiting(e, waiting).length),
  }));
  const w = (key: 'id' | 'status' | 'title' | 'project'): number =>
    Math.max(...rows.map((r) => r[key].length), key.length);
  // The project column is left out when no event listed has one, so a list of
  // free events reads as it did.
  const withProject = rows.some((r) => r.project !== '');
  a.out.printf(
    `${'ID'.padEnd(w('id'))}  ${'STATUS'.padEnd(w('status'))}  ${'TITLE'.padEnd(w('title'))}  ${withProject ? `${'PROJECT'.padEnd(w('project'))}  ` : ''}EXPECTED    WAITING\n`,
  );
  for (const r of rows) {
    a.out.printf(
      `${r.id.padEnd(w('id'))}  ${r.status.padEnd(w('status'))}  ${r.title.padEnd(w('title'))}  ${withProject ? `${r.project.padEnd(w('project'))}  ` : ''}${r.expected.padEnd(10)}  ${r.waiting}\n`,
    );
  }
}

/**
 * projectTitles names the projects the events belong to, for the table: an id
 * is no way to read which project an event is about.
 */
export async function projectTitles(st: Store, events: readonly EventItem[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const e of events) {
    if (e.projectID === '' || out.has(e.projectID)) {
      continue;
    }
    try {
      out.set(e.projectID, (await st.get(e.projectID)).title);
    } catch {
      // A project that cannot be read is shown by its id.
    }
  }
  return out;
}


/**
 * projectEvents is the events that belong to a project, in either sense: it
 * was filed there, or an item inside the project waits for it. The second is
 * what puts an event where it matters when nobody filed it, and it needs
 * nothing stored: the links say it. An event that occurred is still the
 * project's, because its history is part of the project's.
 */
export async function projectEvents(st: Store, project: Task): Promise<EventItem[]> {
  const events = await st.events();
  if (events.length === 0) {
    return [];
  }
  const inside = new Set((await st.subtree(project.id)).map((t) => t.id));
  inside.delete(project.id);
  const waited = new Set((await st.waits()).filter((l) => inside.has(l.taskID)).map((l) => l.eventID));
  return events.filter((e) => e.projectID === project.id || waited.has(e.id));
}
