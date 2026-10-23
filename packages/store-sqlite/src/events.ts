// The event half of the provider: events, and the links from the tasks that
// wait for them. Written as functions over the store, like query.ts.
//
// Neither foreign key is relied on. A remote connection may have them off and
// the sqlite one is not guaranteed to have them on, so every delete here
// removes the links itself and every link is checked against both ends before
// it is written.

import { Normalize } from '@todocloud/core/id';
import {
  ErrAmbiguous,
  ErrBadParent,
  ErrExists,
  ErrNotFound,
} from '@todocloud/core/store';
import { EventItem, type EventLink } from '@todocloud/core/store/event';
import { formatTime, KindProject, parseTime } from '@todocloud/core/task';

import {
  type Bind,
  escapeLike,
  isUniqueViolation,
  parseOptionalTime,
  optionalTime,
  type Row,
  type Store,
  text,
} from './sqlite.ts';

const eventColumns = `id, title, project_id, note, expected_at, status, occurred_at, created_at, updated_at`;

/** rowToEvent decodes one row of the events table. */
export function rowToEvent(row: Row): EventItem {
  const e = new EventItem();
  e.id = text(row['id']) ?? '';
  e.title = text(row['title']) ?? '';
  e.projectID = text(row['project_id']) ?? '';
  e.note = text(row['note']) ?? '';
  e.expectedAt = parseOptionalTime(row['expected_at']);
  e.status = text(row['status']) ?? '';
  e.occurredAt = parseOptionalTime(row['occurred_at']);
  e.createdAt = parseTime(text(row['created_at']) ?? '');
  e.updatedAt = parseTime(text(row['updated_at']) ?? '');
  return e;
}

function eventArgs(e: EventItem): Bind[] {
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

function checked(s: Store, e: EventItem): void {
  const invalid = e.validate();
  if (invalid !== undefined) {
    throw new Error(`sqlite: ${e.id}: ${invalid.message}`, { cause: invalid });
  }
  if (e.projectID === '') {
    return;
  }
  // The project is checked here and not left to the foreign key: it must exist
  // and it must be a project, which no constraint says.
  let row: Row | undefined;
  try {
    row = s.db.one(`SELECT kind FROM tasks WHERE id = ?`, Normalize(e.projectID));
  } catch (err) {
    throw s.notInitialized(new Error(`sqlite: read project ${e.projectID}`, { cause: err }));
  }
  if (row === undefined) {
    throw new Error(`sqlite: project ${e.projectID}`, { cause: ErrNotFound });
  }
  if (text(row['kind']) !== KindProject) {
    throw new Error(`sqlite: ${e.projectID} is a ${text(row['kind']) ?? 'item'}, not a project`, {
      cause: ErrBadParent,
    });
  }
}

/** eventRows reads every event, oldest first. It is also what the tree reads. */
export function eventRows(s: Store): EventItem[] {
  let rows: Row[];
  try {
    rows = s.db.rows(`SELECT ${eventColumns} FROM events ORDER BY created_at, id`);
  } catch (err) {
    throw s.notInitialized(new Error('sqlite: read events', { cause: err }));
  }
  return rows.map(rowToEvent);
}

/** linkRows reads every link. */
export function linkRows(s: Store): EventLink[] {
  let rows: Row[];
  try {
    rows = s.db.rows(`SELECT task_id, event_id FROM task_events ORDER BY task_id, event_id`);
  } catch (err) {
    throw s.notInitialized(new Error('sqlite: read event links', { cause: err }));
  }
  return rows.map((r) => ({
    taskID: text(r['task_id']) ?? '',
    eventID: text(r['event_id']) ?? '',
  }));
}

export async function addEvent(s: Store, e: EventItem): Promise<void> {
  checked(s, e);
  const q = `INSERT INTO events (${eventColumns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const item = e.clone();
  item.id = Normalize(item.id);
  item.projectID = Normalize(item.projectID);
  try {
    s.db.run(q, ...eventArgs(item));
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new Error(`sqlite: event ${e.id}`, { cause: ErrExists });
    }
    throw s.notInitialized(new Error(`sqlite: add event ${e.id}`, { cause: err }));
  }
}

export async function getEvent(s: Store, ref: string): Promise<EventItem> {
  const id = Normalize(ref);
  let row: Row | undefined;
  try {
    row = s.db.one(`SELECT ${eventColumns} FROM events WHERE id = ?`, id);
  } catch (err) {
    throw s.notInitialized(new Error(`sqlite: get event ${ref}`, { cause: err }));
  }
  if (row === undefined) {
    throw new Error(`sqlite: event ${ref}`, { cause: ErrNotFound });
  }
  return rowToEvent(row);
}

export async function findEventByPrefix(s: Store, prefix: string): Promise<EventItem> {
  const p = Normalize(prefix);
  let rows: Row[];
  try {
    rows = s.db.rows(
      `SELECT ${eventColumns} FROM events WHERE id LIKE ? ESCAPE '\\' ORDER BY id LIMIT 2`,
      `${escapeLike(p)}%`,
    );
  } catch (err) {
    throw s.notInitialized(new Error(`sqlite: find event ${prefix}`, { cause: err }));
  }
  if (rows.length > 1) {
    throw new Error(`sqlite: event ${prefix}`, { cause: ErrAmbiguous });
  }
  const first = rows[0];
  if (first === undefined) {
    throw new Error(`sqlite: event ${prefix}`, { cause: ErrNotFound });
  }
  return rowToEvent(first);
}

export async function events(s: Store): Promise<EventItem[]> {
  return eventRows(s);
}

export async function updateEvent(s: Store, e: EventItem): Promise<void> {
  checked(s, e);
  const item = e.clone();
  item.id = Normalize(item.id);
  item.projectID = Normalize(item.projectID);
  const q = `UPDATE events SET title = ?, project_id = ?, note = ?, expected_at = ?, status = ?,
	           occurred_at = ?, updated_at = ? WHERE id = ?`;
  const a = eventArgs(item);
  let changed: number;
  try {
    // id and created_at are not changed by an update.
    changed = s.db.run(q, a[1] as Bind, a[2] as Bind, a[3] as Bind, a[4] as Bind, a[5] as Bind, a[6] as Bind, a[8] as Bind, item.id);
  } catch (err) {
    throw s.notInitialized(new Error(`sqlite: update event ${e.id}`, { cause: err }));
  }
  if (changed === 0) {
    throw new Error(`sqlite: event ${e.id}`, { cause: ErrNotFound });
  }
}

export async function removeEvent(s: Store, ref: string): Promise<number> {
  const id = Normalize(ref);
  return s.transaction('remove event', () => {
    let links: number;
    let changed: number;
    try {
      links = s.db.run(`DELETE FROM task_events WHERE event_id = ?`, id);
      changed = s.db.run(`DELETE FROM events WHERE id = ?`, id);
    } catch (err) {
      throw s.notInitialized(new Error(`sqlite: remove event ${ref}`, { cause: err }));
    }
    if (changed === 0) {
      throw new Error(`sqlite: event ${ref}`, { cause: ErrNotFound });
    }
    return links;
  });
}

/**
 * setWaits replaces the set of events a task waits for. Both ends are checked
 * before anything is written, so a reference that means nothing leaves the
 * task's links exactly as they were.
 */
export async function setWaits(
  s: Store,
  taskRef: string,
  eventRefs: readonly string[],
): Promise<void> {
  const taskID = Normalize(taskRef);
  const ids = [...new Set(eventRefs.map((r) => Normalize(r)))];
  s.transaction('set waits', () => {
    try {
      if (s.db.one(`SELECT 1 AS x FROM tasks WHERE id = ?`, taskID) === undefined) {
        throw new Error(`sqlite: task ${taskRef}`, { cause: ErrNotFound });
      }
      for (const id of ids) {
        if (s.db.one(`SELECT 1 AS x FROM events WHERE id = ?`, id) === undefined) {
          throw new Error(`sqlite: event ${id}`, { cause: ErrNotFound });
        }
      }
      s.db.run(`DELETE FROM task_events WHERE task_id = ?`, taskID);
      for (const id of ids) {
        s.db.run(`INSERT INTO task_events (task_id, event_id) VALUES (?, ?)`, taskID, id);
      }
    } catch (err) {
      if (err instanceof Error && err.cause === ErrNotFound) {
        throw err;
      }
      throw s.notInitialized(new Error(`sqlite: set waits of ${taskRef}`, { cause: err }));
    }
  });
}

export async function waits(s: Store): Promise<EventLink[]> {
  return linkRows(s);
}

/**
 * detachEvents lets go of the events a project owned when the project is
 * purged: they become events of no project, still waited for. Deleting them
 * instead would silently free items that live elsewhere and wait for them.
 */
export function detachEvents(s: Store, projectID: string): void {
  s.db.run(`UPDATE events SET project_id = NULL WHERE project_id = ?`, projectID);
}
