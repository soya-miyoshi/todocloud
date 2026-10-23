// Events: things that happen outside the list, and the items that wait on
// them.
//
// An event is not a task. A task is something you do and complete; an event
// is something you wait for, and it *occurs*. So it has a table of its own,
// with a state of its own — pending, occurred or cancelled — and no
// pretence of the columns that only mean something for work: no parent, no
// order, no repeat, no estimate. This is the shape tags already have: a row
// with a status, joined to the tasks it affects.
//
// What an event does to the items that wait on it is not stored anywhere. A
// task is blocked while an event it waits for has not occurred, and that is
// computed with every other availability rule (`Tree.setEvents`), so there is
// nothing to push when an event changes: the next read of the task is the
// callback.

import type { JSONObject, JSONValue } from '../task.ts';
import { formatTime, isZeroTime, parseTime, zeroTime } from '../task.ts';

/**
 * EventStatus is where an event stands. Like Status and Kind it is a string,
 * so a value written by something else is rejected by validation rather than
 * by the type system.
 */
export type EventStatus = 'pending' | 'occurred' | 'cancelled' | (string & {});

/** EventPending has not happened yet; whatever waits on it stays blocked. */
export const EventPending: EventStatus = 'pending';
/** EventOccurred has happened; whatever waited on it is released. */
export const EventOccurred: EventStatus = 'occurred';
/**
 * EventCancelled will not happen. It does not release what waits on it: the
 * reason for waiting is unresolved, not satisfied, and lifting the hold would
 * offer work that still cannot be done. The block names the event, and the
 * way out is to unlink it or to say it occurred.
 */
export const EventCancelled: EventStatus = 'cancelled';

/** eventStatusValid reports whether s is one of the three statuses. */
export function eventStatusValid(s: EventStatus): boolean {
  return s === EventPending || s === EventOccurred || s === EventCancelled;
}

/** EventStatuses returns the three statuses. */
export function EventStatuses(): EventStatus[] {
  return [EventPending, EventOccurred, EventCancelled];
}

/** ErrEmptyEventTitle is returned by validate when the title is blank. */
export const ErrEmptyEventTitle = new Error('an event needs a title');

/** EventItem is one event. */
export class EventItem {
  id = '';
  title = '';
  /**
   * projectID is the project the event belongs to, or empty for one that
   * belongs to none. An event is about something in the plan — a vendor's
   * reply on the launch, a sign-off on the migration — and the project's own
   * view lists it. It is only a place to look: it changes nothing about what
   * waits for the event, which is the links' business.
   */
  projectID = '';
  note = '';
  /** expectedAt is when it is expected, if anyone knows. It decides nothing. */
  expectedAt: Date | undefined = undefined;
  status: EventStatus = EventPending;
  /** occurredAt is set when the event occurs and cleared when it is reopened. */
  occurredAt: Date | undefined = undefined;
  createdAt: Date = zeroTime();
  updatedAt: Date = zeroTime();

  /** clone returns a deep copy. */
  clone(): EventItem {
    const c = new EventItem();
    c.id = this.id;
    c.title = this.title;
    c.projectID = this.projectID;
    c.note = this.note;
    c.expectedAt = this.expectedAt === undefined ? undefined : new Date(this.expectedAt.getTime());
    c.status = this.status;
    c.occurredAt = this.occurredAt === undefined ? undefined : new Date(this.occurredAt.getTime());
    c.createdAt = new Date(this.createdAt.getTime());
    c.updatedAt = new Date(this.updatedAt.getTime());
    return c;
  }

  /** validate returns the first invariant that fails, or undefined. */
  validate(): Error | undefined {
    if (this.title.trim() === '') {
      return ErrEmptyEventTitle;
    }
    if (this.id === '') {
      return new Error('id must not be empty');
    }
    if (!eventStatusValid(this.status)) {
      return new Error(
        `event status ${JSON.stringify(this.status)} is not one of pending, occurred or cancelled`,
      );
    }
    if (isZeroTime(this.createdAt) || isZeroTime(this.updatedAt)) {
      return new Error('created_at and updated_at must be set');
    }
    if (this.projectID === this.id) {
      return new Error('an event cannot be its own project');
    }
    if (this.status === EventOccurred && this.occurredAt === undefined) {
      return new Error('an occurred event must say when it occurred');
    }
    if (this.status !== EventOccurred && this.occurredAt !== undefined) {
      return new Error('only an occurred event has an occurred_at');
    }
    return undefined;
  }

  /**
   * setStatus moves the event to s and keeps occurred_at consistent with it.
   * Setting the status it already has changes nothing, so a repeated
   * `tdo event occur` does not move occurred_at.
   */
  setStatus(s: EventStatus, now: Date): void {
    if (s === this.status) {
      return;
    }
    this.status = s;
    this.occurredAt = s === EventOccurred ? new Date(now.getTime()) : undefined;
    this.updatedAt = new Date(now.getTime());
  }

  /** toJSON renders the documented shape, keys in sorted order. */
  toJSON(): JSONObject {
    const time = (v: Date | undefined): JSONValue => (v === undefined ? null : formatTime(v));
    return {
      created_at: formatTime(this.createdAt),
      expected_at: time(this.expectedAt),
      id: this.id,
      note: this.note === '' ? null : this.note,
      occurred_at: time(this.occurredAt),
      project_id: this.projectID === '' ? null : this.projectID,
      status: this.status,
      title: this.title,
      updated_at: formatTime(this.updatedAt),
    };
  }
}

/** newEvent builds a pending event stamped with now. */
export function newEvent(id: string, title: string, now: Date): EventItem {
  const e = new EventItem();
  e.id = id;
  e.title = title;
  e.createdAt = new Date(now.getTime());
  e.updatedAt = new Date(now.getTime());
  return e;
}

/** EventLink says that a task waits for an event. */
export interface EventLink {
  taskID: string;
  eventID: string;
}

/**
 * eventFromJSON reads the shape `toJSON` writes, which is what `tdo export`
 * carries. It is strict about types, because an import file is untrusted: a
 * value of the wrong kind is an error naming the key and not a silent default.
 * It does not validate the event; the caller does, with the position of the
 * entry in hand.
 */
export function eventFromJSON(raw: unknown): EventItem {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('an event must be a JSON object');
  }
  const o = raw as Record<string, unknown>;
  const str = (key: string): string => {
    const v = o[key];
    if (v === undefined || v === null) {
      return '';
    }
    if (typeof v !== 'string') {
      throw new Error(`event key ${JSON.stringify(key)} must be a string`);
    }
    return v;
  };
  const time = (key: string): Date | undefined => {
    const v = str(key);
    return v === '' ? undefined : parseTime(v);
  };
  const e = new EventItem();
  e.id = str('id');
  e.title = str('title');
  e.projectID = str('project_id');
  e.note = str('note');
  e.expectedAt = time('expected_at');
  e.status = str('status') === '' ? EventPending : str('status');
  e.occurredAt = time('occurred_at');
  e.createdAt = time('created_at') ?? zeroTime();
  e.updatedAt = time('updated_at') ?? zeroTime();
  return e;
}
