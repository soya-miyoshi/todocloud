// Test-only helpers for this module, shared by its test files the way Go's
// package-level test helpers were shared between the files of one package. It
// is not in the package's exports map and nothing outside `*.test.ts` in this
// directory may import it.
//
// It lives here as a `.ts` rather than inside a `.test.ts` because two test
// files need it and importing one test file from another would run its tests
// twice. It imports no `node:*` module, so `browser-safe.test.ts` is satisfied
// by it the same way it is by the sources.
//
// The store below is an in-memory Store built on `Tree`, which is also what
// the real providers compute §3.1, §3.3 and §3.3a from. It is deliberately
// NOT a second implementation of those rules: it answers them by calling the
// same shared functions, so a test here fails on what this module did and not
// on a disagreement between two fakes. Provider behaviour itself is the
// conformance suite's job (`@todocloud/store-testkit`), not this file's.

import {
  type Status,
  type Task,
  KindTask,
  StatusActive,
  newTask,
} from '../task.ts';
import {
  type Availability,
  type Perspective,
  type Store,
  type Tag,
  ErrExists,
  ErrNotFound,
  sortTasks,
} from '../store/store.ts';
import { Filter } from '../store/filter.ts';
import { Tree, checkParent, cycleError } from '../store/availability.ts';

/** A fixed instant, so that a stamped timestamp is comparable in an assert. */
export const now = new Date('2026-03-01T09:00:00Z');

/** at returns now plus n hours, for a defer or a due date. */
export function at(hours: number): Date {
  return new Date(now.getTime() + hours * 3600 * 1000);
}

/**
 * Literal ids, 26-character Crockford base32 as a ULID is, so that a test can
 * assert on an order that breaks ties by id.
 */
export const idA = '01J3AAAAAAAAAAAAAAAAAAAAAA';
export const idB = '01J3BBBBBBBBBBBBBBBBBBBBBB';
export const idC = '01J3CCCCCCCCCCCCCCCCCCCCCC';
export const idD = '01J3DDDDDDDDDDDDDDDDDDDDDD';
export const idE = '01J3EEEEEEEEEEEEEEEEEEEEEE';

/** An IDGen that hands out the ids it was given, then refuses. */
export function ids(...queue: string[]): () => string {
  const rest = [...queue];
  return () => {
    const next = rest.shift();
    if (next === undefined) {
      throw new Error('the test asked for more ids than it pinned');
    }
    return next;
  };
}

/** A task with the fields a test cares about and sane values for the rest. */
export function task(
  id: string,
  init?: {
    kind?: string;
    title?: string;
    parentID?: string;
    position?: number;
    status?: Status;
  },
): Task {
  const t = newTask(id, init?.kind ?? KindTask, init?.title ?? id, now);
  t.parentID = init?.parentID ?? '';
  t.position = init?.position ?? 0;
  t.status = init?.status ?? StatusActive;
  return t;
}

/** One store call, as the log records it. */
export interface Call {
  op: string;
  id: string;
}

/**
 * MemStore is the fake Store. Every read returns clones, as a real provider
 * does, so a test cannot accidentally mutate the stored row through the task
 * it got back — which is exactly the mistake the `clone()` in this module's
 * operations exists to prevent, and a fake that shared its rows would hide.
 */
export class MemStore implements Store {
  private readonly rows = new Map<string, Task>();

  /** calls records every mutating call in order, for the ordering tests. */
  readonly calls: Call[] = [];

  /**
   * fail makes the next matching call throw. It is how a test reaches the
   * "the write failed, so the task is still open" paths, which are the ones
   * a real provider only produces on a bad day.
   */
  fail: { op: string; id?: string; err: Error } | undefined = undefined;

  constructor(tasks: readonly Task[] = []) {
    for (const t of tasks) {
      this.rows.set(t.id, t.clone());
    }
  }

  /** stored returns the row as the store holds it, for an assertion. */
  stored(id: string): Task | undefined {
    return this.rows.get(id)?.clone();
  }

  /** count is how many rows the store holds, tombstoned ones included. */
  count(): number {
    return this.rows.size;
  }

  private record(op: string, id: string): void {
    this.calls.push({ op, id });
    const f = this.fail;
    if (f !== undefined && f.op === op && (f.id === undefined || f.id === id)) {
      this.fail = undefined;
      throw f.err;
    }
  }

  private tree(): Tree {
    return new Tree([...this.rows.values()].map((t) => t.clone()));
  }

  init(): Promise<void> {
    return Promise.resolve();
  }

  schemaVersion(): Promise<number> {
    return Promise.resolve(1);
  }

  migrate(): Promise<void> {
    return Promise.resolve();
  }

  add(t: Task): Promise<void> {
    this.record('add', t.id);
    if (this.rows.has(t.id)) {
      return Promise.reject(
        new Error(`${t.id}: ${ErrExists.message}`, { cause: ErrExists }),
      );
    }
    const bad = checkParent(
      t.kind,
      t.parentID === '' ? undefined : this.rows.get(t.parentID),
    );
    if (bad !== undefined) {
      return Promise.reject(bad);
    }
    this.rows.set(t.id, t.clone());
    return Promise.resolve();
  }

  get(id: string): Promise<Task> {
    const t = this.rows.get(id);
    if (t === undefined) {
      return Promise.reject(
        new Error(`${id}: ${ErrNotFound.message}`, { cause: ErrNotFound }),
      );
    }
    return Promise.resolve(t.clone());
  }

  findByPrefix(prefix: string): Promise<Task> {
    return this.get(prefix);
  }

  list(f: Filter): Promise<Task[]> {
    const tr = this.tree();
    const out = tr.all().filter((t) => f.matches(t, tr));
    sortTasks(out, f.order, (t) => tr.sortKey(t));
    return Promise.resolve(f.limit > 0 ? out.slice(0, f.limit) : out);
  }

  update(t: Task): Promise<void> {
    this.record('update', t.id);
    if (!this.rows.has(t.id)) {
      return Promise.reject(
        new Error(`${t.id}: ${ErrNotFound.message}`, { cause: ErrNotFound }),
      );
    }
    this.rows.set(t.id, t.clone());
    return Promise.resolve();
  }

  move(id: string, parentID: string, position: number, at: Date): Promise<void> {
    this.record('move', id);
    const t = this.rows.get(id);
    if (t === undefined) {
      return Promise.reject(
        new Error(`${id}: ${ErrNotFound.message}`, { cause: ErrNotFound }),
      );
    }
    if (parentID !== '') {
      const parent = this.rows.get(parentID);
      if (parent === undefined) {
        return Promise.reject(
          new Error(`${parentID}: ${ErrNotFound.message}`, {
            cause: ErrNotFound,
          }),
        );
      }
      const bad = checkParent(t.kind, parent);
      if (bad !== undefined) {
        return Promise.reject(bad);
      }
      if (this.tree().hasDescendant(id, parentID)) {
        return Promise.reject(cycleError(id, parentID));
      }
    }
    const moved = t.clone();
    moved.parentID = parentID;
    moved.position = position;
    moved.updatedAt = at;
    this.rows.set(id, moved);
    return Promise.resolve();
  }

  children(parentID: string): Promise<Task[]> {
    return Promise.resolve(this.tree().children(parentID));
  }

  subtree(id: string): Promise<Task[]> {
    const found = this.tree().subtree(id);
    if (found.length === 0) {
      return Promise.reject(
        new Error(`${id}: ${ErrNotFound.message}`, { cause: ErrNotFound }),
      );
    }
    return Promise.resolve(found);
  }

  availability(at: Date, ...ids: string[]): Promise<Map<string, Availability>> {
    for (const id of ids) {
      this.calls.push({ op: 'availability', id });
    }
    return Promise.resolve(this.tree().availabilityOf(at, ...ids));
  }

  purge(): Promise<void> {
    return Promise.reject(new Error('purge is not used by these tests'));
  }

  purgeSubtree(): Promise<number> {
    return Promise.reject(new Error('purgeSubtree is not used by these tests'));
  }

  tags(): Promise<Tag[]> {
    return Promise.resolve([]);
  }

  setTagStatus(): Promise<void> {
    return Promise.reject(new Error('setTagStatus is not used by these tests'));
  }

  renameTag(): Promise<void> {
    return Promise.reject(new Error('renameTag is not used by these tests'));
  }

  removeTag(): Promise<number> {
    return Promise.reject(new Error('removeTag is not used by these tests'));
  }

  savePerspective(): Promise<void> {
    return Promise.reject(
      new Error('savePerspective is not used by these tests'),
    );
  }

  perspective(): Promise<Perspective> {
    return Promise.reject(new Error('perspective is not used by these tests'));
  }

  perspectives(): Promise<Perspective[]> {
    return Promise.resolve([]);
  }

  deletePerspective(): Promise<void> {
    return Promise.reject(
      new Error('deletePerspective is not used by these tests'),
    );
  }

  describe(): string {
    return 'an in-memory store';
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
