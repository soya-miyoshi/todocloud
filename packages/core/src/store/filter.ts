// Filter describes a listing, and is the on-disk format of a saved
// perspective.
//
// Go had the struct in store.go and the matching in filter.go; the two are one
// file here, because a `Filter` in TypeScript is a class and a class cannot be
// split across files. The split that mattered is preserved in the methods:
// `matchesStatic` is the part a provider may express in its own query
// language, and `matches` is the whole of it.
//
// Whatever this produces stays provider-agnostic. There is no SQL here and
// there must not be: the providers translate a Filter, and the conformance
// suite checks that their translation answers what `matches` answers.
//
// Port notes:
//
//   - Go's `json.Marshal` of the struct, with its `omitempty`/`omitzero` tags,
//     is `toJSON` below. The key order is the field order, as Go's encoder
//     emits it, and `filter_format.test.ts` pins the result character for
//     character.
//   - Go's `UnmarshalJSON` with `DisallowUnknownFields` is `filterFromJSON`.
//     It is a free function rather than a static method because a `Filter`
//     must exist before it can be filled, and the refusal happens before
//     that.
//   - `*bool` becomes `boolean | undefined` and `*time.Time` becomes
//     `Date | undefined`: the three-state "true / false / not filtering" is
//     the whole point of the pointer and survives unchanged.

import { type Kind, type Status, type Task, kindValid, statusValid } from '../task.ts';
import { nextReviewAt } from '../recur.ts';
import type { Tree } from './availability.ts';
import {
  type AvailabilityFilter,
  type Order,
  availabilityFilterValid,
  AvailabilityAny,
  AvailabilityAvailable,
  AvailabilityBlocked,
  AvailabilityDeferred,
  OrderPosition,
  orderValid,
  ruleDeferral,
  Scope,
  type ScopeInit,
} from './store.ts';

/** The fields a Filter may be built from; every one of them is optional. */
export interface FilterInit {
  kinds?: Kind[] | undefined;
  statuses?: Status[] | undefined;
  availability?: AvailabilityFilter | undefined;
  flagged?: boolean | undefined;
  scope?: Scope | ScopeInit | undefined;
  tags?: string[] | undefined;
  tagsAny?: boolean | undefined;
  deferBefore?: Date | undefined;
  deferAfter?: Date | undefined;
  dueBefore?: Date | undefined;
  dueAfter?: Date | undefined;
  hasDue?: boolean | undefined;
  reviewDueBefore?: Date | undefined;
  includeDeleted?: boolean | undefined;
  onlyDeleted?: boolean | undefined;
  order?: Order | undefined;
  limit?: number | undefined;
  now?: Date | undefined;
}

/**
 * filterFields is the name of every field a Filter has, in the order they are
 * written. It exists for the test that counts them: the golden document in
 * `filter_format.test.ts` can only catch a field it contains, and a field
 * added with an omit-when-unset rule and left unset would slip past it.
 */
export const filterFields: readonly string[] = [
  'kinds',
  'statuses',
  'availability',
  'flagged',
  'scope',
  'tags',
  'tagsAny',
  'deferBefore',
  'deferAfter',
  'dueBefore',
  'dueAfter',
  'hasDue',
  'reviewDueBefore',
  'includeDeleted',
  'onlyDeleted',
  'order',
  'limit',
  'now',
];

/**
 * Filter describes a listing. Only required fields appear here; a condition
 * on a user-defined field is a Condition, applied on the client.
 *
 * This type is a persisted format. A perspective is stored as the JSON of the
 * Filter below (§3.6), and `tdo export` writes the same bytes into a backup,
 * so the keys `toJSON` writes are on-disk structure, not a rendering choice.
 * Renaming a field, changing a key or changing what a field means rewrites
 * the meaning of every perspective a user already saved — a query saved as
 * "flagged and not deferred" would come back meaning something broader, and
 * the user would act on the result without being told. Adding a field is
 * safe; anything else needs a migration of the stored rows and a version to
 * migrate on. `filter_format.test.ts` fails when the shape changes, and it is
 * there to make that decision deliberate rather than accidental.
 *
 * A default Filter matches every live task in tree order. In particular an
 * empty `statuses` matches every status: the command layer, not the store,
 * decides that `tdo ls` means active and on hold.
 */
export class Filter {
  kinds: Kind[] = [];
  statuses: Status[] = [];
  availability: AvailabilityFilter = AvailabilityAny;
  /**
   * flagged keeps flagged items when true and unflagged ones when false;
   * undefined does not filter.
   */
  flagged: boolean | undefined = undefined;
  scope: Scope = new Scope();
  tags: string[] = [];
  /**
   * tagsAny keeps an item carrying any one of tags rather than all of them.
   * Tags are compared case-insensitively.
   */
  tagsAny = false;

  deferBefore: Date | undefined = undefined;
  deferAfter: Date | undefined = undefined;
  dueBefore: Date | undefined = undefined;
  dueAfter: Date | undefined = undefined;
  /**
   * hasDue keeps only items with a due date when true, only items without
   * one when false.
   */
  hasDue: boolean | undefined = undefined;
  /**
   * reviewDueBefore keeps folders and projects whose derived next_review_at
   * falls before this instant, including those never reviewed. It backs
   * `tdo review`.
   */
  reviewDueBefore: Date | undefined = undefined;

  /**
   * includeDeleted widens the listing to tombstoned items; onlyDeleted
   * narrows it to them, for `tdo ls --deleted`.
   */
  includeDeleted = false;
  onlyDeleted = false;

  order: Order = '';
  /**
   * limit caps the number of tasks returned; zero means no limit. It is
   * applied by the store, after its own filtering but before any client-side
   * Condition, so callers that use one should leave it zero.
   */
  limit = 0;

  /**
   * now is the instant availability, defer and review windows are judged
   * against. Unset means the store reads the clock itself; a test sets it so
   * that a truth table is a truth table and not a race. It is never stored:
   * it is a clock reading, not part of what was saved.
   */
  now: Date | undefined = undefined;

  constructor(init?: FilterInit) {
    if (init === undefined) {
      return;
    }
    if (init.kinds !== undefined) {
      this.kinds = init.kinds;
    }
    if (init.statuses !== undefined) {
      this.statuses = init.statuses;
    }
    if (init.availability !== undefined) {
      this.availability = init.availability;
    }
    if (init.flagged !== undefined) {
      this.flagged = init.flagged;
    }
    if (init.scope !== undefined) {
      this.scope =
        init.scope instanceof Scope ? init.scope : new Scope(init.scope);
    }
    if (init.tags !== undefined) {
      this.tags = init.tags;
    }
    if (init.tagsAny !== undefined) {
      this.tagsAny = init.tagsAny;
    }
    if (init.deferBefore !== undefined) {
      this.deferBefore = init.deferBefore;
    }
    if (init.deferAfter !== undefined) {
      this.deferAfter = init.deferAfter;
    }
    if (init.dueBefore !== undefined) {
      this.dueBefore = init.dueBefore;
    }
    if (init.dueAfter !== undefined) {
      this.dueAfter = init.dueAfter;
    }
    if (init.hasDue !== undefined) {
      this.hasDue = init.hasDue;
    }
    if (init.reviewDueBefore !== undefined) {
      this.reviewDueBefore = init.reviewDueBefore;
    }
    if (init.includeDeleted !== undefined) {
      this.includeDeleted = init.includeDeleted;
    }
    if (init.onlyDeleted !== undefined) {
      this.onlyDeleted = init.onlyDeleted;
    }
    if (init.order !== undefined) {
      this.order = init.order;
    }
    if (init.limit !== undefined) {
      this.limit = init.limit;
    }
    if (init.now !== undefined) {
      this.now = init.now;
    }
  }

  /** at returns the instant the filter judges time-dependent rules at. */
  at(): Date {
    if (this.now === undefined) {
      return new Date();
    }
    return this.now;
  }

  /**
   * validate reports a filter a provider could not honour, as the error to
   * raise or undefined. It exists so that a bad perspective is a usage error
   * at the point it is read, rather than a listing that quietly means
   * something else.
   */
  validate(): Error | undefined {
    for (const k of this.kinds) {
      if (!kindValid(k)) {
        return new Error(
          `filter: kind ${quote(k)} is not one of folder, project or task`,
        );
      }
    }
    for (const s of this.statuses) {
      if (!statusValid(s)) {
        return new Error(
          `filter: status ${quote(s)} is not one of active, on_hold, done or dropped`,
        );
      }
    }
    if (!availabilityFilterValid(this.availability)) {
      return new Error(
        `filter: availability ${quote(this.availability)} is not one of available, blocked or deferred`,
      );
    }
    if (!orderValid(this.order)) {
      return new Error(
        `filter: order ${quote(this.order)} is not one of position, created, updated, due or defer`,
      );
    }
    if (this.limit < 0) {
      return new Error(
        `filter: limit must not be negative, got ${this.limit}`,
      );
    }
    return undefined;
  }

  /**
   * matchesStatic reports whether t satisfies the part of this filter that
   * can be decided from the row alone. A provider is free to express exactly
   * this much in its query language — that is why it is separated out — and
   * the conformance suite checks that doing so gives the same answer as
   * evaluating it here.
   */
  matchesStatic(t: Task): boolean {
    if (this.onlyDeleted && !t.deleted()) {
      return false;
    }
    if (!this.onlyDeleted && !this.includeDeleted && t.deleted()) {
      return false;
    }
    if (this.kinds.length > 0 && !this.kinds.includes(t.kind)) {
      return false;
    }
    if (this.statuses.length > 0 && !this.statuses.includes(t.status)) {
      return false;
    }
    if (this.flagged !== undefined && this.flagged !== t.flagged) {
      return false;
    }
    if (this.scope.inbox && !t.inbox()) {
      return false;
    }
    if (this.scope.children && t.parentID !== this.scope.parentID) {
      return false;
    }
    if (!matchTags(this, t)) {
      return false;
    }
    const at = this.at();
    if (
      this.deferBefore !== undefined &&
      (t.deferAt === undefined || !before(t.deferAt, this.deferBefore))
    ) {
      return false;
    }
    if (
      this.deferAfter !== undefined &&
      (t.deferAt === undefined || !after(t.deferAt, this.deferAfter))
    ) {
      return false;
    }
    if (this.hasDue !== undefined && this.hasDue !== (t.dueAt !== undefined)) {
      return false;
    }
    if (
      this.dueBefore !== undefined &&
      (t.dueAt === undefined || !before(t.dueAt, this.dueBefore))
    ) {
      return false;
    }
    if (
      this.dueAfter !== undefined &&
      (t.dueAt === undefined || !after(t.dueAt, this.dueAfter))
    ) {
      return false;
    }
    if (this.reviewDueBefore !== undefined) {
      const next = nextReviewAt(t, at);
      if (next === undefined || !before(next, this.reviewDueBefore)) {
        return false;
      }
    }
    return true;
  }

  /**
   * matches reports whether t satisfies the whole of this filter. tr may be
   * undefined when the filter needs no tree, which `needsTree` reports.
   */
  matches(t: Task, tr: Tree | undefined): boolean {
    if (!this.matchesStatic(t)) {
      return false;
    }
    if (tr === undefined) {
      return true;
    }
    if (this.scope.subtree !== '' && !tr.hasDescendant(this.scope.subtree, t.id)) {
      return false;
    }
    if (this.availability === AvailabilityAny) {
      return true;
    }
    const a = tr.availability(t.id, this.at());
    switch (this.availability) {
      case AvailabilityAvailable:
        return a.available;
      case AvailabilityBlocked:
        return !a.available;
      case AvailabilityDeferred:
        return !a.available && ruleDeferral(a.rule);
    }
    return true;
  }

  /**
   * needsTree reports whether answering this filter requires the whole tree
   * rather than one row at a time. A provider uses it to decide whether it
   * can stream a query straight back.
   */
  needsTree(): boolean {
    return (
      this.availability !== AvailabilityAny ||
      this.scope.subtree !== '' ||
      this.order === OrderPosition ||
      this.order === ''
    );
  }

  /**
   * toJSON is here so a Filter written into a perspective reads back as the
   * same filter. The keys and their order are the stored format; changing one
   * is a breaking change to every saved perspective, which is why the method
   * is written out by hand rather than left to a serialiser whose rules could
   * change under it.
   */
  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (this.kinds.length > 0) {
      out['kinds'] = this.kinds;
    }
    if (this.statuses.length > 0) {
      out['statuses'] = this.statuses;
    }
    if (this.availability !== '') {
      out['availability'] = this.availability;
    }
    if (this.flagged !== undefined) {
      out['flagged'] = this.flagged;
    }
    if (!this.scope.isZero()) {
      out['scope'] = this.scope.toJSON();
    }
    if (this.tags.length > 0) {
      out['tags'] = this.tags;
    }
    if (this.tagsAny) {
      out['tags_any'] = true;
    }
    if (this.deferBefore !== undefined) {
      out['defer_before'] = stamp(this.deferBefore);
    }
    if (this.deferAfter !== undefined) {
      out['defer_after'] = stamp(this.deferAfter);
    }
    if (this.dueBefore !== undefined) {
      out['due_before'] = stamp(this.dueBefore);
    }
    if (this.dueAfter !== undefined) {
      out['due_after'] = stamp(this.dueAfter);
    }
    if (this.hasDue !== undefined) {
      out['has_due'] = this.hasDue;
    }
    if (this.reviewDueBefore !== undefined) {
      out['review_due_before'] = stamp(this.reviewDueBefore);
    }
    if (this.includeDeleted) {
      out['include_deleted'] = true;
    }
    if (this.onlyDeleted) {
      out['only_deleted'] = true;
    }
    if (this.order !== '') {
      out['order'] = this.order;
    }
    if (this.limit !== 0) {
      out['limit'] = this.limit;
    }
    // `now` is deliberately absent: it is a clock reading, not part of what
    // was saved. Go tagged it `json:"-"` for the same reason.
    return out;
  }
}

/**
 * The stored keys, in order, mapped to how each one is read back. Keeping the
 * two directions in one table is what makes it impossible to add a key to
 * `toJSON` and forget it here, which would make the new key unreadable by the
 * very binary that wrote it.
 */
const storedKeys: ReadonlyMap<
  string,
  (f: Filter, v: unknown, key: string) => void
> = new Map<string, (f: Filter, v: unknown, key: string) => void>([
  ['kinds', (f, v, k) => void (f.kinds = stringList(v, k))],
  ['statuses', (f, v, k) => void (f.statuses = stringList(v, k))],
  ['availability', (f, v, k) => void (f.availability = text(v, k))],
  ['flagged', (f, v, k) => void (f.flagged = flag(v, k))],
  ['scope', (f, v, k) => void (f.scope = scopeFrom(v, k))],
  ['tags', (f, v, k) => void (f.tags = stringList(v, k))],
  ['tags_any', (f, v, k) => void (f.tagsAny = flag(v, k))],
  ['defer_before', (f, v, k) => void (f.deferBefore = instant(v, k))],
  ['defer_after', (f, v, k) => void (f.deferAfter = instant(v, k))],
  ['due_before', (f, v, k) => void (f.dueBefore = instant(v, k))],
  ['due_after', (f, v, k) => void (f.dueAfter = instant(v, k))],
  ['has_due', (f, v, k) => void (f.hasDue = flag(v, k))],
  ['review_due_before', (f, v, k) => void (f.reviewDueBefore = instant(v, k))],
  ['include_deleted', (f, v, k) => void (f.includeDeleted = flag(v, k))],
  ['only_deleted', (f, v, k) => void (f.onlyDeleted = flag(v, k))],
  ['order', (f, v, k) => void (f.order = text(v, k))],
  ['limit', (f, v, k) => void (f.limit = whole(v, k))],
]);

/**
 * reviewDueAsOf returns the two fields a "due for review" listing sets, so
 * that every command asking that question asks it the same way: the window
 * bound and the instant the derived next_review_at is computed at.
 *
 * The bound is exclusive, so it is a moment *past* now rather than now
 * itself: an item that has never been reviewed, or whose interval elapsed
 * exactly now, has a next_review_at of now and is due now.
 *
 * It exists because the two callers once disagreed. `tdo project ls
 * --needs-review` set both fields to the bound, which made a never-reviewed
 * project's next_review_at equal the bound and so fall outside an exclusive
 * comparison — the one project most obviously due for review was the one
 * listing that left it out, while `tdo review` listed it. Sharing the window
 * is what keeps the two from drifting apart again.
 */
export function reviewDueAsOf(now: Date): { now: Date; reviewDueBefore: Date } {
  return { now, reviewDueBefore: new Date(now.getTime() + 1) };
}

/**
 * filterFromJSON reads a stored filter and refuses one carrying a key this
 * binary does not know.
 *
 * Ignoring it is the tempting option and the dangerous one: every field in a
 * Filter narrows a listing, so a key dropped on the way in produces a *wider*
 * query than the one that was saved. A perspective saved as "flagged, not
 * deferred, due this week" would quietly come back as "everything", and the
 * user would work from that list believing it was their saved one. A refusal
 * is visible; a wider answer is not. The caller turns this into a usage error
 * naming the perspective, so the way out is to re-save it with the binary
 * that wrote it, or to edit the stored filter by hand.
 */
export function filterFromJSON(data: unknown): Filter {
  const raw = typeof data === 'string' ? (JSON.parse(data) as unknown) : data;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('filter: a stored filter must be a JSON object');
  }
  const f = new Filter();
  for (const [key, value] of Object.entries(raw)) {
    const read = storedKeys.get(key);
    if (read === undefined) {
      throw new Error(
        `filter: unknown field ${quote(key)}: it was written by a newer tdo, ` +
          `and running it here would widen the saved query rather than narrow it`,
      );
    }
    if (value === null) {
      // A null is how a key that was never set can come back from a
      // hand-edited document; it means the same as the key being absent.
      continue;
    }
    read(f, value, key);
  }
  return f;
}

function typeError(key: string, want: string): Error {
  return new Error(`filter: ${key} must be ${want}`);
}

function text(v: unknown, key: string): string {
  if (typeof v !== 'string') {
    throw typeError(key, 'a string');
  }
  return v;
}

function flag(v: unknown, key: string): boolean {
  if (typeof v !== 'boolean') {
    throw typeError(key, 'a boolean');
  }
  return v;
}

function whole(v: unknown, key: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw typeError(key, 'a whole number');
  }
  return v;
}

function stringList(v: unknown, key: string): string[] {
  if (!Array.isArray(v) || v.some((e) => typeof e !== 'string')) {
    throw typeError(key, 'a list of strings');
  }
  return v as string[];
}

function instant(v: unknown, key: string): Date {
  const s = text(v, key);
  const t = new Date(s);
  if (Number.isNaN(t.getTime())) {
    throw typeError(key, 'an RFC 3339 timestamp');
  }
  return t;
}

function scopeFrom(v: unknown, key: string): Scope {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw typeError(key, 'an object');
  }
  const scope = new Scope();
  for (const [k, value] of Object.entries(v)) {
    switch (k) {
      case 'parent_id':
        scope.parentID = text(value, 'scope.parent_id');
        break;
      case 'children':
        scope.children = flag(value, 'scope.children');
        break;
      case 'subtree':
        scope.subtree = text(value, 'scope.subtree');
        break;
      case 'inbox':
        scope.inbox = flag(value, 'scope.inbox');
        break;
      default:
        throw new Error(
          `filter: unknown field ${quote(`scope.${k}`)}: it was written by a ` +
            `newer tdo, and running it here would widen the saved query ` +
            `rather than narrow it`,
        );
    }
  }
  return scope;
}

/**
 * stamp renders a bound the way Go's RFC3339Nano did: the sub-second part is
 * written only when there is one. `task.formatTime` always drops it, which is
 * right for a stored timestamp and wrong for a filter bound a caller may have
 * set to the millisecond.
 */
function stamp(t: Date): string {
  return t.toISOString().replace(/\.000Z$/, 'Z');
}

/** Go's `a.Before(b)` and `a.After(b)`, which compare instants and not zones. */
function before(a: Date, b: Date): boolean {
  return a.getTime() < b.getTime();
}

function after(a: Date, b: Date): boolean {
  return a.getTime() > b.getTime();
}

/** Go's `%q`, which is what the messages above were written against. */
function quote(s: string): string {
  return JSON.stringify(s);
}

/**
 * matchTags requires every listed tag by default and any one of them when
 * tagsAny is set. Comparison is case-insensitive, because a tag is typed.
 */
function matchTags(f: Filter, t: Task): boolean {
  if (f.tags.length === 0) {
    return true;
  }
  for (const want of f.tags) {
    const have = t.hasTag(want.trim());
    if (f.tagsAny && have) {
      return true;
    }
    if (!f.tagsAny && !have) {
      return false;
    }
  }
  return !f.tagsAny;
}
