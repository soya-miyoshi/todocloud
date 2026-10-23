// Module store defines the provider boundary.
//
// Every provider implements Store and nothing provider-specific crosses this
// module: the command layer only ever holds a Store, a task.Task and the
// errors below. Filters here cover the required fields only, because those are
// the ones every provider can push down to the server. Conditions on
// user-defined fields are evaluated on the client (see Condition), which keeps
// the same behaviour on SQLite and on a provider that would demand a composite
// index for it.
//
// Two things in this module are deliberately not an implementation's
// business. The tree rules of PLAN.md §3.1 and the availability rules of §3.3
// are defined here, once, as pure functions over an in-memory tree. A provider
// may push part of either down to the server for speed, but the answer must
// equal what these functions give, and the conformance suite checks that it
// does.
//
// Port notes, where TypeScript cannot hold the Go shape exactly:
//
//   - Go's sentinel errors are `errors.New` values compared with `errors.Is`.
//     They stay values here and are attached as a thrown error's `cause`, the
//     way `recur.ErrNoRepeat` already is; each one has a matching `isX`
//     predicate that walks the `cause` chain. `exit.classify` keys on four of
//     them, so the predicates are the contract and not a convenience.
//   - Go returns `(value, ok)`; the accessors here return `undefined` for the
//     not-ok case instead, which is the same information in one value.
//   - Go's `context.Context` has no TypeScript equivalent and the CLI never
//     cancelled a store call, so it is dropped rather than replaced by an
//     `AbortSignal`. A provider that wants cancellation can take one in its
//     own constructor, where it is provider-specific and stays out of this
//     interface.
//   - `Order`, `AvailabilityFilter` and `Rule` keep Go's defined-string-type
//     shape: a value written by a newer binary can be anything, and the
//     `*Valid` predicates are where that is caught.
//   - `Tree.SortKey` renders a position offset past zero. The offset is 2^62,
//     which a JavaScript number cannot hold alongside a position without
//     losing the position, so the arithmetic is BigInt. See `sortKey`.

import {
  type Fields,
  type Status,
  KeyID,
  KeyKind,
  KeyStatus,
  KeyTitle,
  StatusActive,
  StatusDropped,
  StatusOnHold,
  Task,
  Fields as FieldsOf,
  parseValue,
} from '../task.ts';

// A type-only import, so filter.ts importing this module back is not a
// runtime cycle.
import type { EventItem, EventLink } from './event.ts';
import type { Filter } from './filter.ts';

/**
 * Walks the `cause` chain, outermost first, the way errors.Is does. The chain
 * is finite in practice; the visited set guards against a cycle rather than
 * expecting one.
 */
function* chain(err: unknown): Generator<unknown> {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur !== null && cur !== undefined && !seen.has(cur)) {
    seen.add(cur);
    yield cur;
    cur = typeof cur === 'object' && 'cause' in cur ? cur.cause : undefined;
  }
}

/** Reports whether err, or anything it wraps, is the sentinel value want. */
function wrapsSentinel(err: unknown, want: Error): boolean {
  for (const e of chain(err)) {
    if (e === want) {
      return true;
    }
  }
  return false;
}

// Sentinel errors the command layer maps onto exit codes.

/** ErrNotFound is reported when no task matches a reference. Exit 5. */
export const ErrNotFound = new Error('task not found');
/**
 * ErrAmbiguous is reported when an id prefix matches several tasks. Exit 6.
 */
export const ErrAmbiguous = new Error('ambiguous task id');
/**
 * ErrNotInitialized is reported when the provider holds no schema yet.
 * Exit 3.
 */
export const ErrNotInitialized = new Error(
  'store is not initialized; run `tdo init`',
);
/**
 * ErrExists is reported when a task with that id is already stored. It lets a
 * caller decide: `tdo import` counts it as skipped.
 */
export const ErrExists = new Error('task already exists');
/**
 * ErrBadParent is reported when the parent's kind may not contain the
 * child's — a project under a project, a task under a folder. Exit 2.
 */
export const ErrBadParent = new Error('this kind of item cannot go there');
/**
 * ErrCycle is reported when a move would make an item its own ancestor. A
 * broken tree is worse than a rejected command. Exit 2.
 */
export const ErrCycle = new Error('that move would put an item inside itself');
/**
 * ErrNotEmpty is reported by purge on a container that still has children.
 * `tdo rm --purge --recursive` is the way to mean it.
 */
export const ErrNotEmpty = new Error('container is not empty');

/** Reports whether err, or anything it wraps, is ErrNotFound. */
export function isNotFound(err: unknown): boolean {
  return wrapsSentinel(err, ErrNotFound);
}

/** Reports whether err, or anything it wraps, is ErrAmbiguous. */
export function isAmbiguous(err: unknown): boolean {
  return wrapsSentinel(err, ErrAmbiguous);
}

/** Reports whether err, or anything it wraps, is ErrNotInitialized. */
export function isNotInitialized(err: unknown): boolean {
  return wrapsSentinel(err, ErrNotInitialized);
}

/** Reports whether err, or anything it wraps, is ErrExists. */
export function isExists(err: unknown): boolean {
  return wrapsSentinel(err, ErrExists);
}

/** Reports whether err, or anything it wraps, is ErrBadParent. */
export function isBadParent(err: unknown): boolean {
  return wrapsSentinel(err, ErrBadParent);
}

/** Reports whether err, or anything it wraps, is ErrCycle. */
export function isCycle(err: unknown): boolean {
  return wrapsSentinel(err, ErrCycle);
}

/** Reports whether err, or anything it wraps, is ErrNotEmpty. */
export function isNotEmpty(err: unknown): boolean {
  return wrapsSentinel(err, ErrNotEmpty);
}

/**
 * Rule names the reason an item cannot be worked on. It is part of the --json
 * shape: `tdo ls --json` carries available and, when that is false, blocked_by
 * naming the rule and the item responsible, so that a caller never has to
 * recompute this and an agent can say *why* nothing is actionable.
 */
export type Rule =
  | ''
  | 'not_actionable'
  | 'deleted'
  | 'status'
  | 'deferred'
  | 'sequential'
  | 'missing_parent'
  | 'ancestor_deleted'
  | 'ancestor_status'
  | 'ancestor_deferred'
  | 'ancestor_sequential'
  | 'tag_status'
  | 'ancestor_tag_status'
  | 'event'
  | 'ancestor_event'
  | (string & {});

/** RuleNone is the zero value: nothing is blocking. */
export const RuleNone: Rule = '';
/**
 * RuleNotActionable is a folder. A folder organises; it is never something to
 * do, whatever its status.
 */
export const RuleNotActionable: Rule = 'not_actionable';
/** RuleDeleted is a tombstoned item. */
export const RuleDeleted: Rule = 'deleted';
/** RuleStatus is an item that is not active: on hold, done or dropped. */
export const RuleStatus: Rule = 'status';
/** RuleDeferred is an item whose own defer date is still in the future. */
export const RuleDeferred: Rule = 'deferred';
/**
 * RuleSequential is an item whose parent is sequential and which is not the
 * first of that parent's children still open. blockedBy names the sibling
 * that is next instead.
 */
export const RuleSequential: Rule = 'sequential';
/**
 * RuleMissingParent is an item whose parent_id names nothing. It cannot
 * happen through this interface, but a database edited by hand or a
 * half-finished sync can produce it, and an orphan is not available: treating
 * it as available would surface items from a subtree the user thinks is on
 * hold.
 */
export const RuleMissingParent: Rule = 'missing_parent';
// The ancestor rules are the rules above applied to something further up the
// tree. blockedBy names that ancestor — the nearest offending one, which is
// the one the user would act on.
export const RuleAncestorDeleted: Rule = 'ancestor_deleted';
export const RuleAncestorStatus: Rule = 'ancestor_status';
export const RuleAncestorDeferred: Rule = 'ancestor_deferred';
export const RuleAncestorSequential: Rule = 'ancestor_sequential';
/**
 * RuleTagStatus is an item carrying a tag that is on hold or dropped. `tag`
 * names the tag responsible; blockedBy is the item's own id, since the item
 * is where the tag is.
 */
export const RuleTagStatus: Rule = 'tag_status';
/**
 * RuleAncestorTagStatus is the same rule applied to an ancestor: a project
 * tagged with a context that is on hold holds back everything inside it,
 * exactly as putting the project itself on hold would. OmniFocus does not
 * inherit tags down the tree; this does, because the alternative is a project
 * that is out of play with its actions still offered as next actions.
 */
export const RuleAncestorTagStatus: Rule = 'ancestor_tag_status';
/**
 * RuleEvent is an item waiting for an event that has not occurred. blockedBy
 * names the event — the first such one, in id order — which is what a caller
 * would go and mark as occurred. It is an event id, not a task id.
 */
export const RuleEvent: Rule = 'event';
/**
 * RuleAncestorEvent is the same rule applied to an ancestor: a project that
 * waits for an event holds back everything inside it, as putting it on hold
 * would. blockedBy names the event, not the project, since the event is what
 * will change the answer.
 */
export const RuleAncestorEvent: Rule = 'ancestor_event';

/**
 * ruleDeferral reports whether the rule is a defer date rather than a hold, a
 * completion or an ordering. `tdo ls --deferred` asks what is waiting for a
 * date, which is a different question from what is stuck.
 */
export function ruleDeferral(r: Rule): boolean {
  return r === RuleDeferred || r === RuleAncestorDeferred;
}

/** Availability is the answer §3.3 gives for one item. */
export class Availability {
  /** available is true when every rule passes. */
  available = false;
  /** rule is the first rule that failed, RuleNone when none did. */
  rule: Rule = RuleNone;
  /**
   * blockedBy is the id of the item responsible: the item itself for its own
   * status or defer date, the ancestor for an ancestor rule, the sibling that
   * is next for a sequential one.
   */
  blockedBy = '';
  /**
   * tag is the tag responsible, set only by the two tag rules. It is the
   * tag's stored spelling, which is what a user would type to lift the hold.
   */
  tag = '';
  /**
   * waitsOn is every event the item waits for, whether or not it has occurred.
   * It is set by Tree on every answer so that the one call that already
   * computes availability also says what an item is waiting for, in id order;
   * it is empty for an item that waits for nothing.
   */
  waitsOn: string[] = [];

  constructor(init?: {
    available?: boolean | undefined;
    rule?: Rule | undefined;
    blockedBy?: string | undefined;
    tag?: string | undefined;
  }) {
    if (init === undefined) {
      return;
    }
    if (init.available !== undefined) {
      this.available = init.available;
    }
    if (init.rule !== undefined) {
      this.rule = init.rule;
    }
    if (init.blockedBy !== undefined) {
      this.blockedBy = init.blockedBy;
    }
    if (init.tag !== undefined) {
      this.tag = init.tag;
    }
  }

  /**
   * toJSON writes the documented shape: a bare true, or false alongside a
   * blocked_by object naming the rule and the item.
   */
  toJSON(): true | Record<string, unknown> {
    if (this.available) {
      return true;
    }
    const out: Record<string, unknown> = {
      available: false,
      rule: this.rule,
      task_id: this.blockedBy,
    };
    if (this.tag !== '') {
      // Only the tag rules set it, so a caller that switches on `rule` never
      // has to ask whether the key might be there for another one.
      out['tag'] = this.tag;
    }
    return out;
  }
}

/**
 * available is the answer for an item nothing is blocking. Go had it as an
 * unexported package variable; it is a function here so no caller can mutate
 * the one shared answer, and it is exported because Tree lives in
 * availability.ts rather than in this file.
 */
export function available(): Availability {
  return new Availability({ available: true });
}

/** blocked is the answer for an item one rule holds back. */
export function blocked(r: Rule, by: string): Availability {
  return new Availability({ rule: r, blockedBy: by });
}

/**
 * blockedByTag is blocked for the two rules that name a tag as well as an
 * item.
 */
export function blockedByTag(r: Rule, by: string, tag: string): Availability {
  return new Availability({ rule: r, blockedBy: by, tag });
}

/** Order selects the sort order of a listing. */
export type Order =
  | ''
  | 'position'
  | 'created'
  | 'updated'
  | 'due'
  | 'defer'
  | (string & {});

/**
 * OrderPosition is tree order: siblings by position, ties by id. It is the
 * default, because it is the order the user arranged.
 */
export const OrderPosition: Order = 'position';
/** OrderCreated sorts by id, which is creation order. */
export const OrderCreated: Order = 'created';
/** OrderUpdated sorts by updated_at, most recent last. */
export const OrderUpdated: Order = 'updated';
/**
 * OrderDue sorts by due_at, soonest first; items with no due date sort last,
 * since a listing by deadline is about the ones that have one.
 */
export const OrderDue: Order = 'due';
/** OrderDefer sorts by defer_at the same way. */
export const OrderDefer: Order = 'defer';

/** Reports whether o is a known order. */
export function orderValid(o: Order): boolean {
  switch (o) {
    case '':
    case OrderPosition:
    case OrderCreated:
    case OrderUpdated:
    case OrderDue:
    case OrderDefer:
      return true;
  }
  return false;
}

/** AvailabilityFilter narrows a listing by the computation of §3.3. */
export type AvailabilityFilter =
  | ''
  | 'available'
  | 'blocked'
  | 'deferred'
  | (string & {});

/** AvailabilityAny does not filter on availability. */
export const AvailabilityAny: AvailabilityFilter = '';
/**
 * AvailabilityAvailable keeps only items that can be worked on now. It is
 * what `tdo ls` asks for.
 */
export const AvailabilityAvailable: AvailabilityFilter = 'available';
/** AvailabilityBlocked keeps only items that cannot, for any reason. */
export const AvailabilityBlocked: AvailabilityFilter = 'blocked';
/**
 * AvailabilityDeferred keeps only items held back by a defer date, their own
 * or an ancestor's. It backs `tdo ls --deferred`, which asks what is waiting
 * rather than what is stuck.
 */
export const AvailabilityDeferred: AvailabilityFilter = 'deferred';

/** Reports whether a is a known availability filter. */
export function availabilityFilterValid(a: AvailabilityFilter): boolean {
  switch (a) {
    case AvailabilityAny:
    case AvailabilityAvailable:
    case AvailabilityBlocked:
    case AvailabilityDeferred:
      return true;
  }
  return false;
}

/** The fields a Scope may be built from. */
export interface ScopeInit {
  parentID?: string | undefined;
  children?: boolean | undefined;
  subtree?: string | undefined;
  inbox?: boolean | undefined;
}

/** Scope selects a slice of the tree. */
export class Scope {
  /**
   * parentID restricts the listing to the direct children of this id. The
   * empty string with children true means the top level.
   */
  parentID = '';
  /**
   * children is true when parentID is meaningful, so that "children of the
   * top level" is expressible and distinct from "anywhere".
   */
  children = false;
  /** subtree restricts the listing to this id and everything beneath it. */
  subtree = '';
  /** inbox keeps only loose actions: tasks with no parent. */
  inbox = false;

  constructor(init?: ScopeInit) {
    if (init === undefined) {
      return;
    }
    if (init.parentID !== undefined) {
      this.parentID = init.parentID;
    }
    if (init.children !== undefined) {
      this.children = init.children;
    }
    if (init.subtree !== undefined) {
      this.subtree = init.subtree;
    }
    if (init.inbox !== undefined) {
      this.inbox = init.inbox;
    }
  }

  /** empty reports whether this scope restricts nothing. */
  empty(): boolean {
    return !this.children && this.subtree === '' && !this.inbox;
  }

  /**
   * isZero reports whether every field is unset, which is what Go's
   * `omitzero` tag on Filter.Scope tests. It is not `empty`: a parentID set
   * with children false restricts nothing and is still not the zero value.
   */
  isZero(): boolean {
    return (
      this.parentID === '' &&
      !this.children &&
      this.subtree === '' &&
      !this.inbox
    );
  }

  /** toJSON writes the stored shape, omitting the unset keys as Go does. */
  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (this.parentID !== '') {
      out['parent_id'] = this.parentID;
    }
    if (this.children) {
      out['children'] = true;
    }
    if (this.subtree !== '') {
      out['subtree'] = this.subtree;
    }
    if (this.inbox) {
      out['inbox'] = true;
    }
    return out;
  }
}

/**
 * Perspective is a saved query: a name plus the filter a command line could
 * have expressed (§3.6). It never stores results and never pins ids, so it
 * cannot go stale; running one is exactly equivalent to typing its filter.
 */
export interface Perspective {
  name: string;
  filter: Filter;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Tag is one tag: the spelling it is filed under, the status it carries and
 * how many live tasks are tagged with it.
 *
 * A tag has a status of its own because a context one cannot act in should
 * take its actions out of the way without anyone editing them one by one —
 * the "on hold" tag of §3.3a. Status is active, on_hold or dropped; done is
 * not a tag status, since a tag is never finished.
 */
export interface Tag {
  name: string;
  status: Status;
  count: number;
  note?: string | undefined;
}

/**
 * tagKey folds a tag to the key it is stored and compared under. Tags are
 * compared case-insensitively everywhere, because a tag is typed.
 */
export function tagKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * TagUse is one tag as the task table knows it: the key it is filed under,
 * the spelling the first task wrote, and how many live tasks carry it.
 */
export interface TagUse {
  key: string;
  name: string;
  count: number;
}

/**
 * TagRow is one row of the tag table: a tag that has a status of its own,
 * whether or not any task carries it.
 */
export interface TagRow {
  key: string;
  name: string;
  status: Status;
  note: string;
}

/**
 * mergeTags combines the tags in use with the tags that have a row, which is
 * what Store.tags returns. It lives here rather than in a provider because the
 * three cases are a decision and not a query: a tag in use with no row is
 * active, a tag with a row and no live task is still listed — putting a
 * context on hold must not be undone by finishing its last task — and a tag
 * with both takes its spelling from the row, since that is the one `tdo tag
 * rename` wrote.
 */
export function mergeTags(uses: TagUse[], rows: TagRow[]): Tag[] {
  const byKey = new Map<string, Tag>();
  const keys: string[] = [];
  const remember = (key: string, tag: Tag): void => {
    if (!byKey.has(key)) {
      keys.push(key);
    }
    byKey.set(key, tag);
  };
  for (const u of uses) {
    const key = tagKey(u.key);
    if (key === '') {
      continue;
    }
    remember(key, { name: u.name, status: StatusActive, count: u.count });
  }
  for (const r of rows) {
    const key = tagKey(r.key);
    if (key === '') {
      continue;
    }
    let status = r.status;
    if (!validTagStatus(status)) {
      // A status written by hand into the database is not allowed to hide a
      // tag or to block its tasks for an unnameable reason.
      status = StatusActive;
    }
    const tag: Tag = { name: r.name, status, count: 0, note: r.note };
    const existing = byKey.get(key);
    if (existing !== undefined) {
      tag.count = existing.count;
    }
    if (tag.name === '') {
      tag.name = key;
    }
    remember(key, tag);
  }
  keys.sort(compareStrings);
  return keys.map((key) => byKey.get(key) as Tag);
}

/**
 * validTagStatus reports whether s is a status a tag may hold. A tag is a
 * context, not a piece of work, so it is never done.
 */
export function validTagStatus(s: Status): boolean {
  switch (s) {
    case StatusActive:
    case StatusOnHold:
    case StatusDropped:
      return true;
  }
  return false;
}

/**
 * Store is one place tasks live.
 *
 * **Every method that talks to the provider is async.** That is not a blanket
 * "I/O might be slow" decision; it is forced by the providers. The turso
 * provider is `fetch` against `/v2/pipeline` and the PWA implements this
 * interface over `fetch` too, and a `fetch` cannot be awaited synchronously
 * in either runtime. A synchronous signature would therefore be
 * unimplementable by two of the three implementations. The sqlite provider is
 * `node:sqlite`, which *is* synchronous, so it pays only the cost of
 * returning an already-settled promise — the cheap direction of the trade.
 *
 * `describe` is the one exception and stays synchronous: it returns a
 * provider's own static, credential-free description of itself, it reads
 * nothing, and `checkVersion` and the output layer call it from synchronous
 * code. `close` is async because releasing an HTTP connection pool may be.
 *
 * Every id-addressed method normalises the id it is given the way
 * `id.normalize` does, because base32 is case-insensitive and a pasted id may
 * arrive lower-cased. A provider that skips that on one method makes rows
 * written through another unreachable.
 *
 * A failure is a thrown error, with the matching sentinel above attached as
 * its `cause`; the doc comments below name the sentinel each method owes.
 */
export interface Store {
  /** init creates the schema. It is idempotent. */
  init(): Promise<void>;

  /**
   * schemaVersion reports the schema version recorded in the store, or
   * throws ErrNotInitialized when there is none.
   */
  schemaVersion(): Promise<number>;

  /** migrate upgrades an existing store to the version this build expects. */
  migrate(): Promise<void>;

  /**
   * add stores a new task, tags included. The caller sets the id and the
   * timestamps. It enforces the tree rules: ErrBadParent when the parent's
   * kind may not contain this one, ErrNotFound when the parent is unknown,
   * ErrExists when the id is taken.
   */
  add(t: Task): Promise<void>;

  /** get returns the task with exactly this id, including a tombstoned one. */
  get(id: string): Promise<Task>;

  /**
   * findByPrefix returns the single task whose id starts with prefix, or
   * throws ErrNotFound / ErrAmbiguous.
   */
  findByPrefix(prefix: string): Promise<Task>;

  /** list returns the tasks matching f, sorted as f requests. */
  list(f: Filter): Promise<Task[]>;

  /**
   * update replaces the stored task with t, matched by id, tags included. It
   * enforces the same tree rules as add, plus ErrCycle when the new parent is
   * t itself or one of its descendants.
   */
  update(t: Task): Promise<void>;

  /**
   * move reparents a task and sets its position in one step. An empty
   * parentID moves it to the top level, which for a task is the inbox. It
   * reports ErrBadParent, ErrCycle or ErrNotFound as update does, and it
   * touches nothing else about the task but updated_at.
   */
  move(id: string, parentID: string, position: number, now: Date): Promise<void>;

  /**
   * children returns the direct children of parentID, in tree order,
   * tombstoned ones included: a caller asking what is inside a container is
   * usually about to delete or move it. An empty parentID returns the top
   * level.
   */
  children(parentID: string): Promise<Task[]>;

  /**
   * subtree returns id and everything beneath it, in pre-order, so that a
   * caller tombstoning a container can see exactly what it is about to take
   * with it. It throws ErrNotFound when id is unknown.
   */
  subtree(id: string): Promise<Task[]>;

  /**
   * availability computes §3.3 for each id over the whole tree, which is why
   * it is a store call and not something the caller can do with a listing:
   * the ancestors of a listed item may not be in the listing. An unknown id
   * is absent from the result rather than an error, so a caller may ask about
   * a stale reference. An unset now means the current time.
   */
  availability(now: Date, ...ids: string[]): Promise<Map<string, Availability>>;

  /**
   * purge removes a task irreversibly. Ordinary removal is an update that
   * sets the tombstone, so that multi-device sync stays possible. It reports
   * ErrNotEmpty when the task still has children, tombstoned ones included:
   * purging a container would otherwise orphan them.
   */
  purge(id: string): Promise<void>;

  /**
   * purgeSubtree removes a task and everything beneath it irreversibly and
   * returns how many rows went. It is what `tdo rm --purge --recursive`
   * calls, and the only way to purge a container.
   */
  purgeSubtree(id: string): Promise<number>;

  /**
   * tags returns every tag with its status and the number of live tasks
   * carrying it, sorted by name. A tag is listed when a live task carries it
   * or when it has a status of its own, so a tag put on hold does not
   * disappear from the list when its last task is finished.
   */
  tags(): Promise<Tag[]>;

  /**
   * setTagStatus records the status of a tag, creating its row when the tag
   * has none yet. The tag need not be in use: putting a context on hold
   * before filing anything under it is ordinary. A status validTagStatus
   * rejects is refused rather than stored.
   */
  setTagStatus(name: string, status: Status, now: Date): Promise<void>;

  /**
   * renameTag moves every task from one tag to another, keeping the status of
   * the destination when it already exists and carrying the source's over
   * when it does not. It reports ErrNotFound when the source tag is unknown,
   * and refuses an empty destination. Renaming a tag to its own spelling in
   * another case just restyles it.
   */
  renameTag(from: string, to: string, now: Date): Promise<void>;

  /**
   * removeTag takes a tag off every task that carries it and forgets its
   * status, returning how many tasks were changed. It reports ErrNotFound
   * when the tag is unknown. There is no tombstone: a tag is a label, and the
   * tasks themselves are untouched apart from losing it.
   */
  removeTag(name: string): Promise<number>;

  /**
   * addEvent stores a new event. The caller sets the id and the timestamps.
   * It reports ErrExists when the id is taken.
   */
  addEvent(e: EventItem): Promise<void>;

  /** getEvent returns the event with exactly this id, or throws ErrNotFound. */
  getEvent(id: string): Promise<EventItem>;

  /**
   * findEventByPrefix returns the single event whose id starts with prefix, or
   * throws ErrNotFound / ErrAmbiguous.
   */
  findEventByPrefix(prefix: string): Promise<EventItem>;

  /** events returns every event, oldest first. */
  events(): Promise<EventItem[]>;

  /** updateEvent replaces the stored event with e, matched by id. ErrNotFound if unknown. */
  updateEvent(e: EventItem): Promise<void>;

  /**
   * removeEvent forgets an event and every link to it, returning how many
   * items stopped waiting for it. It reports ErrNotFound when the id is
   * unknown. There is no tombstone: an event is not work, and what waited on
   * it is untouched apart from no longer waiting.
   */
  removeEvent(id: string): Promise<number>;

  /**
   * setWaits replaces the set of events a task waits for, creating and
   * removing links as needed, in the way a task's tags are replaced. It
   * reports ErrNotFound when the task or any of the events is unknown, and
   * touches nothing in that case.
   */
  setWaits(taskID: string, eventIDs: readonly string[]): Promise<void>;

  /** waits returns every link: which task waits for which event. */
  waits(): Promise<EventLink[]>;

  /**
   * savePerspective stores a perspective, replacing one of the same name.
   * Names are compared case-insensitively, since they are typed.
   */
  savePerspective(p: Perspective): Promise<void>;

  /** perspective returns one by name, or throws ErrNotFound. */
  perspective(name: string): Promise<Perspective>;

  /** perspectives returns all of them, sorted by name. */
  perspectives(): Promise<Perspective[]>;

  /**
   * deletePerspective removes one by name, or reports ErrNotFound. A
   * perspective is a query, so there is no tombstone to keep.
   */
  deletePerspective(name: string): Promise<void>;

  /**
   * describe returns a short, credential-free description of where the tasks
   * are, for `tdo config` and `tdo doctor`. It is the one synchronous method:
   * see the note on this interface.
   */
  describe(): string;

  /** ping checks that the store is reachable and initialized. */
  ping(): Promise<void>;

  /** close releases resources. */
  close(): Promise<void>;
}

/** The fields a Condition may be built from. */
export interface ConditionInit {
  minPriority?: number | undefined;
  match?: Record<string, string> | undefined;
}

/**
 * Condition is a client-side filter over the user-defined fields. Everything
 * a provider can index lives in Filter; this is the rest.
 */
export class Condition {
  /** minPriority keeps tasks at or above this priority. */
  minPriority = 0;
  /**
   * match requires the field at each key to equal the given value, as
   * rendered as text. It backs `--where key=value`.
   */
  match: Record<string, string> = {};

  constructor(init?: ConditionInit) {
    if (init === undefined) {
      return;
    }
    if (init.minPriority !== undefined) {
      this.minPriority = init.minPriority;
    }
    if (init.match !== undefined) {
      this.match = init.match;
    }
  }

  /** empty reports whether this condition filters nothing out. */
  empty(): boolean {
    return this.minPriority === 0 && Object.keys(this.match).length === 0;
  }

  /** matches reports whether t satisfies this condition. */
  matches(t: Task): boolean {
    if (this.minPriority > 0 && FieldsOf.priority(t.fields) < this.minPriority) {
      return false;
    }
    for (const [key, want] of Object.entries(this.match)) {
      if (!fieldEquals(t, key, want)) {
        return false;
      }
    }
    return true;
  }
}

function fieldEquals(t: Task, key: string, want: string): boolean {
  switch (key) {
    case KeyID:
      return t.id === want;
    case KeyTitle:
      return t.title === want;
    case KeyKind:
      return t.kind === want;
    case KeyStatus:
      return t.status === want;
  }
  const fields: Fields = t.fields;
  const s = FieldsOf.string(fields, key);
  if (s !== undefined) {
    return s === want;
  }
  const n = FieldsOf.int(fields, key);
  if (n !== undefined) {
    const parsed = parseValue(want);
    // Go asked whether the parsed value was an `int`; JavaScript has one
    // number type, so the question is whether it is a whole number — which is
    // the set of values Fields.int can have returned.
    if (typeof parsed === 'number' && Number.isInteger(parsed)) {
      return n === parsed;
    }
    return false;
  }
  const b = FieldsOf.bool(fields, key);
  if (b !== undefined) {
    const parsed = parseValue(want);
    return typeof parsed === 'boolean' && b === parsed;
  }
  return false;
}

/** apply filters and limits tasks on the client side. */
export function apply(tasks: Task[], c: Condition, limit: number): Task[] {
  const out: Task[] = [];
  for (const t of tasks) {
    if (!c.matches(t)) {
      continue;
    }
    out.push(t);
    if (limit > 0 && out.length === limit) {
      break;
    }
  }
  return out;
}

/**
 * sortTasks puts tasks in the order o asks for, in place. pathOf gives the
 * tree-order key of a task, as Tree.sortKey builds it; it may be undefined for
 * the orders that do not need one. A provider that cannot sort the way a
 * filter wants falls back to this, and the result is the one the conformance
 * suite expects.
 *
 * Go used sort.SliceStable; Array.prototype.sort has been required to be
 * stable since ES2019, so the ties below break the same way.
 */
export function sortTasks(
  tasks: Task[],
  o: Order,
  pathOf?: ((t: Task) => string[]) | undefined,
): void {
  switch (o) {
    case OrderUpdated:
      tasks.sort((a, b) => {
        if (a.updatedAt.getTime() !== b.updatedAt.getTime()) {
          return a.updatedAt.getTime() - b.updatedAt.getTime();
        }
        return compareStrings(a.id, b.id);
      });
      return;
    case OrderDue:
      sortByTime(tasks, (t) => t.dueAt);
      return;
    case OrderDefer:
      sortByTime(tasks, (t) => t.deferAt);
      return;
    case OrderCreated:
      tasks.sort((a, b) => compareStrings(a.id, b.id));
      return;
    default: {
      // OrderPosition
      if (pathOf === undefined) {
        tasks.sort((a, b) => compareStrings(a.id, b.id));
        return;
      }
      const keys = new Map<string, string[]>();
      for (const t of tasks) {
        keys.set(t.id, pathOf(t));
      }
      tasks.sort((x, y) => {
        const a = keys.get(x.id) ?? [];
        const b = keys.get(y.id) ?? [];
        for (let n = 0; n < a.length && n < b.length; n++) {
          if (a[n] !== b[n]) {
            return compareStrings(a[n] as string, b[n] as string);
          }
        }
        if (a.length !== b.length) {
          // A container sorts before the items inside it, which is the order
          // the tree is printed in.
          return a.length - b.length;
        }
        return compareStrings(x.id, y.id);
      });
      return;
    }
  }
}

/**
 * sortByTime sorts soonest first and puts the unset ones last: a listing by
 * deadline is about the items that have one.
 */
function sortByTime(tasks: Task[], at: (t: Task) => Date | undefined): void {
  tasks.sort((x, y) => {
    const a = at(x);
    const b = at(y);
    if (a === undefined && b === undefined) {
      return compareStrings(x.id, y.id);
    }
    if (a === undefined) {
      return 1;
    }
    if (b === undefined) {
      return -1;
    }
    if (a.getTime() !== b.getTime()) {
      return a.getTime() - b.getTime();
    }
    return compareStrings(x.id, y.id);
  });
}

/**
 * Go compares strings byte by byte; `<` on a JavaScript string compares
 * UTF-16 code units, which agrees for everything an id, a tag key or a sort
 * key holds.
 */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

