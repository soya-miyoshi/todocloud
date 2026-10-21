// The listing pipeline: what the store can filter, what has to be filtered
// here, and in which order.
//
// Port notes:
//
//   - Go's `Selection` was a struct passed by value, so `Run` could set
//     `f.Limit` on its own copy of the Filter. A class is a reference here, so
//     the copy is explicit: `new Filter(s.filter)` is what Go's assignment
//     did, and it keeps `run` from writing a limit back into the caller's
//     Selection.
//   - Go reused the backing array with `tasks[:0]`; a fresh array is built
//     here instead. `st.list` already returns an array nobody else holds, so
//     the only thing the reuse bought was an allocation.

import { type Status, type Task, StatusActive, StatusOnHold } from '../task.ts';
import {
  type Store,
  apply as applyCondition,
  compareStrings,
  Condition,
} from '../store/store.ts';
import { Filter } from '../store/filter.ts';

/**
 * openStatuses are the statuses "the list" means: the work that is still in
 * front of the user. Done and dropped items are what an explicit status
 * filter is for. The front end decides this, not the store.
 */
export function openStatuses(): Status[] {
  return [StatusActive, StatusOnHold];
}

/** The fields a Selection may be built from; every one of them is optional. */
export interface SelectionInit {
  filter?: Filter | undefined;
  cond?: Condition | undefined;
  untagged?: boolean | undefined;
  maxMinutes?: number | undefined;
  byTitle?: boolean | undefined;
  limit?: number | undefined;
}

/**
 * Selection is a parsed listing request: what the store can filter, what has
 * to be filtered here, and how much of the result to keep.
 */
export class Selection {
  filter: Filter = new Filter();
  cond: Condition = new Condition();
  /**
   * untagged and maxMinutes are the two filters neither Filter nor Condition
   * covers; they are applied here, after the store's own pass, like every
   * other condition on an open field.
   */
  untagged = false;
  maxMinutes = 0;
  /**
   * byTitle sorts the result by title. It is not an Order because no provider
   * can be asked for a collation the others would match.
   */
  byTitle = false;
  limit = 0;

  constructor(init?: SelectionInit) {
    if (init === undefined) {
      return;
    }
    if (init.filter !== undefined) {
      this.filter = init.filter;
    }
    if (init.cond !== undefined) {
      this.cond = init.cond;
    }
    if (init.untagged !== undefined) {
      this.untagged = init.untagged;
    }
    if (init.maxMinutes !== undefined) {
      this.maxMinutes = init.maxMinutes;
    }
    if (init.byTitle !== undefined) {
      this.byTitle = init.byTitle;
    }
    if (init.limit !== undefined) {
      this.limit = init.limit;
    }
  }
}

/**
 * run executes a selection: the store filters what it can, this module
 * filters the rest, and the limit is applied wherever the filtering ends so
 * that it always counts items the caller actually asked to see.
 */
export async function run(st: Store, s: Selection): Promise<Task[]> {
  const f = new Filter(s.filter);
  const clientSide =
    !s.cond.empty() || s.untagged || s.maxMinutes > 0 || s.byTitle;
  if (!clientSide) {
    f.limit = s.limit;
  }

  let tasks = await st.list(f);
  if (s.untagged || s.maxMinutes > 0) {
    const kept: Task[] = [];
    for (const t of tasks) {
      if (s.untagged && t.tags.length > 0) {
        continue;
      }
      if (
        s.maxMinutes > 0 &&
        (t.estimatedMinutes <= 0 || t.estimatedMinutes >= s.maxMinutes)
      ) {
        continue;
      }
      kept.push(t);
    }
    tasks = kept;
  }
  if (s.byTitle) {
    // Array.prototype.sort is stable, which is what Go's sort.SliceStable
    // was for; the id breaks the tie before stability ever has to.
    tasks.sort((x, y) => {
      const a = x.title.toLowerCase();
      const b = y.title.toLowerCase();
      if (a !== b) {
        return compareStrings(a, b);
      }
      return compareStrings(x.id, y.id);
    });
  }
  if (clientSide) {
    tasks = applyCondition(tasks, s.cond, s.limit);
  }
  return tasks;
}
