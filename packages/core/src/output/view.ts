// The one JSON shape of a task.
//
// Port notes: Go's `MarshalJSON` is `toJSON` here, which `JSON.stringify`
// calls for the same reason. It flattens the task the way `task.Task`
// marshals it and adds the derived keys, re-sorting the whole object
// afterwards — Go marshalled through a `map[string]json.RawMessage`, and
// encoding/json sorts the keys of a map, so the sort is part of the
// documented bytes and not a tidiness.

import { nextReviewAt } from '../recur.ts';
import { Availability } from '../store/store.ts';
import type { JSONObject, JSONValue, Task } from '../task.ts';
import { KeyAvailable, KeyBlockedBy, KeyNextReview, KeyWaitsOn, formatTime } from '../task.ts';

/**
 * NewTaskView pairs one task with the availability answer for it. asked is
 * false when the caller did not compute availability, which emits null for
 * `available` and `blocked_by` rather than claiming the item is blocked for
 * no reason.
 */
export function NewTaskView(t: Task, a: Availability, asked: boolean): TaskView {
  return new TaskView(t, a, asked);
}

/**
 * TaskView is the JSON shape of one task everywhere tdo emits one: the stored
 * task, flattened as task.Task marshals it, plus the three derived keys a
 * caller must not have to recompute — `available`, `blocked_by` and
 * `next_review_at` (§3.3, §3.5).
 *
 * Every command that emits a task emits this, so an agent parses one shape
 * rather than one per command. `blocked_by` is null when the item is
 * available, and an object naming the rule and the item responsible when it
 * is not.
 */
export class TaskView {
  readonly task: Task;
  readonly availability: Availability;
  /**
   * asked records that availability was computed for this task. A command
   * that cannot know it — there is none today — would emit null rather
   * than claim the item is blocked for no reason.
   */
  readonly asked: boolean;

  constructor(task: Task, availability: Availability, asked: boolean) {
    this.task = task;
    this.availability = availability;
    this.asked = asked;
  }

  toJSON(): JSONObject {
    const out: JSONObject = { ...this.task.toJSON() };

    if (this.asked) {
      out[KeyAvailable] = this.availability.available;
      let blocker: JSONValue = null;
      if (!this.availability.available) {
        blocker = blockedBy(this.availability);
      }
      out[KeyBlockedBy] = blocker;
      // The events it waits for, present only when there are some: an item
      // that waits for nothing carries nothing. Both occurred and pending
      // ones are listed, so a caller sees the whole dependency, and
      // `blocked_by` says which one is in the way.
      if (this.availability.waitsOn.length > 0) {
        out[KeyWaitsOn] = [...this.availability.waitsOn];
      }
    } else {
      out[KeyAvailable] = null;
      out[KeyBlockedBy] = null;
    }

    // next_review_at is derived from last_reviewed_at and the interval, so it
    // cannot drift out of sync with either half (§3.5). It is null on
    // anything with no review interval, which is every task.
    const next = nextReviewAt(this.task, this.task.updatedAt);
    out[KeyNextReview] = next === undefined ? null : formatTime(next);

    // Go marshalled a map, and encoding/json sorts a map's keys; the sorted
    // order is the byte-level contract in docs/agents.md. task.toJSON sorts
    // the stored keys the same way, and the three keys added above have to
    // land in that order rather than at the end.
    const sorted: JSONObject = {};
    for (const k of Object.keys(out).sort(compareStrings)) {
      sorted[k] = out[k] ?? null;
    }
    return sorted;
  }
}

/**
 * blockedBy is the documented object under the `blocked_by` key. `tag` is
 * present only for the two rules that name one — `tag_status` and
 * `ancestor_tag_status` — so a caller switching on `rule` never has to ask
 * whether the key might be there for another.
 *
 * The key order is the Go struct's, which encoding/json leaves alone: rule,
 * task_id, then the optional tag. `Availability.toJSON` is deliberately not
 * reused — it writes a different shape, with its own `available` key.
 */
function blockedBy(a: Availability): JSONObject {
  const out: JSONObject = { rule: a.rule, task_id: a.blockedBy };
  if (a.tag !== '') {
    // Go's `omitempty`: the key is absent, not null, for every other rule.
    out['tag'] = a.tag;
  }
  return out;
}

/** Views pairs tasks with the availability answer for each of them. */
export function Views(tasks: Task[], av: Map<string, Availability>): TaskView[] {
  return tasks.map((t) => {
    const a = av.get(t.id);
    // Go read a map and took the second return value as `asked`; a missing
    // key leaves the zero-value answer, which is never read when asked is
    // false.
    return new TaskView(t, a ?? new Availability(), a !== undefined);
  });
}

// Go's sort.Strings orders by byte value; see the same comment in task.ts.
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
