// The event half of the provider: events, and the links from the tasks that
// wait for them. The sqlite provider's events.ts, over the wire.
//
// There is no transaction over the wire, so each operation that must not be
// half-done reads first and writes second: every reference is checked before
// a single write goes up, and a write that has several parts travels as one
// pipeline. Neither foreign key is relied on; every delete removes the links
// itself.

import * as id from '@todocloud/core/id';
import { ErrAmbiguous, ErrBadParent, ErrExists, ErrNotFound } from '@todocloud/core/store';
import { EventItem, type EventLink } from '@todocloud/core/store/event';
import { formatTime, KindProject, parseTime } from '@todocloud/core/task';

import type { Arg, ExecuteResult, Value } from './protocol.ts';
import {
  Batch,
  escapeLike,
  isUniqueViolation,
  messageOf,
  optionalColumn,
  optionalText,
  optionalTime,
  text,
  type Store,
} from './turso.ts';

export const eventColumns = `id, title, project_id, note, expected_at, status, occurred_at, created_at, updated_at`;
export const eventRowsSQL = `SELECT ${eventColumns} FROM events ORDER BY created_at, id`;
export const linkRowsSQL = `SELECT task_id, event_id FROM task_events ORDER BY task_id, event_id`;

/** scanEvent decodes one row of the events table. */
export function scanEvent(row: readonly Value[]): EventItem {
  if (row.length !== 9) {
    throw new Error(`an event row came back with ${row.length} column(s), want 9`);
  }
  const e = new EventItem();
  e.id = text(row[0] as Value, 'id');
  e.title = text(row[1] as Value, 'title');
  e.projectID = optionalText(row[2] as Value, 'project_id');
  e.note = optionalText(row[3] as Value, 'note');
  e.expectedAt = optionalColumn(row[4] as Value, 'expected_at');
  e.status = text(row[5] as Value, 'status');
  e.occurredAt = optionalColumn(row[6] as Value, 'occurred_at');
  e.createdAt = parseTime(text(row[7] as Value, 'created_at'));
  e.updatedAt = parseTime(text(row[8] as Value, 'updated_at'));
  return e;
}

/** scanEvents reads the events out of a result. */
export function scanEvents(res: ExecuteResult): EventItem[] {
  return res.rows.map((row) => scanEvent(row));
}

/** scanLinks reads the links out of a result. */
export function scanLinks(res: ExecuteResult): EventLink[] {
  return res.rows.map((row) => {
    if (row.length !== 2) {
      throw new Error(`a link row came back with ${row.length} column(s), want 2`);
    }
    return {
      taskID: text(row[0] as Value, 'task_id'),
      eventID: text(row[1] as Value, 'event_id'),
    };
  });
}

function eventArgs(e: EventItem): Arg[] {
  return [
    e.id,
    e.title,
    e.projectID === '' ? null : e.projectID,
    e.note === '' ? null : e.note,
    optionalTime(e.expectedAt),
    e.status,
    optionalTime(e.occurredAt),
    formatTime(e.createdAt),
    formatTime(e.updatedAt),
  ];
}

function normalized(e: EventItem, op: string): EventItem {
  const item = e.clone();
  item.id = id.Normalize(item.id);
  item.projectID = id.Normalize(item.projectID);
  const invalid = item.validate();
  if (invalid !== undefined) {
    throw new Error(`turso: ${op} ${item.id}: ${invalid.message}`, { cause: invalid });
  }
  return item;
}

function notFound(what: string): Error {
  return new Error(`turso: ${what}: ${ErrNotFound.message}`, { cause: ErrNotFound });
}

/**
 * checkProject reads the project an event names: it must exist and it must be
 * a project. There is no transaction over the wire, so it is read first and the
 * write follows; no constraint says "is a project" anyway.
 */
async function checkProject(s: Store, e: EventItem): Promise<void> {
  if (e.projectID === '') {
    return;
  }
  let res: ExecuteResult;
  try {
    res = await s.exec(`SELECT kind FROM tasks WHERE id = ?`, true, e.projectID);
  } catch (err) {
    throw s.wrap(err, 'read project ' + e.projectID);
  }
  const row = res.rows[0];
  if (row === undefined) {
    throw notFound(`project ${e.projectID}`);
  }
  const kind = text(row[0] as Value, 'kind');
  if (kind !== KindProject) {
    throw new Error(`turso: ${e.projectID} is a ${kind}, not a project`, { cause: ErrBadParent });
  }
}

export async function addEvent(s: Store, e: EventItem): Promise<void> {
  const item = normalized(e, 'add event');
  await checkProject(s, item);
  const q = `INSERT INTO events (${eventColumns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  try {
    await s.exec(q, false, ...eventArgs(item));
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new Error(`turso: event ${item.id}: ${ErrExists.message}`, { cause: ErrExists });
    }
    throw s.wrap(err, 'add event ' + item.id);
  }
}

export async function getEvent(s: Store, ref: string): Promise<EventItem> {
  const want = id.Normalize(ref);
  let res: ExecuteResult;
  try {
    res = await s.exec(`SELECT ${eventColumns} FROM events WHERE id = ?`, true, want);
  } catch (err) {
    throw s.wrap(err, 'get event ' + ref);
  }
  const row = res.rows[0];
  if (row === undefined) {
    throw notFound(`event ${ref}`);
  }
  try {
    return scanEvent(row);
  } catch (err) {
    throw new Error(`turso: get event ${ref}: ${messageOf(err)}`, { cause: err });
  }
}

export async function findEventByPrefix(s: Store, prefix: string): Promise<EventItem> {
  const p = id.Normalize(prefix);
  let res: ExecuteResult;
  try {
    res = await s.exec(
      `SELECT ${eventColumns} FROM events WHERE id LIKE ? ESCAPE '\\' ORDER BY id LIMIT 2`,
      true,
      `${escapeLike(p)}%`,
    );
  } catch (err) {
    throw s.wrap(err, 'find event ' + prefix);
  }
  if (res.rows.length > 1) {
    throw new Error(`turso: event ${prefix}: ${ErrAmbiguous.message}`, { cause: ErrAmbiguous });
  }
  const row = res.rows[0];
  if (row === undefined) {
    throw notFound(`event ${prefix}`);
  }
  return scanEvent(row);
}

export async function events(s: Store): Promise<EventItem[]> {
  let res: ExecuteResult;
  try {
    res = await s.exec(eventRowsSQL, true);
  } catch (err) {
    throw s.wrap(err, 'list events');
  }
  try {
    return scanEvents(res);
  } catch (err) {
    throw new Error(`turso: list events: ${messageOf(err)}`, { cause: err });
  }
}

export async function updateEvent(s: Store, e: EventItem): Promise<void> {
  const item = normalized(e, 'update event');
  // Existence is checked first: an UPDATE that matches nothing is not an
  // error on the wire, and "no such event" must not look like success.
  await getEvent(s, item.id);
  await checkProject(s, item);
  const a = eventArgs(item);
  const q = `UPDATE events SET title = ?, project_id = ?, note = ?, expected_at = ?, status = ?,
	           occurred_at = ?, updated_at = ? WHERE id = ?`;
  try {
    await s.exec(q, false, a[1] as Arg, a[2] as Arg, a[3] as Arg, a[4] as Arg, a[5] as Arg, a[6] as Arg, a[8] as Arg, item.id);
  } catch (err) {
    throw s.wrap(err, 'update event ' + item.id);
  }
}

export async function removeEvent(s: Store, ref: string): Promise<number> {
  const want = id.Normalize(ref);
  const b = new Batch();
  b.add(`SELECT COUNT(*) FROM events WHERE id = ?`, true, want);
  b.add(`SELECT COUNT(*) FROM task_events WHERE event_id = ?`, true, want);
  let res: ExecuteResult[];
  try {
    res = await s.send(b);
  } catch (err) {
    throw s.wrap(err, 'remove event ' + ref);
  }
  const count = (r: ExecuteResult | undefined): number => {
    const v = r?.rows[0]?.[0];
    return v === undefined ? 0 : Number(v.text() ?? 0);
  };
  if (count(res[0]) === 0) {
    throw notFound(`event ${ref}`);
  }
  const links = count(res[1]);
  const w = new Batch();
  w.add(`DELETE FROM task_events WHERE event_id = ?`, false, want);
  w.add(`DELETE FROM events WHERE id = ?`, false, want);
  try {
    await s.send(w);
  } catch (err) {
    throw s.wrap(err, 'remove event ' + ref);
  }
  return links;
}

/**
 * setWaits replaces the set of events a task waits for. Both ends are read
 * and checked first, so a reference that means nothing leaves the links as
 * they were; the replacement itself is one pipeline.
 */
export async function setWaits(
  s: Store,
  taskRef: string,
  eventRefs: readonly string[],
): Promise<void> {
  const taskID = id.Normalize(taskRef);
  const ids = [...new Set(eventRefs.map((r) => id.Normalize(r)))];

  const check = new Batch();
  check.add(`SELECT id FROM tasks WHERE id = ?`, true, taskID);
  for (const e of ids) {
    check.add(`SELECT id FROM events WHERE id = ?`, true, e);
  }
  let res: ExecuteResult[];
  try {
    res = await s.send(check);
  } catch (err) {
    throw s.wrap(err, 'set waits of ' + taskRef);
  }
  if ((res[0] as ExecuteResult).rows.length === 0) {
    throw notFound(`task ${taskRef}`);
  }
  for (let i = 0; i < ids.length; i++) {
    if ((res[i + 1] as ExecuteResult).rows.length === 0) {
      throw notFound(`event ${ids[i]}`);
    }
  }

  const b = new Batch();
  b.add(`DELETE FROM task_events WHERE task_id = ?`, false, taskID);
  for (const e of ids) {
    b.add(`INSERT INTO task_events (task_id, event_id) VALUES (?, ?)`, false, taskID, e);
  }
  try {
    await s.send(b);
  } catch (err) {
    throw s.wrap(err, 'set waits of ' + taskRef);
  }
}

export async function waits(s: Store): Promise<EventLink[]> {
  let res: ExecuteResult;
  try {
    res = await s.exec(linkRowsSQL, true);
  } catch (err) {
    throw s.wrap(err, 'read event links');
  }
  try {
    return scanLinks(res);
  } catch (err) {
    throw new Error(`turso: read event links: ${messageOf(err)}`, { cause: err });
  }
}
