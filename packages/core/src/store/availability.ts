// The tree rules of PLAN.md §3.1 and the availability rules of §3.3, written
// once as pure functions over an in-memory tree.
//
// Rule, Availability and the three constructors for an answer live in
// store.ts, beside the Store interface that returns them; this file holds the
// Tree that computes them and the two tree-rule helpers every provider calls
// instead of writing the containment table out again.
//
// Port notes:
//
//   - Go's maps become `Map`s, so an id that happens to spell a property of
//     `Object.prototype` cannot shadow an entry.
//   - `Tree.SortKey` offsets the position past zero by 2^62. A JavaScript
//     number cannot hold 2^62 + 1 — it rounds back to 2^62 — so the
//     arithmetic is BigInt and only the rendered text leaves this file.

import {
  type Status,
  type Kind,
  kindCanContain,
  StatusActive,
  statusClosed,
  Task,
} from '../task.ts';
import {
  type Tag,
  Availability,
  available,
  blocked,
  blockedByTag,
  compareStrings,
  ErrBadParent,
  ErrCycle,
  RuleAncestorDeferred,
  RuleAncestorDeleted,
  RuleAncestorSequential,
  RuleAncestorStatus,
  RuleAncestorTagStatus,
  RuleDeferred,
  RuleDeleted,
  RuleMissingParent,
  RuleNotActionable,
  RuleSequential,
  RuleStatus,
  RuleTagStatus,
  tagKey,
} from './store.ts';

/**
 * Tree is a whole task list held in memory, indexed for the tree and
 * availability questions. It is how §3.1 and §3.3 are computed in one place:
 * a provider builds one from the rows it has and asks, rather than writing
 * the rules into SQL a second time.
 *
 * A Tree is a snapshot. It does not see writes made after it was built.
 */
export class Tree {
  private readonly byID = new Map<string, Task>();
  private readonly childrenOf = new Map<string, Task[]>();
  /**
   * tagStatus is the status of each tag, keyed by tagKey. A tag missing from
   * it is active, so a tree built without setTagStatuses — and a store that
   * has no tag rows yet — answers exactly as it did before tags carried a
   * status.
   */
  private tagStatus = new Map<string, Status>();
  /**
   * tagSpelling keeps the spelling a tag is stored under, so a block reason
   * names the tag the way the user wrote it.
   */
  private tagSpelling = new Map<string, string>();

  /**
   * Indexes tasks. Tombstoned tasks belong in it: they still occupy a place
   * in the tree, and leaving them out would silently promote their children
   * to roots.
   */
  constructor(tasks: readonly Task[] | null | undefined) {
    for (const t of tasks ?? []) {
      this.byID.set(t.id, t);
    }
    for (const t of tasks ?? []) {
      const siblings = this.childrenOf.get(t.parentID);
      if (siblings === undefined) {
        this.childrenOf.set(t.parentID, [t]);
      } else {
        siblings.push(t);
      }
    }
    for (const siblings of this.childrenOf.values()) {
      sortSiblings(siblings);
    }
  }

  /**
   * setTagStatuses tells the tree what each tag's status is, so that the two
   * tag rules of §3.3 can be answered. It is separate from the constructor
   * because the tag rows are a second query: a provider that has them passes
   * them in, and one that does not gets the same answers it always gave.
   *
   * Only the tags that are not active matter to the rules, but the whole set
   * is accepted so the caller does not have to know which those are.
   */
  setTagStatuses(tags: readonly Tag[]): void {
    this.tagStatus = new Map();
    this.tagSpelling = new Map();
    for (const tag of tags) {
      const key = tagKey(tag.name);
      if (key === '') {
        continue;
      }
      this.tagStatus.set(key, tag.status);
      this.tagSpelling.set(key, tag.name);
    }
  }

  /**
   * blockingTag reports the tag holding t back, if any. A task may carry
   * several tags that are not active; the one reported is the first in sorted
   * order, so the answer does not depend on the order the rows came back in.
   */
  private blockingTag(t: Task): string | undefined {
    if (this.tagStatus.size === 0 || t.tags.length === 0) {
      return undefined;
    }
    const keys: string[] = [];
    for (const tag of t.tags) {
      const key = tagKey(tag);
      if (key === '') {
        continue;
      }
      const status = this.tagStatus.get(key);
      if (status !== undefined && status !== StatusActive) {
        keys.push(key);
      }
    }
    if (keys.length === 0) {
      return undefined;
    }
    keys.sort(compareStrings);
    const first = keys[0] as string;
    const spelling = this.tagSpelling.get(first);
    return spelling !== undefined && spelling !== '' ? spelling : first;
  }

  /** len reports how many tasks the tree holds. */
  len(): number {
    return this.byID.size;
  }

  /**
   * get returns the task with this id, or undefined. Go returned
   * `(*task.Task, bool)`.
   */
  get(id: string): Task | undefined {
    return this.byID.get(id);
  }

  /**
   * children returns the direct children of parentID in tree order. An empty
   * parentID returns the top level. The slice is a copy, so a caller cannot
   * reorder the tree's own index.
   */
  children(parentID: string): Task[] {
    return [...(this.childrenOf.get(parentID) ?? [])];
  }

  /**
   * ancestors returns the chain above id, nearest first. It stops at a parent
   * that is not in the tree, so a cycle introduced outside this module cannot
   * make it loop.
   */
  ancestors(id: string): Task[] {
    const out: Task[] = [];
    const seen = new Set<string>([id]);
    let t = this.byID.get(id);
    while (t !== undefined && t.parentID !== '' && !seen.has(t.parentID)) {
      seen.add(t.parentID);
      t = this.byID.get(t.parentID);
      if (t === undefined) {
        break;
      }
      out.push(t);
    }
    return out;
  }

  /**
   * subtree returns id and everything beneath it, in pre-order: a container
   * is followed by its children in tree order. It is what a recursive delete
   * acts on, so the order is the order a caller would print.
   */
  subtree(id: string): Task[] {
    const root = this.byID.get(id);
    if (root === undefined) {
      return [];
    }
    const out: Task[] = [];
    const seen = new Set<string>();
    const walk = (t: Task): void => {
      if (seen.has(t.id)) {
        return;
      }
      seen.add(t.id);
      out.push(t);
      for (const c of this.childrenOf.get(t.id) ?? []) {
        walk(c);
      }
    };
    walk(root);
    return out;
  }

  /**
   * hasDescendant reports whether candidate is id itself or sits beneath it.
   * It is the cycle check: moving id under one of its own descendants would
   * cut that branch loose from the root.
   */
  hasDescendant(id: string, candidate: string): boolean {
    if (id === candidate) {
      return true;
    }
    for (const t of this.subtree(id)) {
      if (t.id === candidate) {
        return true;
      }
    }
    return false;
  }

  /**
   * availability answers §3.3 for one id. An unknown id is reported as a
   * missing parent rather than as available, because the alternative is
   * claiming an item nobody can see is ready to do.
   *
   * The rules are checked in order of how specific they are, so the reason a
   * caller is handed is the one closest to the item: its own state first,
   * then its place among its siblings, then the nearest ancestor that is in
   * the way.
   */
  availability(id: string, now: Date): Availability {
    const t = this.byID.get(id);
    if (t === undefined) {
      return blocked(RuleMissingParent, id);
    }
    const at = now;

    if (t.deleted()) {
      return blocked(RuleDeleted, t.id);
    }
    if (!t.actionable()) {
      return blocked(RuleNotActionable, t.id);
    }
    if (t.status !== StatusActive) {
      return blocked(RuleStatus, t.id);
    }
    if (deferredAt(t, at)) {
      return blocked(RuleDeferred, t.id);
    }
    // A tag that is on hold or dropped is the item's own state too: it is
    // checked after the item's status and defer date, which are more
    // specific, and before its place among its siblings.
    const ownTag = this.blockingTag(t);
    if (ownTag !== undefined) {
      return blockedByTag(RuleTagStatus, t.id, ownTag);
    }
    const next = this.blockingSibling(t);
    if (next !== undefined) {
      return blocked(RuleSequential, next);
    }

    // Ancestors, nearest first. Each one is checked with the same rules; a
    // folder among them is not a block, because organising a project into a
    // folder must not make its actions disappear.
    for (const a of this.ancestors(t.id)) {
      if (a.deleted()) {
        return blocked(RuleAncestorDeleted, a.id);
      }
      if (a.status !== StatusActive) {
        return blocked(RuleAncestorStatus, a.id);
      }
      if (deferredAt(a, at)) {
        return blocked(RuleAncestorDeferred, a.id);
      }
      const tag = this.blockingTag(a);
      if (tag !== undefined) {
        return blockedByTag(RuleAncestorTagStatus, a.id, tag);
      }
      if (this.blockingSibling(a) !== undefined) {
        // §3.3 rule 4 speaks of the item's own parent, but the rule is
        // transitive in practice: the second action group of a sequential
        // project has not come up yet, so neither has anything inside it.
        // Reporting the ancestor is what lets a caller explain the hold.
        return blocked(RuleAncestorSequential, a.id);
      }
    }

    // An item whose parent_id names nothing is an orphan; ancestors stops
    // silently at one, so it is checked here rather than in the loop.
    if (t.parentID !== '' && !this.byID.has(t.parentID)) {
      return blocked(RuleMissingParent, t.parentID);
    }
    return available();
  }

  /**
   * blockingSibling reports the child that is next in a sequential parent
   * when t is not it. Closed and tombstoned siblings are skipped: a
   * sequential list moves on as its items are finished or dropped, and a
   * deleted item must not stop the list forever.
   */
  private blockingSibling(t: Task): string | undefined {
    if (t.parentID === '') {
      return undefined;
    }
    const parent = this.byID.get(t.parentID);
    if (parent === undefined || !parent.sequential) {
      return undefined;
    }
    for (const c of this.childrenOf.get(parent.id) ?? []) {
      if (c.deleted() || statusClosed(c.status)) {
        continue;
      }
      if (c.id === t.id) {
        return undefined;
      }
      return c.id;
    }
    return undefined;
  }

  /**
   * availabilityOf answers §3.3 for several ids at once over one tree. It is
   * the shape the Store method returns.
   */
  availabilityOf(now: Date, ...ids: string[]): Map<string, Availability> {
    const out = new Map<string, Availability>();
    for (const id of ids) {
      if (!this.byID.has(id)) {
        continue;
      }
      out.set(id, this.availability(id, now));
    }
    return out;
  }

  /**
   * path returns the ids from the root down to id, id last. It is what a
   * listing sorted in tree order compares.
   */
  path(id: string): string[] {
    const ancestors = this.ancestors(id);
    const out: string[] = [];
    for (let i = ancestors.length - 1; i >= 0; i--) {
      out.push((ancestors[i] as Task).id);
    }
    out.push(id);
    return out;
  }

  /**
   * all returns every task the tree holds, in no particular order. It is how
   * a provider with no transaction projects the state a write is about to
   * produce: rebuild a tree from these with the written row swapped in, and
   * the shared rules can be asked about the result before it is sent.
   */
  all(): Task[] {
    return [...this.byID.values()];
  }

  /**
   * withUpdated returns a tree holding the same tasks with t in place of the
   * one of the same id, which is the state a pending update would leave
   * behind.
   */
  withUpdated(t: Task): Tree {
    const all = this.all();
    let replaced = false;
    for (let i = 0; i < all.length; i++) {
      if ((all[i] as Task).id === t.id) {
        all[i] = t;
        replaced = true;
        break;
      }
    }
    if (!replaced) {
      all.push(t);
    }
    return new Tree(all);
  }

  /**
   * sortKey returns the tree-order key of a task: one component per level
   * from the root down, each one the sibling's position followed by its id.
   * Comparing two keys component by component puts a container before its
   * children and siblings in the order the user arranged them.
   *
   * The position is rendered zero-padded and offset past zero so that a
   * negative position — which a user can set, and which means "before
   * everything" — still compares as text in numeric order.
   */
  sortKey(t: Task): string[] {
    const path = this.path(t.id);
    const out: string[] = [];
    for (const step of path) {
      const node = this.byID.get(step);
      if (node === undefined) {
        out.push(step);
        continue;
      }
      const offset = (BigInt(node.position) + positionOffset)
        .toString()
        .padStart(20, '0');
      out.push(`${offset}|${node.id}`);
    }
    return out;
  }

  /**
   * childrenRef is `children` without the copy, for the rules in this module
   * group that only read. Go's `completesWithLastChild` was a method on Tree
   * and reached `tr.children` directly; TypeScript cannot add a method to a
   * class from another file, so completion.ts calls this instead. The result
   * must not be mutated.
   */
  childrenRef(parentID: string): readonly Task[] {
    return this.childrenOf.get(parentID) ?? [];
  }
}

/**
 * deferredAt reports whether t is held back by its own defer date. The
 * comparison is strict: a defer date exactly now has arrived.
 */
function deferredAt(t: Task, now: Date): boolean {
  return t.deferAt !== undefined && t.deferAt.getTime() > now.getTime();
}

/**
 * sortSiblings is tree order: manual position first, then id, which is
 * creation order. Every listing and the sequential rule agree on it, so "the
 * next action" means the same thing in a listing as in a block reason.
 */
function sortSiblings(ts: Task[]): void {
  ts.sort((a, b) => {
    if (a.position !== b.position) {
      return a.position - b.position;
    }
    return compareStrings(a.id, b.id);
  });
}

/**
 * positionOffset keeps the padded position non-negative. It is half of what
 * an int64 can hold, so no position a user could set reaches past it.
 *
 * It is a BigInt because a JavaScript number is a double: 2^62 is exactly
 * representable, but 2^62 + 1 is not, so adding a position to it in number
 * arithmetic throws the position away and every sibling sorts as if its
 * position were the same.
 */
const positionOffset = 1n << 62n;

/**
 * checkParent enforces the containment table of §3.1 for a child of kind
 * child placed under parent, which is undefined for the top level. Every
 * provider calls it rather than writing the table out again. It returns the
 * error to report rather than throwing, because it answers a question; Go
 * returned an `error` here for the same reason.
 */
export function checkParent(
  child: Kind,
  parent: Task | undefined,
): Error | undefined {
  if (parent === undefined) {
    // A folder, a project or a loose task may all sit at the top level; for a
    // task that is the inbox.
    return undefined;
  }
  if (!kindCanContain(parent.kind, child)) {
    return parentError(child, parent);
  }
  return undefined;
}

/**
 * parentError explains a refused placement in the terms the user typed it in,
 * and wraps ErrBadParent so the command layer can still map it to exit 2.
 */
export function parentError(child: Kind, parent: Task): Error {
  return new Error(
    `a ${child} cannot go inside a ${parent.kind} (${parent.id})`,
    { cause: ErrBadParent },
  );
}

/**
 * cycleError explains a refused move. The two ids are the item and the parent
 * it was being moved under, which is the whole of what went wrong.
 */
export function cycleError(id: string, parentID: string): Error {
  if (id === parentID) {
    return new Error(`${id} cannot be its own parent`, { cause: ErrCycle });
  }
  return new Error(
    `${parentID} is inside ${id}, so it cannot also contain it`,
    { cause: ErrCycle },
  );
}
