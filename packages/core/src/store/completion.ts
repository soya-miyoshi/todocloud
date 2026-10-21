// This file holds the "complete with last action" rule of PLAN.md §3.2's
// completed_by_children field, OmniFocus's rule of the same name: when the
// last child of such a container is finished, the container is finished too.
//
// It lives beside availability.ts and for the same reason: it is a rule about
// the tree, not about one provider's SQL, so it is written once as a pure
// function over a Tree and every provider calls it. A provider that computed
// it itself could drift, and the conformance suite holds both of them to this
// definition.
//
// The decisions the rule makes, and why:
//
//   - What counts as "last". A child is still open when it is not deleted and
//     its status is not done or dropped. Dropped and tombstoned children are
//     skipped, exactly as §3.3's sequential rule skips them when it picks the
//     next sibling — deciding against an action finishes it as surely as doing
//     it does, and a tombstone must not stall a container forever any more
//     than it may stall a sequence. A child that is itself a container is an
//     ordinary child: it is open until its own status closes, which is what
//     makes the cascade below meaningful rather than circular.
//
//   - A container with no live children at all is never auto-completed.
//     Completing nothing is not completing something: an empty project with
//     the flag set would otherwise complete the moment it was created, and
//     emptying a container by tombstoning its children would read as having
//     done the work. The rule needs at least one child that was finished.
//
//   - A folder is never auto-completed. §3.1 says a folder is organisation and
//     is never completed, and Task.validate refuses a done folder outright.
//
//   - A container that already carries a repeat is not auto-completed, and the
//     cascade stops there. §3.4 is a hard rule: a new instance is created only
//     as the direct result of an explicit `tdo done`. Completing a repeating
//     container here would either silently kill its series — the successor
//     that the explicit path would have created never appears — or make the
//     store manufacture a row while someone was only finishing a child.
//     Neither is acceptable, so the container is left for the user to finish
//     with `tdo done`, which does roll the series over and says so.
//
//   - A container that is already done or dropped is left alone, and so is a
//     tombstoned one. A container that is on hold is completed: the work it
//     held is finished, and leaving it on hold would keep a container nobody
//     can act on in the tree forever.
//
//   - The rule only ever closes things. Reopening a child with `tdo undone`
//     does not reopen the container; see triggersAutoCompletion.
//
// Port note: Go's `completesWithLastChild` was a method on Tree declared in
// this file. TypeScript cannot add a method to a class from another file, so
// it is a module-private function here that reads the tree through
// `Tree.childrenRef`.

import {
  type Task,
  KindFolder,
  StatusDone,
  statusClosed,
} from '../task.ts';
import { Tree } from './availability.ts';
import { Filter } from './filter.ts';
import type { Store } from './store.ts';

/**
 * triggersAutoCompletion reports whether a write of t can set the rule off.
 * Only a write that closes or tombstones an item can make its parent's last
 * child the last one, so a provider can skip reading the tree for every other
 * write.
 *
 * Reopening is deliberately not a trigger, and this is the one asymmetry in
 * the rule. Nothing records whether a container was completed by this rule or
 * by the user, so an automatic reopen would have to guess, and guessing wrong
 * resurrects a project the user finished on purpose. Closing is monotone and
 * terminates; reopening would have to walk up undoing decisions it cannot
 * distinguish from the user's. `tdo undone <container>` is one command, and it
 * is the user saying which of the two they meant.
 */
export function triggersAutoCompletion(
  t: Task | null | undefined,
): boolean {
  return (
    t !== null &&
    t !== undefined &&
    (t.deleted() || statusClosed(t.status))
  );
}

/**
 * autoComplete returns the containers above changedID that the rule
 * completes, nearest ancestor first, as clones with their status and
 * timestamps already set. The tree must be the state after the write that
 * closed changedID.
 *
 * The walk is upward and cascading: a container that completes may itself be
 * the last open child of its own parent. It terminates because Tree.ancestors
 * is finite and refuses to revisit an id, so a parent edge cycle introduced
 * outside this module stops the walk instead of looping it.
 *
 * Nothing here creates a row. The result is a set of existing containers to
 * update, which is what keeps §3.4's guarantee — that only an explicit
 * `tdo done` ever generates an instance — true of this rule as well.
 */
export function autoComplete(
  tr: Tree,
  changedID: string,
  now: Date,
): Task[] {
  const at = now;
  const out: Task[] = [];
  // closed carries the decision down the walk: a container this pass has
  // just completed counts as closed when its own parent is considered.
  const closed = new Set<string>();
  for (const ancestor of tr.ancestors(changedID)) {
    if (!completesWithLastChild(tr, ancestor, closed)) {
      // The first ancestor that does not complete ends the cascade:
      // everything above it still has an open child, namely this one.
      break;
    }
    const done = ancestor.clone();
    done.setStatus(StatusDone, at);
    out.push(done);
    closed.add(ancestor.id);
  }
  return out;
}

/**
 * completesWithLastChild answers the rule for one container. closed names the
 * ids this pass has already decided to complete.
 */
function completesWithLastChild(
  tr: Tree,
  container: Task,
  closed: ReadonlySet<string>,
): boolean {
  if (!container.completedByChildren) {
    return false;
  }
  if (container.kind === KindFolder) {
    return false;
  }
  if (container.deleted() || statusClosed(container.status)) {
    return false;
  }
  if (container.repeat !== undefined) {
    return false;
  }
  let live = 0;
  for (const child of tr.childrenRef(container.id)) {
    if (child.deleted()) {
      continue;
    }
    live++;
    if (!statusClosed(child.status) && !closed.has(child.id)) {
      return false;
    }
  }
  return live > 0;
}

/**
 * pendingAutoCompletions reports the containers that writing t would complete
 * under the rule of PLAN.md §3.3a, without writing anything.
 *
 * It exists so the command layer can tell the user what a write did, rather
 * than only that it succeeded: a project quietly disappearing from `tdo ls`
 * because its last action closed is exactly the kind of thing a tool must say
 * out loud. It answers from the same Tree and the same autoComplete the
 * providers use, so the prediction and the write agree by construction rather
 * than by two pieces of code being kept in step.
 *
 * The answer is a snapshot like any other read, so a concurrent writer can
 * still make it stale between the prediction and the write. That is the same
 * window every read-then-write in this tool has, and the consequence here is
 * a line of output, not a wrong row.
 */
export async function pendingAutoCompletions(
  s: Store,
  t: Task,
  now: Date,
): Promise<Task[]> {
  if (!triggersAutoCompletion(t)) {
    return [];
  }
  // The Tree is built here rather than taken as an argument so that the
  // prediction is made against what the store holds now, which is the state
  // the write will be applied to.
  const all = await s.list(new Filter({ includeDeleted: true }));
  return autoComplete(new Tree(all).withUpdated(t), t.id, now);
}
