// Module taskops is the logic layer every front end shares.
//
// It holds the writes that are more than one store call — completing a
// repeating item, moving an item, tombstoning a subtree — and the listing
// pipeline that applies the filters no provider can push down. The command
// layer parses flags and renders output; the local viewer and the PWA render
// their own; all of them reach the store only through this module, so they
// cannot drift into disagreeing about what "done" means.
//
// Nothing here touches the argument parser, the process streams or the exit
// codes. An operation throws the store's own sentinel errors
// (store.ErrBadParent, store.ErrNotFound, …) and the caller maps them onto
// whatever its front end reports: an exit code for the CLI, a status code for
// the server.
//
// Port notes, where TypeScript cannot hold the Go shape exactly:
//
//   - Every `Store` method except `describe` returns a promise, so every
//     operation here is `async` and every store call is awaited. The order
//     the awaits happen in is behaviour, not style: see `complete`, where the
//     successor is added before the instance is closed.
//   - Go's `context.Context` first parameter is gone rather than replaced by
//     an `AbortSignal`; the CLI never cancelled a store call, and a provider
//     that wants cancellation takes one in its own constructor.
//   - Go returned `(*Result, error)`; a failure throws here, so an operation
//     returns a `Result`. The sentinels still arrive as a thrown error's
//     `cause`, which is what the `isX` predicates read.
//   - `Placement` was `type Placement int` with an iota block. It is a
//     numeric type here with the same two values, because nothing persists or
//     prints it — it is an argument to one function.

import {
  type Status,
  StatusDone,
  type Task,
} from '../task.ts';
import { complete as recurComplete } from '../recur.ts';
import { type Availability, type Store } from '../store/store.ts';
import { pendingAutoCompletions } from '../store/completion.ts';
import { type Edit, invalidf } from './edit.ts';

/**
 * Result is what a write changed. `tasks` holds the items the caller named,
 * in the order they were given; the other two fields are the rows an
 * operation touched that nobody typed, and they are never silent — the CLI
 * prints them on stderr and the server returns them in its payload.
 */
export interface Result {
  /** tasks are the items the operation acted on, as they now stand. */
  tasks: Task[];
  /** successors are the next instances created for repeating items (§3.4). */
  successors: Task[];
  /**
   * autoCompleted are the containers that closed because their last child
   * did (§3.3a).
   */
  autoCompleted: Task[];
}

/** newResult is an empty Result, which Go got from the zero value. */
function newResult(): Result {
  return { tasks: [], successors: [], autoCompleted: [] };
}

/**
 * IDGen supplies the id of a row the operation creates. It is a parameter
 * rather than a call to `newID` so that a test can pin the ids a repeat
 * generates.
 */
export type IDGen = () => string;

/**
 * complete completes each task, creating the successor of a repeating one
 * unless noRepeat says otherwise.
 */
export async function complete(
  st: Store,
  tasks: readonly Task[],
  now: Date,
  noRepeat: boolean,
  newID: IDGen,
): Promise<Result> {
  const res = newResult();
  const auto = new Completions();
  for (const found of tasks) {
    const t = found.clone();
    let next: Task | undefined;
    if (noRepeat) {
      // The one way to end a repeating item without a successor, short of
      // `tdo repeat --stop`.
      t.setStatus(StatusDone, now);
    } else {
      // This is the only call that creates a row nobody typed, and it is
      // reached only from here (§3.4).
      next = recurComplete(t, now, newID());
    }
    // The successor goes in BEFORE the instance is completed, and the order
    // is load-bearing. Completing the instance may be the last action of a
    // complete-with-last container (PLAN.md §3.3a), and the store closes
    // that container as part of the same update. Adding the successor
    // afterwards would file it under a container that is already done;
    // adding it first makes it the live sibling that correctly prevents the
    // auto-completion. It also fails more safely: if add fails, the instance
    // is still open.
    if (next !== undefined) {
      await st.add(next);
      res.successors.push(next);
    }
    await auto.collect(st, t, now);
    await st.update(t);
    res.tasks.push(t);
  }
  res.autoCompleted = auto.tasks;
  return res;
}

/**
 * setStatus moves each task to status. It is the body of `tdo undone`,
 * `drop`, `hold` and `unhold`, which differ by one value only.
 */
export async function setStatus(
  st: Store,
  tasks: readonly Task[],
  status: Status,
  now: Date,
): Promise<Result> {
  return update(st, tasks, now, true, (t) => {
    t.setStatus(status, now);
  });
}

/** setFlagged flags or unflags each task. */
export async function setFlagged(
  st: Store,
  tasks: readonly Task[],
  flagged: boolean,
  now: Date,
): Promise<Result> {
  return update(st, tasks, now, false, (t) => {
    t.flagged = flagged;
  });
}

/** DateField names which of the two dates a write sets. */
export type DateField = 'defer' | 'due' | (string & {});

/** DeferDate is the date before which an item is not available. */
export const DeferDate: DateField = 'defer';
/** DueDate is the date an item is due. */
export const DueDate: DateField = 'due';

/**
 * setDate writes one of the two dates on each task; an undefined `at` clears
 * it. Anything that is not DeferDate is the due date, as it was in Go.
 */
export async function setDate(
  st: Store,
  tasks: readonly Task[],
  field: DateField,
  at: Date | undefined,
  now: Date,
): Promise<Result> {
  return update(st, tasks, now, false, (t) => {
    if (field === DeferDate) {
      t.deferAt = at;
    } else {
      t.dueAt = at;
    }
  });
}

/**
 * apply writes an edit to each task. The edit is validated against a copy,
 * so a rejected edit changes nothing.
 */
export async function apply(
  st: Store,
  tasks: readonly Task[],
  e: Edit,
  now: Date,
): Promise<Result> {
  return update(st, tasks, now, false, (t) => {
    e.apply(t);
  });
}

/**
 * update clones each task, applies fn, predicts the containers the write
 * closes when the change can close one, and stores it. Editing a copy is
 * what keeps a validation failure from leaving a half-applied change behind:
 * fn throws, and the task the store holds was never touched.
 */
async function update(
  st: Store,
  tasks: readonly Task[],
  now: Date,
  mayComplete: boolean,
  fn: (t: Task) => void,
): Promise<Result> {
  const res = newResult();
  const auto = new Completions();
  for (const found of tasks) {
    const t = found.clone();
    fn(t);
    t.updatedAt = now;
    const err = t.validate();
    if (err !== undefined) {
      throw invalidf(err.message);
    }
    if (mayComplete) {
      await auto.collect(st, t, now);
    }
    await st.update(t);
    res.tasks.push(t);
  }
  res.autoCompleted = auto.tasks;
  return res;
}

/**
 * create stores a new item. It is one store call, and it is here so that a
 * caller never has to know that the tree rules live in `add`.
 */
export async function create(st: Store, t: Task): Promise<void> {
  return st.add(t);
}

/**
 * moveTo reparents each task, keeping its position. An empty parentID means
 * the top level, which for a task is the inbox.
 */
export async function moveTo(
  st: Store,
  tasks: readonly Task[],
  parentID: string,
  now: Date,
): Promise<Result> {
  const res = newResult();
  for (const t of tasks) {
    await st.move(t.id, parentID, t.position, now);
    res.tasks.push(await st.get(t.id));
  }
  return res;
}

/**
 * tombstone is the ordinary removal: the item stays in the store with a
 * deleted_at stamp, so that a second device can learn about the deletion
 * instead of silently resurrecting it.
 *
 * Removing a container takes its subtree with it. Leaving the children behind
 * would make them orphans, which §3.3 refuses to call available — so they
 * would vanish from every listing while still being there.
 */
export async function tombstone(
  st: Store,
  tasks: readonly Task[],
  now: Date,
): Promise<Result> {
  const res = newResult();
  const seen = new Set<string>();
  const auto = new Completions();
  for (const found of tasks) {
    const subtree = await st.subtree(found.id);
    for (const node of subtree) {
      if (seen.has(node.id)) {
        continue;
      }
      seen.add(node.id);
      const t = node.clone();
      if (t.deletedAt === undefined) {
        t.deletedAt = new Date(now.getTime());
        t.updatedAt = now;
        // Only the item the user named can complete something that survives
        // this command: everything else in the subtree is being tombstoned
        // alongside it, and its own ancestors are inside the subtree.
        // Predicting for every node would also read the whole store once per
        // node.
        if (node.id === found.id) {
          await auto.collect(st, t, now);
        }
        await st.update(t);
      }
      res.tasks.push(t);
    }
  }
  res.autoCompleted = auto.tasks;
  return res;
}

/**
 * availabilityOf asks the store for §3.3 over these tasks. It is the one
 * place a front end learns why something is blocked: the rules are computed
 * in the store so that every provider and every command agree.
 */
export async function availabilityOf(
  st: Store,
  tasks: readonly Task[],
  now: Date,
): Promise<Map<string, Availability>> {
  if (tasks.length === 0) {
    return new Map<string, Availability>();
  }
  return st.availability(now, ...tasks.map((t) => t.id));
}

/**
 * Completions collects the containers that writing a task will complete under
 * PLAN.md §3.3a. It is called immediately before the write, because the rule
 * reads the tree as it will be afterwards, and it uses the same shared
 * function the providers do, so what is reported and what is written cannot
 * drift apart.
 *
 * A container appears once however many of its children closed in the same
 * operation: `tdo done a b` where a and b are the last two actions of one
 * project completes that project once.
 *
 * Go's `completions` was unexported and is a module-private class here for
 * the same reason: it is bookkeeping for the operations above.
 */
class Completions {
  private readonly seen = new Set<string>();
  readonly tasks: Task[] = [];

  async collect(st: Store, t: Task, now: Date): Promise<void> {
    const containers = await pendingAutoCompletions(st, t, now);
    for (const container of containers) {
      if (this.seen.has(container.id)) {
        continue;
      }
      this.seen.add(container.id);
      this.tasks.push(container);
    }
  }
}

/**
 * Placement says where `reorder` puts the items it moves, relative to an
 * anchor among its new siblings.
 */
export type Placement = number;

/** Before puts the items immediately ahead of the anchor. */
export const Before: Placement = 0;
/** After puts them immediately behind it. */
export const After: Placement = 1;

/**
 * reorder moves tasks so they sit immediately before or after anchor, among
 * anchor's siblings.
 *
 * Order is not decoration in a sequential project: the position of a child
 * *is* the order its actions become available (§3.3), so "do the scan last"
 * was until now expressed by deleting the action and adding it again. The
 * positions of the whole sibling group are rewritten in one pass, because
 * they are a manual order with no gaps guaranteed — two siblings may share a
 * position, and ties break by id, so inserting "between" them is only
 * meaningful once they have been renumbered.
 *
 * Moving an item next to an anchor in another container moves it into that
 * container too: that is what "put it after this one" means when the anchor
 * lives somewhere else, and it keeps `tdo mv --after` from being a second,
 * subtly different kind of move.
 */
export async function reorder(
  st: Store,
  tasks: readonly Task[],
  anchor: Task,
  where: Placement,
  now: Date,
): Promise<Result> {
  if (tasks.length === 0) {
    throw invalidf('expected at least one item to move');
  }
  const moving = new Set<string>();
  for (const t of tasks) {
    if (t.id === anchor.id) {
      throw invalidf(
        `${JSON.stringify(anchor.title)} cannot be placed relative to itself`,
      );
    }
    moving.add(t.id);
  }

  // The anchor's siblings in the order they are in now, which is the order a
  // listing printed and the user is reading.
  const siblings = await st.children(anchor.parentID);
  const order: Task[] = [];
  for (const sibling of siblings) {
    if (moving.has(sibling.id)) {
      // An item already in this group is being moved within it, so it is
      // dropped here and put back at its new place below.
      continue;
    }
    if (sibling.id === anchor.id && where === Before) {
      order.push(...tasks);
    }
    order.push(sibling);
    if (sibling.id === anchor.id && where === After) {
      order.push(...tasks);
    }
  }

  const res = newResult();
  for (const [position, t] of order.entries()) {
    if (
      !moving.has(t.id) &&
      t.position === position &&
      t.parentID === anchor.parentID
    ) {
      // Renumbering is a write per sibling, so the ones already in place are
      // left alone: a reorder in a long project must not touch every row's
      // updated_at.
      continue;
    }
    await st.move(t.id, anchor.parentID, position, now);
  }
  // The items the caller named, in the order they were given, read back even
  // when none of them had to move.
  for (const t of tasks) {
    res.tasks.push(await st.get(t.id));
  }
  return res;
}
