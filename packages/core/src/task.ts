// Module task defines the data model shared by every provider.
//
// A task has a set of required fields, which are real columns on SQL
// providers and real document fields on Firestore, plus Fields: an open map of
// user-defined values that the CLI carries through untouched. Required fields
// are typed; everything else is JSON. That split is what lets one schema serve
// users who want a plain checklist and users who want a dozen attributes per
// task, without a migration for every new attribute.
//
// The model is the GTD one described in PLAN.md §3: folders, projects and
// actions are one shape with a kind, containment is a single parent edge, and
// four statuses replace the boolean "done" so that "not now" and "decided
// against" are distinguishable from "finished".
//
// Port notes, where TypeScript cannot hold the Go shape exactly:
//
//   - Go returns `(value, ok)`; every accessor here returns `undefined` for
//     the not-ok case instead, which is the same information in one value.
//   - Go's `error` return is kept only for `Task.validate`, which answers a
//     question and so returns `Error | undefined`. The parsers throw,
//     because a malformed timestamp is not an answer.
//   - Go distinguishes `int` from `float64`; JavaScript has one number type.
//     Everywhere the Go code decides between them — `Fields.normalize`,
//     `normalizeValue`, `parseValue` — the decision collapses and the
//     comments say what it was for.
//   - This module must run in a browser as well as in Node, so it imports
//     nothing. Node builtins appear in the tests only.

/** A value that survived `JSON.parse`, which is all a user-defined field holds. */
export type JSONValue =
  | null
  | boolean
  | number
  | string
  | JSONValue[]
  | { [key: string]: JSONValue };

/** A JSON object, the shape `Task.toJSON` produces and `taskFromJSON` reads. */
export type JSONObject = { [key: string]: JSONValue };

// Reserved keys are the required fields plus the keys the JSON representation
// derives. A user-defined field may not use one of these names, because the
// JSON output flattens Fields alongside them and a collision would make the
// required field unreadable.
export const KeyID = 'id';
export const KeyKind = 'kind';
export const KeyTitle = 'title';
export const KeyParentID = 'parent_id';
export const KeyPosition = 'position';
export const KeyStatus = 'status';
export const KeyFlagged = 'flagged';
export const KeySequential = 'sequential';
export const KeyCompletedByChildren = 'completed_by_children';
export const KeyDeferAt = 'defer_at';
export const KeyDueAt = 'due_at';
export const KeyEstimatedMinutes = 'estimated_minutes';
export const KeyNote = 'note';
export const KeyRepeat = 'repeat';
export const KeySeriesID = 'series_id';
export const KeyReviewInterval = 'review_interval';
export const KeyLastReviewedAt = 'last_reviewed_at';
export const KeyCreatedAt = 'created_at';
export const KeyUpdatedAt = 'updated_at';
export const KeyCompletedAt = 'completed_at';
export const KeyDroppedAt = 'dropped_at';
export const KeyDeletedAt = 'deleted_at';
export const KeyTags = 'tags';

// Derived keys are not stored. They are computed on the way out, and they are
// reserved for the same reason the stored ones are: a user-defined field of
// the same name would be shadowed by the computed value in --json, which is
// a silent loss rather than an error.

/** KeyDone is status === StatusDone, kept so the common case stays one key. */
export const KeyDone = 'done';
/**
 * KeyAvailable and KeyBlockedBy are written by `tdo ls --json`; see
 * store.Availability.
 */
export const KeyAvailable = 'available';
export const KeyBlockedBy = 'blocked_by';
export const KeyNextReview = 'next_review_at';

// Well-known keys live in Fields but have dedicated flags and a documented
// place in the JSON output, so they are always present in it. Priority is not
// part of the GTD model — OmniFocus has flagged, not a priority number — but
// `tdo add --priority` predates it and users have it in their fingers, so it
// survives as an ordinary open field with a guaranteed key.
export const KeyPriority = 'priority';

const reserved = new Set<string>([
  KeyID,
  KeyKind,
  KeyTitle,
  KeyParentID,
  KeyPosition,
  KeyStatus,
  KeyFlagged,
  KeySequential,
  KeyCompletedByChildren,
  KeyDeferAt,
  KeyDueAt,
  KeyEstimatedMinutes,
  KeyNote,
  KeyRepeat,
  KeySeriesID,
  KeyReviewInterval,
  KeyLastReviewedAt,
  KeyCreatedAt,
  KeyUpdatedAt,
  KeyCompletedAt,
  KeyDroppedAt,
  KeyDeletedAt,
  KeyTags,
  KeyDone,
  KeyAvailable,
  KeyBlockedBy,
  KeyNextReview,
]);

/**
 * Reserved reports whether key is a required or derived field name and
 * therefore not available as a user-defined field.
 */
export function Reserved(key: string): boolean {
  return reserved.has(key);
}

/** ReservedKeys returns the reserved names, sorted. */
export function ReservedKeys(): string[] {
  return [...reserved].sort(compareStrings);
}

// Go's sort.Strings orders by byte value. JavaScript's default sort compares
// UTF-16 code units via toString, which agrees for every key the model uses,
// but an explicit comparator keeps that from depending on the default.
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Kind is what a node of the tree is. Folders, projects and actions are the
 * same shape; the kind is what decides where a node may sit and whether it is
 * actionable.
 *
 * It is a string, not a union of the three, for the same reason Go's `Kind` is
 * a defined string type: a document written by a newer binary, or by hand, can
 * carry anything, and `kindValid` is where that is caught. The literals are
 * listed so an editor still suggests them.
 */
export type Kind = 'folder' | 'project' | 'task' | (string & {});

/**
 * KindFolder organises. It may contain folders and projects, is never
 * actionable, and is never completed.
 */
export const KindFolder: Kind = 'folder';
/** KindProject is an outcome. It contains tasks and is completable. */
export const KindProject: Kind = 'project';
/**
 * KindTask is an action. It may contain tasks, which makes it an action
 * group, and a task with no parent is in the inbox.
 */
export const KindTask: Kind = 'task';

/** kindValid reports whether k is one of the three kinds. */
export function kindValid(k: Kind): boolean {
  return k === KindFolder || k === KindProject || k === KindTask;
}

/** Kinds returns the three kinds in the order the tree nests them. */
export function Kinds(): Kind[] {
  return [KindFolder, KindProject, KindTask];
}

/**
 * kindCanContain reports whether a node of kind k may be the parent of a node
 * of kind child. It is the table in PLAN.md §3.1, and the store enforces it:
 * a broken tree is worse than a rejected command.
 */
export function kindCanContain(k: Kind, child: Kind): boolean {
  switch (k) {
    case KindFolder:
      return child === KindFolder || child === KindProject;
    case KindProject:
      return child === KindTask;
    case KindTask:
      return child === KindTask;
  }
  return false;
}

/**
 * Status is where an item stands. Four states are needed because GTD
 * distinguishes "not now" from "never, but remember I decided that", and both
 * from "finished".
 *
 * Like Kind, it is a string so that an unknown value read from a provider is
 * rejected by validation rather than by the type system.
 */
export type Status = 'active' | 'on_hold' | 'done' | 'dropped' | (string & {});

/** StatusActive is the ordinary state. */
export const StatusActive: Status = 'active';
/**
 * StatusOnHold is paused: it and everything under it drop out of every
 * list until it is active again. That is the whole point of a hold.
 */
export const StatusOnHold: Status = 'on_hold';
/** StatusDone is finished. */
export const StatusDone: Status = 'done';
/**
 * StatusDropped is abandoned on purpose, and kept so the decision is not
 * made again.
 */
export const StatusDropped: Status = 'dropped';

/** statusValid reports whether s is one of the four statuses. */
export function statusValid(s: Status): boolean {
  return (
    s === StatusActive || s === StatusOnHold || s === StatusDone || s === StatusDropped
  );
}

/**
 * statusClosed reports whether the status means the item needs no more
 * attention. A sequential container skips over its closed children when
 * deciding which child is next.
 */
export function statusClosed(s: Status): boolean {
  return s === StatusDone || s === StatusDropped;
}

/** Statuses returns the four statuses. */
export function Statuses(): Status[] {
  return [StatusActive, StatusOnHold, StatusDone, StatusDropped];
}

/**
 * RepeatMethod is what the next instance's dates are computed from. The three
 * are OmniFocus's three; see PLAN.md §3.4.
 */
export type RepeatMethod = 'fixed' | 'from_completion' | 'defer_another' | (string & {});

/**
 * RepeatFixed advances from the previous instance's own dates, so a
 * schedule kept this way can fall behind.
 */
export const RepeatFixed: RepeatMethod = 'fixed';
/** RepeatFromCompletion advances from the moment of completion. */
export const RepeatFromCompletion: RepeatMethod = 'from_completion';
/**
 * RepeatDeferAnother advances from the moment of completion and moves
 * only defer_at, leaving the due date where it was.
 */
export const RepeatDeferAnother: RepeatMethod = 'defer_another';

/** repeatMethodValid reports whether m is one of the three methods. */
export function repeatMethodValid(m: RepeatMethod): boolean {
  return m === RepeatFixed || m === RepeatFromCompletion || m === RepeatDeferAnother;
}

/**
 * Repeat describes a repeating item. `every` is a duration-with-calendar
 * spelling ("3d", "2w", "1mo", "1y", "1mo:last-friday"); the recur module
 * parses it and computes the successor. This module keeps the value as written
 * so that a spelling a newer binary understands survives an older one's round
 * trip untouched.
 */
export interface Repeat {
  method: RepeatMethod;
  every: string;
}

/** cloneRepeat returns a copy, or undefined for undefined. */
export function cloneRepeat(r: Repeat | undefined): Repeat | undefined {
  return r === undefined ? undefined : { method: r.method, every: r.every };
}

/** repeatEqual reports whether two repeats describe the same schedule. */
export function repeatEqual(r: Repeat | undefined, other: Repeat | undefined): boolean {
  if (r === undefined || other === undefined) {
    return r === other;
  }
  return r.method === other.method && r.every === other.every;
}

/**
 * ReviewInterval is how often a folder or project should be looked at.
 * next_review_at is derived from last_reviewed_at plus `every` rather than
 * stored, so it cannot drift out of sync with either.
 */
export interface ReviewInterval {
  every: string;
}

/** cloneReviewInterval returns a copy, or undefined for undefined. */
export function cloneReviewInterval(
  r: ReviewInterval | undefined,
): ReviewInterval | undefined {
  return r === undefined ? undefined : { every: r.every };
}

/** reviewIntervalEqual reports whether two intervals are the same. */
export function reviewIntervalEqual(
  r: ReviewInterval | undefined,
  other: ReviewInterval | undefined,
): boolean {
  if (r === undefined || other === undefined) {
    return r === other;
  }
  return r.every === other.every;
}

/**
 * Fields holds the user-defined part of a task.
 *
 * Its values come from JSON, so a number may arrive as a string from a
 * provider that writes integers that way. The accessors on the `Fields`
 * namespace below are the only place that variance is handled: nothing outside
 * this module should narrow a field value by hand, which keeps `JSONValue` out
 * of the command layer.
 */
export type Fields = { [key: string]: JSONValue };

/** newFields returns an empty field map. */
export function newFields(from?: Fields): Fields {
  return from === undefined ? {} : { ...from };
}

function cloneValue(v: JSONValue): JSONValue {
  if (Array.isArray(v)) {
    return v.map(cloneValue);
  }
  if (isPlainObject(v)) {
    const out: JSONObject = {};
    for (const [k, e] of Object.entries(v)) {
      out[k] = cloneValue(e);
    }
    return out;
  }
  return v;
}

function isPlainObject(v: JSONValue): v is JSONObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Go's strconv.Atoi: an optional sign and decimal digits, nothing else.
const integerText = /^[+-]?\d+$/;
// Go's strconv.ParseFloat, restricted to the decimal forms. The hex-float and
// "Infinity"/"NaN" spellings Go also accepts are excluded here on purpose:
// non-finite values cannot be stored, and parseValue keeps them as text.
const floatText = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * normalizeValue is where Go converts a JSON number into the canonical Go
 * type — `int` where the value is whole and inside int64's range, `float64`
 * otherwise — so that a task read from a provider compares equal to one built
 * in memory.
 *
 * JavaScript has one number type, so there is nothing left to convert and the
 * guarantee holds for free: a number parsed out of JSON is already identical
 * to the one that was written. The recursion into arrays and objects is kept
 * so the function stays total over JSONValue and so the shape of the Go code
 * survives for whoever reads both.
 */
function normalizeValue(v: JSONValue): JSONValue {
  if (Array.isArray(v)) {
    return v.map(normalizeValue);
  }
  if (isPlainObject(v)) {
    const out: JSONObject = {};
    for (const [k, e] of Object.entries(v)) {
      out[k] = normalizeValue(e);
    }
    return out;
  }
  return v;
}

/**
 * The accessors over a field map. They are free functions rather than methods
 * because `Fields` is a plain object, so a map decoded straight out of JSON is
 * already one; `Fields.int(f, k)` reads as Go's `f.Int(k)` does.
 */
export const Fields = {
  /** clone returns a deep copy. */
  clone(f: Fields): Fields {
    const out: Fields = {};
    for (const [k, v] of Object.entries(f)) {
      out[k] = cloneValue(v);
    }
    return out;
  },

  /** keys returns the field names, sorted, so output is deterministic. */
  keys(f: Fields): string[] {
    return Object.keys(f).sort(compareStrings);
  },

  /** set stores a value, removing the key when value is null or undefined. */
  set(f: Fields, key: string, value: JSONValue | undefined): void {
    if (value === null || value === undefined) {
      delete f[key];
      return;
    }
    f[key] = value;
  },

  /** delete removes a key. */
  delete(f: Fields, key: string): void {
    delete f[key];
  },

  /**
   * string returns a string field, or undefined when the key is absent or
   * holds a non-string.
   */
  string(f: Fields, key: string): string | undefined {
    const v = f[key];
    return typeof v === 'string' ? v : undefined;
  },

  /**
   * int returns an integer field, accepting every numeric form JSON can
   * produce, or undefined when the value is not one.
   */
  int(f: Fields, key: string): number | undefined {
    const v = f[key];
    if (typeof v === 'number') {
      // Go converts float64 to int, which truncates toward zero.
      return Number.isFinite(v) ? Math.trunc(v) : undefined;
    }
    if (typeof v === 'string') {
      // Firestore returns integers as strings over REST.
      return integerText.test(v) ? Number(v) : undefined;
    }
    return undefined;
  },

  /** bool returns a boolean field, or undefined when the value is not one. */
  bool(f: Fields, key: string): boolean | undefined {
    const v = f[key];
    if (typeof v === 'boolean') {
      return v;
    }
    if (typeof v === 'string') {
      // The spellings Go's strconv.ParseBool accepts, and only those.
      if (v === '1' || v === 't' || v === 'T' || v === 'true' || v === 'TRUE' || v === 'True') {
        return true;
      }
      if (
        v === '0' ||
        v === 'f' ||
        v === 'F' ||
        v === 'false' ||
        v === 'FALSE' ||
        v === 'False'
      ) {
        return false;
      }
    }
    return undefined;
  },

  /**
   * strings returns a string-list field. A single string is treated as a
   * one-element list, because that is what a hand-edited document often holds.
   * An empty string is an empty list; Go returned `(nil, true)` there, which
   * has no `undefined`-shaped equivalent that still means "yes, a list".
   */
  strings(f: Fields, key: string): string[] | undefined {
    const v = f[key];
    if (typeof v === 'string') {
      return v === '' ? [] : [v];
    }
    if (Array.isArray(v)) {
      return v.map((e) => (typeof e === 'string' ? e : stringify(e)));
    }
    return undefined;
  },

  /**
   * normalize converts values into the canonical forms this module stores, so
   * a task read from a provider compares equal to one built in memory.
   *
   * In Go this is where a JSON number became an `int` where it was whole and a
   * `float64` otherwise, nested values included. JavaScript has a single
   * number type, so the only conversion left is the one that is not about
   * number types at all: priority is a well-known key with a documented place
   * in the output, and a provider may hand it back as a string.
   */
  normalize(f: Fields): void {
    for (const [k, v] of Object.entries(f)) {
      if (k === KeyPriority) {
        const n = Fields.int(f, k);
        if (n !== undefined) {
          f[k] = n;
        }
        continue;
      }
      f[k] = normalizeValue(v);
    }
  },

  /** priority returns the priority field, 0 when unset. */
  priority(f: Fields): number {
    return Fields.int(f, KeyPriority) ?? 0;
  },
};

// Go's fmt.Sprint for the non-string elements of a list field. JSON holds no
// type fmt spells unusually except nil, which Go prints as "<nil>"; "null" is
// the JSON spelling of the same thing and the one a reader of --json expects.
function stringify(v: JSONValue): string {
  if (v === null) {
    return 'null';
  }
  if (typeof v === 'object') {
    return JSON.stringify(v) ?? '';
  }
  return String(v);
}

/**
 * parseValue converts a `key=value` command-line value into the most specific
 * JSON type it clearly is: a bool, a number, a JSON array or object when it
 * parses as one, and otherwise a string. This is what `--set` uses, so
 * `--set estimate=3` stores a number while `--set ref=3.0.1` stores a string.
 *
 * It returns null for the literal `null`, which `Fields.set` reads as a
 * removal, exactly as Go's nil did.
 */
export function parseValue(raw: string): JSONValue {
  const s = raw.trim();
  if (s === '') {
    return '';
  }
  switch (s.toLowerCase()) {
    case 'true':
      return true;
    case 'false':
      return false;
    case 'null':
      return null;
  }
  if (integerText.test(s)) {
    return Number(s);
  }
  if (floatText.test(s)) {
    const fl = Number(s);
    // NaN and the infinities are excluded deliberately: JSON cannot represent
    // them, so accepting one here would store a value that fails on the way
    // out instead of a string that round-trips. `1e400` reaches this by
    // parsing to Infinity, as Go reached it by an out-of-range error.
    if (Number.isFinite(fl)) {
      return fl;
    }
  }
  if (s[0] === '[' || s[0] === '{') {
    try {
      const v = JSON.parse(s) as JSONValue;
      const normalized: Fields = { v };
      Fields.normalize(normalized);
      return normalized['v'] ?? null;
    } catch {
      // Not JSON after all; fall through to the text the user typed.
    }
  }
  return raw;
}

/**
 * TimeFormat is the wire format for every timestamp the CLI writes, named
 * here as the pattern rather than as a Go layout string.
 *
 * **It must stay fixed-width.** Timestamps are stored as text and the
 * providers compare them as text — `defer_at < ?`, `ORDER BY updated_at` —
 * so lexicographic order has to equal chronological order. RFC 3339 in UTC
 * is always the same twenty characters ending in Z, which makes that true.
 *
 * The trap is sub-second precision. A format that **strips trailing zeros**
 * is variable width and breaks the equality above: "…:00.1Z" sorts after
 * "…:00.05Z". If this ever needs milliseconds, the only safe spelling is a
 * fixed-width one such as "YYYY-MM-DDTHH:mm:ss.sssZ", and every stored
 * timestamp has to be rewritten by a migration step, because old and new rows
 * would otherwise be different widths and compare wrongly against each other.
 *
 * The cost of one-second resolution, accepted knowingly: PLAN.md resolves
 * a multi-device conflict by last-write-wins on updated_at, so two devices
 * editing the same task within the same second are indistinguishable and
 * the tie breaks arbitrarily. For one person on several machines that is
 * not worth more precision than it costs.
 */
export const TimeFormat = 'YYYY-MM-DDTHH:mm:ssZ';

/**
 * zeroTime is the unset instant: Go's `time.Time{}`, which `Validate` rejects.
 * An invalid Date stands in for it, because every real instant is a valid one
 * and a sentinel inside the representable range would be a timestamp someone
 * could legitimately store.
 */
export function zeroTime(): Date {
  return new Date(NaN);
}

/** isZeroTime reports whether t is the unset instant; Go's `IsZero`. */
export function isZeroTime(t: Date): boolean {
  return Number.isNaN(t.getTime());
}

/** formatTime renders t in UTC in the wire format. */
export function formatTime(t: Date): string {
  // toISOString always writes milliseconds, which the wire format does not
  // carry; see TimeFormat on why they must not simply be appended one day.
  return t.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// RFC 3339: a date, a T, a time, an optional fraction, and either Z or an
// offset. Date.parse is far laxer than that — it accepts date-only values and
// a pile of legacy spellings — so the shape is checked before it is used.
const rfc3339 =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;

/**
 * parseTime reads a timestamp written by formatTime, accepting the sub-second
 * variants a provider may hand back. It throws on anything else: a timestamp
 * that cannot be read is not a value the caller can carry on with.
 */
export function parseTime(s: string): Date {
  if (rfc3339.test(s)) {
    const t = new Date(s);
    if (!Number.isNaN(t.getTime())) {
      return t;
    }
  }
  throw new Error(`invalid timestamp ${JSON.stringify(s)}: expected RFC 3339`);
}

/** DueDateFormat is the date-only form accepted for the due field. */
export const DueDateFormat = 'YYYY-MM-DD';

const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * parseDue accepts either a plain date or a full RFC 3339 timestamp and
 * returns the instant it refers to. A plain date means the *start* of that day
 * in UTC: `--due 2026-11-01` is `2026-11-01T00:00:00Z`, which is what
 * `docs/agents.md` documents.
 *
 * The Go comment this was ported from said "the end of that day", which
 * described a different function. Widening a date-only bound to cover the
 * whole day belongs to the `--due-before` / `--defer-before` filters, and is
 * done by the bound parser in the command layer, not here.
 */
export function parseDue(s: string): Date {
  const parts = dateOnly.exec(s);
  if (parts !== null) {
    const [, y, m, d] = parts;
    const year = Number(y);
    const month = Number(m);
    const day = Number(d);
    const t = new Date(Date.UTC(year, month - 1, day));
    // Date.UTC rolls an out-of-range component over into the next month or
    // year; Go's time.Parse rejects it, so the round trip is checked.
    if (
      t.getUTCFullYear() === year &&
      t.getUTCMonth() === month - 1 &&
      t.getUTCDate() === day
    ) {
      return t;
    }
  } else if (rfc3339.test(s)) {
    const t = new Date(s);
    if (!Number.isNaN(t.getTime())) {
      return t;
    }
  }
  throw new Error(
    `invalid due date ${JSON.stringify(s)}: expected YYYY-MM-DD or RFC 3339`,
  );
}

/** ErrEmptyTitle is returned by validate when the title is blank. */
export const ErrEmptyTitle = new Error('title must not be empty');

/** Task is one node of the tree: a folder, a project or an action. */
export class Task {
  id = '';
  kind: Kind = '';
  title = '';
  /**
   * parentID is empty at the top level, which for a task means the inbox.
   * The inbox is not a container; it is the absence of one, so nothing has
   * to create it and it cannot be deleted.
   */
  parentID = '';
  /**
   * position orders siblings manually. Ties break by id, which is creation
   * order, so an unset position still gives a stable listing.
   */
  position = 0;

  status: Status = '';
  flagged = false;
  sequential = false;
  completedByChildren = false;

  deferAt: Date | undefined = undefined;
  dueAt: Date | undefined = undefined;
  estimatedMinutes = 0;
  note = '';

  repeat: Repeat | undefined = undefined;
  seriesID = '';

  reviewInterval: ReviewInterval | undefined = undefined;
  lastReviewedAt: Date | undefined = undefined;

  createdAt: Date = zeroTime();
  updatedAt: Date = zeroTime();
  completedAt: Date | undefined = undefined;
  droppedAt: Date | undefined = undefined;
  deletedAt: Date | undefined = undefined;

  /**
   * tags are many-to-many and stored relationally, not in fields, because
   * `tdo ls --tag home` must be a join and not a scan. They are carried on
   * the task so that nothing above the store has to assemble them.
   */
  tags: string[] = [];

  /**
   * fields holds every user-defined value. It is never absent on a task
   * returned by a store.
   */
  fields: Fields = {};

  /** deleted reports whether the task carries a tombstone. */
  deleted(): boolean {
    return this.deletedAt !== undefined;
  }

  /**
   * done reports whether the task is finished. It is the derived convenience
   * the JSON output carries as "done".
   */
  done(): boolean {
    return this.status === StatusDone;
  }

  /**
   * inbox reports whether the task is a loose action: a task with no parent.
   * A folder or a project at the top level is not in the inbox; it is the top
   * level.
   */
  inbox(): boolean {
    return this.kind === KindTask && this.parentID === '';
  }

  /**
   * actionable reports whether this kind of node can ever be worked on. A
   * folder organises and is never actionable, whatever its status.
   */
  actionable(): boolean {
    return this.kind !== KindFolder;
  }

  /**
   * clone returns a deep copy, so a caller can edit a task without affecting
   * the value a store still holds.
   */
  clone(): Task {
    const c = new Task();
    c.id = this.id;
    c.kind = this.kind;
    c.title = this.title;
    c.parentID = this.parentID;
    c.position = this.position;
    c.status = this.status;
    c.flagged = this.flagged;
    c.sequential = this.sequential;
    c.completedByChildren = this.completedByChildren;
    c.estimatedMinutes = this.estimatedMinutes;
    c.note = this.note;
    c.seriesID = this.seriesID;
    c.deferAt = cloneTime(this.deferAt);
    c.dueAt = cloneTime(this.dueAt);
    c.lastReviewedAt = cloneTime(this.lastReviewedAt);
    c.createdAt = cloneTime(this.createdAt) ?? zeroTime();
    c.updatedAt = cloneTime(this.updatedAt) ?? zeroTime();
    c.completedAt = cloneTime(this.completedAt);
    c.droppedAt = cloneTime(this.droppedAt);
    c.deletedAt = cloneTime(this.deletedAt);
    c.repeat = cloneRepeat(this.repeat);
    c.reviewInterval = cloneReviewInterval(this.reviewInterval);
    c.tags = [...this.tags];
    c.fields = Fields.clone(this.fields);
    return c;
  }

  /**
   * validate checks the invariants every provider relies on, returning the
   * first failure or undefined when there is none. It is about the node alone;
   * rules that need the parent — which kinds may contain which, and cycles —
   * belong to the store, which is the only thing that can see the tree.
   */
  validate(): Error | undefined {
    if (this.title.trim() === '') {
      return ErrEmptyTitle;
    }
    if (this.id === '') {
      return new Error('id must not be empty');
    }
    if (!kindValid(this.kind)) {
      return new Error(
        `kind ${JSON.stringify(this.kind)} is not one of folder, project or task`,
      );
    }
    if (!statusValid(this.status)) {
      return new Error(
        `status ${JSON.stringify(this.status)} is not one of active, on_hold, done or dropped`,
      );
    }
    if (this.kind === KindFolder && this.status === StatusDone) {
      return new Error('a folder is never completed; drop it or delete it instead');
    }
    if (this.parentID === this.id) {
      return new Error(`${this.id} cannot be its own parent`);
    }
    if (isZeroTime(this.createdAt) || isZeroTime(this.updatedAt)) {
      return new Error('created_at and updated_at must be set');
    }
    if (this.estimatedMinutes < 0) {
      return new Error(
        `estimated_minutes must not be negative, got ${this.estimatedMinutes}`,
      );
    }
    if (this.repeat !== undefined) {
      if (!repeatMethodValid(this.repeat.method)) {
        return new Error(
          `repeat method ${JSON.stringify(this.repeat.method)} is not one of fixed, from_completion or defer_another`,
        );
      }
      if (this.repeat.every.trim() === '') {
        return new Error('a repeat must say how often: set every, for example 1w');
      }
    }
    if (this.reviewInterval !== undefined) {
      if (this.reviewInterval.every.trim() === '') {
        return new Error(
          'a review interval must say how often: set every, for example 1w',
        );
      }
      if (this.kind === KindTask) {
        return new Error(
          'a review interval belongs on a folder or a project, not on a task',
        );
      }
    }
    for (const tag of this.tags) {
      if (tag.trim() === '') {
        return new Error('a tag must not be empty');
      }
    }
    for (const key of Object.keys(this.fields)) {
      if (Reserved(key)) {
        return new Error(
          `field ${JSON.stringify(key)} is reserved; it cannot be set as a user-defined field`,
        );
      }
      if (key === '') {
        return new Error('a user-defined field name must not be empty');
      }
    }
    const p = Fields.int(this.fields, KeyPriority);
    if (p !== undefined && (p < 0 || p > 3)) {
      return new Error(`priority must be between 0 and 3, got ${p}`);
    }
    return undefined;
  }

  /**
   * setStatus moves the task to status and keeps the three timestamps that
   * record how it got there consistent with it. Setting the status a task
   * already has changes nothing, so a repeated `tdo done` does not move
   * completed_at.
   */
  setStatus(s: Status, now: Date): void {
    if (s === this.status) {
      return;
    }
    const at = new Date(now.getTime());
    this.status = s;
    switch (s) {
      case StatusDone:
        this.completedAt = at;
        this.droppedAt = undefined;
        break;
      case StatusDropped:
        this.droppedAt = at;
        this.completedAt = undefined;
        break;
      default:
        this.completedAt = undefined;
        this.droppedAt = undefined;
    }
    this.updatedAt = at;
  }

  /**
   * setTags replaces the tag set, trimming blanks and removing duplicates
   * case-insensitively while keeping the spelling the user typed first. Tags
   * are compared case-insensitively everywhere, so storing both "Home" and
   * "home" would make one of them unreachable.
   */
  setTags(tags: string[]): void {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of tags) {
      const tag = raw.trim();
      if (tag === '') {
        continue;
      }
      const key = tag.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push(tag);
    }
    // Array.prototype.sort is stable, which is what Go's SliceStable was for:
    // two spellings that differ only in case keep the order they arrived in.
    out.sort((a, b) => compareStrings(a.toLowerCase(), b.toLowerCase()));
    this.tags = out;
  }

  /** hasTag reports whether the task carries tag, compared case-insensitively. */
  hasTag(tag: string): boolean {
    const want = tag.toLowerCase();
    return this.tags.some((have) => have.toLowerCase() === want);
  }

  /**
   * toJSON renders the documented shape: the required fields, then the
   * derived "done", then every user-defined field flattened alongside them.
   *
   * The keys are written in sorted order, because Go's encoding/json sorts the
   * keys of a map and the shape in docs/agents.md is a byte-level contract.
   */
  toJSON(): JSONObject {
    const out: JSONObject = {
      [KeyID]: this.id,
      [KeyKind]: this.kind,
      [KeyTitle]: this.title,
      [KeyParentID]: optionalString(this.parentID),
      [KeyPosition]: this.position,
      [KeyStatus]: this.status,
      [KeyFlagged]: this.flagged,
      [KeySequential]: this.sequential,
      [KeyCompletedByChildren]: this.completedByChildren,
      [KeyDeferAt]: optionalTime(this.deferAt),
      [KeyDueAt]: optionalTime(this.dueAt),
      [KeyEstimatedMinutes]: this.estimatedMinutes,
      [KeyNote]: optionalString(this.note),
      [KeyRepeat]: optionalRepeat(this.repeat),
      [KeySeriesID]: optionalString(this.seriesID),
      [KeyReviewInterval]: optionalReview(this.reviewInterval),
      [KeyLastReviewedAt]: optionalTime(this.lastReviewedAt),
      [KeyCreatedAt]: formatTime(this.createdAt),
      [KeyUpdatedAt]: formatTime(this.updatedAt),
      [KeyCompletedAt]: optionalTime(this.completedAt),
      [KeyDroppedAt]: optionalTime(this.droppedAt),
      [KeyDeletedAt]: optionalTime(this.deletedAt),
      [KeyTags]: [...this.tags],
      // done is derived, not stored. It is here so the common question —
      // is this finished? — stays one key for a caller that does not care
      // about the other three statuses.
      [KeyDone]: this.done(),
    };

    for (const [k, v] of Object.entries(this.fields)) {
      if (Reserved(k)) {
        continue;
      }
      out[k] = v;
    }
    // Keep the documented open key present even when the user never set it.
    if (!Object.hasOwn(out, KeyPriority)) {
      out[KeyPriority] = 0;
    }

    const sorted: JSONObject = {};
    for (const k of Object.keys(out).sort(compareStrings)) {
      sorted[k] = out[k] ?? null;
    }
    return sorted;
  }
}

function cloneTime(v: Date | undefined): Date | undefined {
  return v === undefined ? undefined : new Date(v.getTime());
}

/**
 * newTask returns a task with the defaults every new node starts from. The
 * caller supplies the id and the clock, because both belong to it: ids are
 * generated where the task is created and tests need a fixed now.
 */
export function newTask(taskID: string, kind: Kind, title: string, now: Date): Task {
  const t = new Task();
  t.id = taskID;
  t.kind = kind;
  t.title = title;
  t.status = StatusActive;
  t.createdAt = new Date(now.getTime());
  t.updatedAt = new Date(now.getTime());
  return t;
}

/**
 * taskFromJSON reads the shape toJSON writes, putting every unreserved key
 * back into fields. It is what makes `tdo export | tdo import` lossless,
 * including for fields this version of the binary knows nothing about.
 *
 * The derived keys are read and discarded: they are computed, and accepting
 * one as a user-defined field would make the next export disagree with the
 * import that produced it.
 *
 * It throws when a required field holds the wrong type, where Go's
 * UnmarshalJSON returned an error wrapped with the field name.
 */
export function taskFromJSON(data: JSONValue): Task {
  if (!isPlainObject(data)) {
    throw new Error('a task must be a JSON object');
  }
  const t = new Task();
  for (const [key, value] of Object.entries(data)) {
    try {
      switch (key) {
        case KeyID:
          t.id = expectString(value);
          break;
        case KeyKind:
          t.kind = nullableString(value);
          break;
        case KeyTitle:
          t.title = expectString(value);
          break;
        case KeyParentID:
          t.parentID = nullableString(value);
          break;
        case KeyPosition:
          t.position = expectInt(value);
          break;
        case KeyStatus:
          t.status = nullableString(value);
          break;
        case KeyFlagged:
          t.flagged = expectBool(value);
          break;
        case KeySequential:
          t.sequential = expectBool(value);
          break;
        case KeyCompletedByChildren:
          t.completedByChildren = expectBool(value);
          break;
        case KeyDeferAt:
          t.deferAt = optionalTimeFrom(value);
          break;
        case KeyDueAt:
          t.dueAt = optionalTimeFrom(value);
          break;
        case KeyEstimatedMinutes:
          t.estimatedMinutes = expectInt(value);
          break;
        case KeyNote:
          t.note = nullableString(value);
          break;
        case KeyRepeat:
          t.repeat = repeatFrom(value);
          break;
        case KeySeriesID:
          t.seriesID = nullableString(value);
          break;
        case KeyReviewInterval:
          t.reviewInterval = reviewFrom(value);
          break;
        case KeyLastReviewedAt:
          t.lastReviewedAt = optionalTimeFrom(value);
          break;
        case KeyCreatedAt:
          t.createdAt = parseTime(expectString(value));
          break;
        case KeyUpdatedAt:
          t.updatedAt = parseTime(expectString(value));
          break;
        case KeyCompletedAt:
          t.completedAt = optionalTimeFrom(value);
          break;
        case KeyDroppedAt:
          t.droppedAt = optionalTimeFrom(value);
          break;
        case KeyDeletedAt:
          t.deletedAt = optionalTimeFrom(value);
          break;
        case KeyTags:
          t.setTags(expectStringList(value));
          break;
        case KeyDone:
        case KeyAvailable:
        case KeyBlockedBy:
        case KeyNextReview:
          // Derived; recomputed on the way out.
          break;
        default:
          if (value !== null) {
            t.fields[key] = value;
          }
      }
    } catch (err) {
      throw new Error(`field ${JSON.stringify(key)}: ${messageOf(err)}`, { cause: err });
    }
  }
  // A document that predates a key, or one a human wrote by hand, should
  // still land on a usable task rather than on an invalid one.
  if (t.kind === '') {
    t.kind = KindTask;
  }
  if (t.status === '') {
    t.status = StatusActive;
  }
  Fields.normalize(t.fields);
  return t;
}

/** taskParse reads a task out of the JSON text toJSON produces. */
export function taskParse(text: string): Task {
  return taskFromJSON(JSON.parse(text) as JSONValue);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function optionalString(s: string): JSONValue {
  return s === '' ? null : s;
}

function optionalTime(v: Date | undefined): JSONValue {
  return v === undefined ? null : formatTime(v);
}

function optionalRepeat(r: Repeat | undefined): JSONValue {
  // The field order is the struct's, not sorted: Go sorts the keys of a map
  // and leaves a struct's own order alone.
  return r === undefined ? null : { method: r.method, every: r.every };
}

function optionalReview(r: ReviewInterval | undefined): JSONValue {
  return r === undefined ? null : { every: r.every };
}

function expectString(v: JSONValue): string {
  if (typeof v !== 'string') {
    throw new Error(`cannot read ${typeName(v)} as a string`);
  }
  return v;
}

// Go's unmarshalString: null leaves the empty string, anything else must be
// one. The optional-string fields share it, which is why parent_id, note and
// series_id all read null as "".
function nullableString(v: JSONValue): string {
  return v === null ? '' : expectString(v);
}

function expectBool(v: JSONValue): boolean {
  if (typeof v !== 'boolean') {
    throw new Error(`cannot read ${typeName(v)} as a bool`);
  }
  return v;
}

function expectInt(v: JSONValue): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new Error(`cannot read ${typeName(v)} as an integer`);
  }
  return v;
}

function expectStringList(v: JSONValue): string[] {
  if (v === null) {
    return [];
  }
  if (!Array.isArray(v)) {
    throw new Error(`cannot read ${typeName(v)} as a list of strings`);
  }
  return v.map(expectString);
}

function optionalTimeFrom(v: JSONValue): Date | undefined {
  return v === null ? undefined : parseTime(expectString(v));
}

function repeatFrom(v: JSONValue): Repeat | undefined {
  if (v === null) {
    return undefined;
  }
  if (!isPlainObject(v)) {
    throw new Error(`cannot read ${typeName(v)} as a repeat`);
  }
  return { method: nullableString(v['method'] ?? null), every: nullableString(v['every'] ?? null) };
}

function reviewFrom(v: JSONValue): ReviewInterval | undefined {
  if (v === null) {
    return undefined;
  }
  if (!isPlainObject(v)) {
    throw new Error(`cannot read ${typeName(v)} as a review interval`);
  }
  return { every: nullableString(v['every'] ?? null) };
}

function typeName(v: JSONValue): string {
  if (v === null) {
    return 'null';
  }
  if (Array.isArray(v)) {
    return 'an array';
  }
  switch (typeof v) {
    case 'object':
      return 'an object';
    case 'number':
      return 'a number';
    case 'boolean':
      return 'a bool';
    default:
      return 'a string';
  }
}
