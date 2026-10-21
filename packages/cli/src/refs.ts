// Resolving a reference typed on the command line.
//
// Go attached all of this to the `*app` receiver; see the note in app.ts for
// why the port passes the app as the first parameter instead.

import * as id from '@todocloud/core/id';
import { ErrAmbiguous, ErrNotFound, isNotFound, type Store } from '@todocloud/core/store';
import { Filter } from '@todocloud/core/store/filter';
import type { Kind, Task } from '@todocloud/core/task';

import { type App, usagef } from './app.ts';
import * as shortref from './shortref.ts';

/**
 * shortRefDigits is the longest reference still read as a number from the last
 * listing. Six digits is far more rows than anyone lists, and it leaves every
 * longer all-digit string to be treated as an id prefix.
 */
export const shortRefDigits = 6;

/**
 * resolveRef turns a reference typed on the command line into a task.
 *
 * The order is fixed: a short number from the last `tdo ls` first, because
 * that is what the user just read off the screen; then an id prefix, so that
 * `tdo done 01J3` works like a short commit hash; and otherwise a usage
 * error, so a typo is reported as a bad reference rather than as a missing
 * task.
 */
export async function resolveRef(a: App, st: Store, ref: string): Promise<Task> {
  const trimmed = ref.trim();
  if (trimmed === '') {
    throw usagef('empty task reference');
  }

  const n = shortNumber(trimmed);
  if (n !== undefined) {
    const key = st.describe();
    const taskID = shortref.Lookup(key, n);
    if (taskID === undefined) {
      throw notFoundf(`no task numbered ${n} in the last listing; run \`tdo ls\` first`);
    }
    a.out.debugf(`reference ${JSON.stringify(trimmed)} resolved from the last listing`);
    return st.get(taskID);
  }

  if (id.ValidPrefix(trimmed)) {
    return st.findByPrefix(id.Normalize(trimmed));
  }

  throw usagef(id.ErrBadPrefix(ref).message);
}

/**
 * shortNumber returns the short number a reference names, or undefined when it
 * is not one. Go returned `(int, bool)`.
 */
export function shortNumber(ref: string): number | undefined {
  if (ref === '' || ref.length > shortRefDigits) {
    return undefined;
  }
  for (const r of ref) {
    if (r < '0' || r > '9') {
      return undefined;
    }
  }
  // Every character is a digit and there are at most six of them, so this
  // cannot overflow and cannot be anything but an integer.
  return Number.parseInt(ref, 10);
}

/**
 * resolveRefs resolves every reference before the caller changes anything, so
 * a command over several tasks either applies to all of them or to none.
 */
export async function resolveRefs(
  a: App,
  st: Store,
  refs: readonly string[],
): Promise<Task[]> {
  if (refs.length === 0) {
    throw usagef('expected at least one task reference');
  }
  const seen = new Set<string>();
  const tasks: Task[] = [];
  for (const ref of refs) {
    const t = await resolveRef(a, st, ref);
    if (seen.has(t.id)) {
      // The same task named twice (as a number and as a prefix, say) is not
      // an error; applying the change once is what was meant.
      continue;
    }
    seen.add(t.id);
    tasks.push(t);
  }
  return tasks;
}

/**
 * saveListing caches the ids of a listing so the printed numbers resolve at
 * the next command. A cache that cannot be written is never fatal: the user
 * can still use an id prefix, so the failure is a warning under --debug.
 *
 * Machine output does not update the cache. The numbers are a convenience for
 * whoever just read the table, and docs/agents.md tells a machine caller to
 * use the id; letting a backgrounded `tdo ls --json` renumber the list under a
 * human — or under another agent — would turn a shared file into a race with
 * consequences, since `tdo done 2` would then mean a different task.
 */
export function saveListing(a: App, st: Store, tasks: readonly Task[]): void {
  if (a.out.json) {
    a.out.debugf('not caching the listing: --json callers reference tasks by id');
    return;
  }
  // An empty listing installs no numbers, so overwriting the cache with it is
  // pure loss: `tdo ls` followed by a `tdo review` that finds nothing would
  // leave `tdo done 1` reporting that there is no task 1. A command that
  // found nothing has not told the user to renumber anything.
  if (tasks.length === 0) {
    a.out.debugf('not caching an empty listing: it would discard the numbers already cached');
    return;
  }
  try {
    shortref.Save(
      st.describe(),
      tasks.map((t) => t.id),
    );
  } catch (err) {
    a.out.debugf(`could not cache the listing: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * NotFoundError carries a message of its own while still unwrapping to
 * ErrNotFound, so the user reads one sentence instead of a wrapped chain, and
 * classify still returns the not-found code.
 */
export class NotFoundError extends Error {
  override readonly name = 'NotFoundError';

  constructor(message: string) {
    super(message, { cause: ErrNotFound });
  }
}

/** notFoundf builds a not-found error with its own wording. */
export function notFoundf(message: string): Error {
  return new NotFoundError(message);
}

/**
 * resolveContainer resolves a reference that must name a folder or a project:
 * the `--project` and `--folder` flags, `tdo inbox process`, and the two
 * commands that act on a container by name.
 *
 * A container is typed far more often than an action — every `tdo add
 * --project` names one — so a title is accepted as well as a number or an id
 * prefix. The order is the same as everywhere else, with the title tried last
 * so that a number never changes meaning.
 */
export async function resolveContainer(
  a: App,
  st: Store,
  ref: string,
  ...kinds: Kind[]
): Promise<Task> {
  const trimmed = ref.trim();
  if (trimmed === '') {
    throw usagef(`empty ${kindList(kinds)} reference`);
  }

  const numbered = shortNumber(trimmed) !== undefined;
  if (numbered || id.ValidPrefix(trimmed)) {
    let t: Task | undefined;
    try {
      t = await resolveRef(a, st, trimmed);
    } catch (err) {
      // A number comes from a listing the user just read, so a miss is a
      // miss; only an id prefix falls through to a title, since most titles
      // are valid base32 by accident.
      if (numbered || !isNotFound(err)) {
        throw err;
      }
    }
    if (t !== undefined) {
      if (!containsKind(kinds, t.kind)) {
        throw usagef(`${trimmed} is a ${t.kind}, not a ${kindList(kinds)}`);
      }
      return t;
    }
  }

  const matches = await st.list(new Filter({ kinds }));
  let found: Task | undefined;
  for (const t of matches) {
    if (t.title.trim().toLowerCase() !== trimmed.toLowerCase()) {
      continue;
    }
    if (found !== undefined) {
      throw new Error(
        `more than one ${kindList(kinds)} is called ${JSON.stringify(trimmed)}; use its id`,
        { cause: ErrAmbiguous },
      );
    }
    found = t;
  }
  if (found === undefined) {
    throw notFoundf(
      `no ${kindList(kinds)} called ${JSON.stringify(trimmed)}; \`tdo project ls\` and \`tdo folder ls\` list them`,
    );
  }
  return found;
}

/** containsKind reports whether k is one of kinds. */
export function containsKind(kinds: readonly Kind[], k: Kind): boolean {
  return kinds.includes(k);
}

/** kindList names the kinds a reference may have, for an error message. */
export function kindList(kinds: readonly Kind[]): string {
  return kinds.join(' or ');
}
