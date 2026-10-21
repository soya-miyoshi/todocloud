// The requests this layer accepts: an edit to an existing item, a draft of a
// new one, and the two small parsers both of them share.
//
// Port notes, where TypeScript cannot hold the Go shape exactly:
//
//   - `Edit` and `Draft` were Go structs with methods and are classes here,
//     built from an init object the way `store.Filter` and `store.Condition`
//     are. A `*string` field becomes `string | undefined`: the three-state
//     "set it / clear it / leave it alone" that the pointer existed for
//     survives unchanged, and `tdo edit --note ""` still clears a note while
//     omitting the flag does not touch it.
//   - Go's `apply` and `invalidf` were unexported and reachable from
//     `taskops.go` because Go has one package per directory. TypeScript has
//     one module per file, so both are exported here. They are not part of
//     the surface a front end is meant to call; `taskops.ts` is.
//   - `ErrInvalid` stays a sentinel value and is attached as a thrown error's
//     `cause`, the way `recur.ErrNoRepeat` and the `store` sentinels are, with
//     an `isInvalid` predicate that walks the chain. `exit.classify` keys on
//     it, so the predicate is the contract and not a convenience.
//   - Go's `error` return is kept only where the function answered a
//     question. `apply` and `build` do work and so throw, which is also what
//     keeps a rejected edit from leaving half of itself behind: the caller
//     never sees a task it is supposed to write.

import {
  Fields,
  type JSONValue,
  type Kind,
  KeyPriority,
  type Repeat,
  RepeatFixed,
  type RepeatMethod,
  Reserved,
  type Task,
  newTask,
  repeatMethodValid,
} from '../task.ts';
import { ensureSeries, parseEvery } from '../recur.ts';
import { compareStrings } from '../store/store.ts';

/**
 * ErrInvalid marks a request this layer refused: a reserved field name, a
 * priority out of range, a task that would not validate. Every front end
 * needs that distinction — the CLI exits 2 rather than 1, and the server
 * answers 400 rather than 500 — and only this layer knows which it was.
 */
export const ErrInvalid = new Error('invalid request');

/** Reports whether err, or anything it wraps, is ErrInvalid. */
export function isInvalid(err: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur !== null && cur !== undefined && !seen.has(cur)) {
    if (cur === ErrInvalid) {
      return true;
    }
    seen.add(cur);
    cur = typeof cur === 'object' && 'cause' in cur ? cur.cause : undefined;
  }
  return false;
}

/**
 * invalidf builds an ErrInvalid with its own wording. Go's variadic format
 * arguments are a template literal at the call site; the message it produces
 * is byte for byte what `fmt.Errorf("%w: %s", ErrInvalid, …)` produced.
 */
export function invalidf(message: string): Error {
  return new Error(`${ErrInvalid.message}: ${message}`, { cause: ErrInvalid });
}

/** quote renders a value the way Go's `%q` did, for an error message. */
function quote(s: string): string {
  return JSON.stringify(s);
}

/** messageOf reads the text of a thrown value, whatever it is. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The fields an Edit may be built from; every one of them is optional. */
export interface EditInit {
  title?: string | undefined;
  note?: string | undefined;
  estimatedMinutes?: number | undefined;
  tags?: string[] | undefined;
  untag?: string[] | undefined;
  priority?: number | undefined;
  set?: Record<string, JSONValue> | undefined;
  unset?: string[] | undefined;
}

/**
 * Edit is a change to an existing item: the properties a caller named, and
 * nothing else. An undefined field means "leave it alone", which is the
 * distinction `tdo edit --note ""` depends on — clearing a note and not
 * touching it are different requests.
 *
 * The order the fields are applied in is part of the behaviour: the sugar
 * first, then set, then unset, so the more explicit instruction wins when a
 * key is named twice.
 */
export class Edit {
  title: string | undefined = undefined;
  note: string | undefined = undefined;
  estimatedMinutes: number | undefined = undefined;
  /**
   * tags replaces the whole set, which is what "these are its tags" means;
   * untag is the way to remove one of several.
   */
  tags: string[] | undefined = undefined;
  untag: string[] = [];
  /**
   * priority is a required field with a flag of its own; set and unset are
   * what is left, and they are stored in the open map untouched.
   */
  priority: number | undefined = undefined;
  set: Record<string, JSONValue> = {};
  unset: string[] = [];

  constructor(init?: EditInit) {
    if (init === undefined) {
      return;
    }
    if (init.title !== undefined) {
      this.title = init.title;
    }
    if (init.note !== undefined) {
      this.note = init.note;
    }
    if (init.estimatedMinutes !== undefined) {
      this.estimatedMinutes = init.estimatedMinutes;
    }
    if (init.tags !== undefined) {
      this.tags = init.tags;
    }
    if (init.untag !== undefined) {
      this.untag = init.untag;
    }
    if (init.priority !== undefined) {
      this.priority = init.priority;
    }
    if (init.set !== undefined) {
      this.set = init.set;
    }
    if (init.unset !== undefined) {
      this.unset = init.unset;
    }
  }

  /** empty reports whether this edit changes nothing. */
  empty(): boolean {
    return (
      this.title === undefined &&
      this.note === undefined &&
      this.estimatedMinutes === undefined &&
      this.tags === undefined &&
      this.untag.length === 0 &&
      this.priority === undefined &&
      Object.keys(this.set).length === 0 &&
      this.unset.length === 0
    );
  }

  /**
   * apply writes this edit onto t, throwing an ErrInvalid for a request it
   * refuses. Callers hand it a clone, so a refusal leaves the stored task as
   * it was.
   */
  apply(t: Task): void {
    if (this.title !== undefined) {
      t.title = this.title.trim();
    }
    if (this.note !== undefined) {
      t.note = this.note;
    }
    if (this.estimatedMinutes !== undefined) {
      t.estimatedMinutes = this.estimatedMinutes;
    }
    if (this.tags !== undefined) {
      t.setTags(normalizeTags(this.tags));
    }
    if (this.untag.length > 0) {
      const remove = normalizeTags(this.untag).map((tag) => tag.toLowerCase());
      const kept: string[] = [];
      for (const tag of t.tags) {
        // Go compared with strings.EqualFold; tags are folded with
        // toLowerCase everywhere else in this tree (task.setTags,
        // store.tagKey), so they are folded that way here too.
        if (!remove.includes(tag.toLowerCase())) {
          kept.push(tag);
        }
      }
      t.setTags(kept);
    }
    applyFields(t.fields, this.priority, this.set, this.unset);
  }
}

/**
 * applyFields writes the priority, the user-defined fields and the removals
 * onto f, refusing a reserved name: a key that shadowed a required field
 * would be invisible in the flattened JSON of §3.2.
 */
export function applyFields(
  f: Fields,
  priority: number | undefined,
  set: Record<string, JSONValue>,
  unset: readonly string[] | undefined,
): void {
  if (priority !== undefined) {
    if (priority < 0 || priority > 3) {
      throw invalidf(`priority must be between 0 and 3, got ${priority}`);
    }
    Fields.set(f, KeyPriority, priority);
  }
  for (const key of sortedKeys(set)) {
    if (Reserved(key)) {
      throw invalidf(`field ${quote(key)} is reserved and cannot be set`);
    }
    Fields.set(f, key, set[key]);
  }
  for (const raw of unset ?? []) {
    const key = raw.trim();
    if (key === '') {
      throw invalidf('a field to remove needs a name');
    }
    if (Reserved(key)) {
      throw invalidf(`field ${quote(key)} is reserved and cannot be unset`);
    }
    Fields.delete(f, key);
  }
}

/**
 * sortedKeys gives the keys of a map in a fixed order, so that two fields
 * set in one request are written in the same order every time and a failure
 * on one of them is reproducible.
 *
 * JavaScript objects remember insertion order where Go maps randomised it, so
 * the sort is no longer what makes the result deterministic — it is what keeps
 * the order the same as Go's, and the same whichever front end built the map.
 */
function sortedKeys(m: Record<string, JSONValue>): string[] {
  return Object.keys(m).sort(compareStrings);
}

/**
 * normalizeTags drops blanks and duplicates while keeping the order they
 * were written in. Tags are compared case-insensitively, because that is how
 * they are matched.
 */
export function normalizeTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of tags) {
    for (const raw of value.split(',')) {
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
  }
  return out;
}

/** The fields a Draft may be built from. */
export interface DraftInit {
  kind?: Kind | undefined;
  title?: string | undefined;
  parentID?: string | undefined;
  flagged?: boolean | undefined;
  tags?: string[] | undefined;
  note?: string | undefined;
  deferAt?: Date | undefined;
  dueAt?: Date | undefined;
  estimatedMinutes?: number | undefined;
  repeat?: Repeat | undefined;
  priority?: number | undefined;
  set?: Record<string, JSONValue> | undefined;
}

/**
 * Draft is a new item before it has an id: everything a creating caller
 * decides, with the tree position it goes into.
 */
export class Draft {
  kind: Kind = '';
  title = '';
  parentID = '';
  flagged = false;
  tags: string[] = [];
  note = '';
  deferAt: Date | undefined = undefined;
  dueAt: Date | undefined = undefined;
  estimatedMinutes = 0;
  repeat: Repeat | undefined = undefined;
  priority: number | undefined = undefined;
  set: Record<string, JSONValue> = {};

  constructor(init?: DraftInit) {
    if (init === undefined) {
      return;
    }
    if (init.kind !== undefined) {
      this.kind = init.kind;
    }
    if (init.title !== undefined) {
      this.title = init.title;
    }
    if (init.parentID !== undefined) {
      this.parentID = init.parentID;
    }
    if (init.flagged !== undefined) {
      this.flagged = init.flagged;
    }
    if (init.tags !== undefined) {
      this.tags = init.tags;
    }
    if (init.note !== undefined) {
      this.note = init.note;
    }
    if (init.deferAt !== undefined) {
      this.deferAt = init.deferAt;
    }
    if (init.dueAt !== undefined) {
      this.dueAt = init.dueAt;
    }
    if (init.estimatedMinutes !== undefined) {
      this.estimatedMinutes = init.estimatedMinutes;
    }
    if (init.repeat !== undefined) {
      this.repeat = init.repeat;
    }
    if (init.priority !== undefined) {
      this.priority = init.priority;
    }
    if (init.set !== undefined) {
      this.set = init.set;
    }
  }

  /**
   * build turns this draft into a validated task. It is the one place a new
   * item is assembled, so `tdo add`, `tdo project` and the server all produce
   * the same row for the same request.
   */
  build(taskID: string, now: Date): Task {
    const t = newTask(taskID, this.kind, this.title.trim(), now);
    t.parentID = this.parentID;
    t.flagged = this.flagged;
    t.note = this.note;
    t.deferAt = this.deferAt;
    t.dueAt = this.dueAt;
    t.estimatedMinutes = this.estimatedMinutes;
    if (this.tags.length > 0) {
      t.setTags(normalizeTags(this.tags));
    }
    if (this.repeat !== undefined) {
      t.repeat = this.repeat;
      // The first instance names the series, so a successor can be tied to
      // it without a second generator.
      ensureSeries(t);
    }
    applyFields(t.fields, this.priority, this.set, undefined);
    const err = t.validate();
    if (err !== undefined) {
      throw invalidf(err.message);
    }
    return t;
  }
}

/**
 * parseMinutes reads a duration in the spellings every front end accepts:
 * 25m, 2h, 1h30m, or a bare number of minutes.
 */
export function parseMinutes(raw: string): number {
  const s = raw.trim().toLowerCase();
  if (s === '') {
    throw invalidf('expected a duration, for example 25m');
  }
  // Go tried strconv.Atoi first, which accepts an optional sign and decimal
  // digits and nothing else.
  if (/^[+-]?\d+$/.test(s)) {
    const n = Number(s);
    if (n < 0) {
      throw invalidf(`a duration must not be negative, got ${quote(raw)}`);
    }
    return n;
  }
  const ms = parseDurationMs(s);
  if (ms === undefined || ms < 0) {
    throw invalidf(
      `${quote(raw)} is not a duration; write it as 25m, 2h or 1h30m`,
    );
  }
  return Math.trunc(ms / 60000);
}

/** The unit suffixes Go's time.ParseDuration accepts, in milliseconds. */
const durationUnits = new Map<string, number>([
  ['ns', 1e-6],
  ['us', 1e-3],
  ['µs', 1e-3],
  ['μs', 1e-3],
  ['ms', 1],
  ['s', 1000],
  ['m', 60000],
  ['h', 3600000],
]);

/**
 * parseDurationMs is `time.ParseDuration` in milliseconds, or undefined when
 * the string is not one. It is exported because it is the project's one
 * spelling of a duration: `--estimate 25m` and `tdo ls --watch --interval 10s`
 * must not disagree about what `1h30m` means. Go has no equivalent in the standard library of
 * either runtime, so the grammar is reproduced here: an optional sign, then
 * one or more decimal numbers — with an optional fraction — each carrying a
 * unit suffix. "0" on its own is accepted, as Go accepts it.
 *
 * Go accumulated int64 nanoseconds and overflowed past about 2562047h; this
 * accumulates a float64 of milliseconds, so a value that large loses
 * precision rather than being refused. Nothing a front end asks for comes
 * near it, and `parseMinutes` truncates to whole minutes afterwards either
 * way.
 */
export function parseDurationMs(s: string): number | undefined {
  let rest = s;
  let neg = false;
  if (rest.startsWith('+') || rest.startsWith('-')) {
    neg = rest.startsWith('-');
    rest = rest.slice(1);
  }
  if (rest === '') {
    return undefined;
  }
  // Go special-cases a bare zero, with or without a sign and in any spelling
  // of it that has no unit.
  if (rest === '0') {
    return 0;
  }
  let total = 0;
  while (rest !== '') {
    const number = /^\d*(?:\.\d*)?/.exec(rest)?.[0] ?? '';
    // A number is required, and "." alone is not one.
    if (number === '' || number === '.') {
      return undefined;
    }
    rest = rest.slice(number.length);
    const unit = /^[^0-9.]+/.exec(rest)?.[0];
    if (unit === undefined) {
      // A number with no unit, which Go refuses outside the bare-zero case.
      return undefined;
    }
    const scale = durationUnits.get(unit);
    if (scale === undefined) {
      return undefined;
    }
    rest = rest.slice(unit.length);
    total += Number(number) * scale;
  }
  return neg ? -total : total;
}

/**
 * parseRepeat reads `EVERY[:method]`.
 *
 * A repeat with no method named is a calendar schedule: the next instance
 * follows the previous instance's dates, which is what someone writing
 * "every Monday" means. The other two methods are asked for by name. The
 * interval spelling may itself carry a colon ("1mo:last-friday"), so the
 * method is recognised by name at the end rather than by position: anything
 * that is not one of the three methods is part of the interval.
 */
export function parseRepeat(raw: string): Repeat {
  const s = raw.trim();
  if (s === '') {
    throw invalidf(
      'a repeat needs an interval, for example 1w or 1w:from_completion',
    );
  }
  let every = s;
  let method: RepeatMethod = RepeatFixed;
  const i = s.lastIndexOf(':');
  if (i >= 0) {
    const m: RepeatMethod = s.slice(i + 1);
    if (repeatMethodValid(m)) {
      every = s.slice(0, i);
      method = m;
    }
  }
  try {
    parseEvery(every);
  } catch (err) {
    throw invalidf(messageOf(err));
  }
  return { method, every };
}
