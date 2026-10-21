// The provider conformance suite itself: the fixture, the assertions and the
// list of sub-suites. `index.ts` documents how a provider calls it.
//
// A failure here names the rule that was broken, not just the values that
// differed, because the reader is someone porting a provider who needs to
// know which paragraph of the spec they are arguing with.

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import {
  type Availability,
  Filter,
  type Kind,
  New as newID,
  newTask,
  type Store,
  type Task,
} from '@todocloud/core';

import {
  testCompletedByChildren,
} from './completion.ts';
import {
  testFilters,
  testIDNormalization,
  testOpenFields,
  testPerspectives,
  testRepetition,
  testReview,
  testSentinels,
  testTags,
  testTagStatus,
  testTombstones,
} from './data.ts';
import {
  testAvailability,
  testContainment,
  testCycles,
  testDirectAccessors,
  testFreshStore,
  testInbox,
  testOrdering,
} from './tree.ts';

/**
 * Factory returns a fresh, empty store. It is called once per sub-suite, and
 * the suite closes what it is given.
 *
 * It takes the sub-suite's own TestContext, the way Go's `Factory` took
 * `*testing.T`: a provider that needs a temporary file wants it torn down
 * with the case that asked for it. It may be async, because opening a
 * connection is.
 */
export type Factory = (t: TestContext) => Store | Promise<Store>;

/**
 * Register is `node:test`'s `test` and `TestContext.test`, which share a
 * shape. The suite takes one so that a provider can run it as a set of
 * top-level tests (the default) or nest the whole thing under a test of its
 * own by passing `t.test`. It is the stand-in for Go's `*testing.T`, which
 * carried both the registrar and the assertions; here the assertions reach
 * the case through its own TestContext instead.
 */
export type Register = (
  name: string,
  fn: (t: TestContext) => void | Promise<void>,
) => unknown;

/** A sub-suite: one store, one set of rules. */
type Suite = (t: TestContext, f: Fixture) => Promise<void>;

/**
 * run exercises the whole Store contract.
 *
 * Every sub-suite is registered through `register`, which defaults to
 * `node:test`'s top-level `test`. The returned promise is `node:test`'s own,
 * and a caller does not have to await it: registering is enough.
 */
export function run(newStore: Factory, register: Register = test): void {
  const suites: Array<[string, Suite]> = [
    ['a fresh store is empty and initialized', testFreshStore],
    [
      'the tree accepts only the containments PLAN 3.1 allows',
      testContainment,
    ],
    [
      'the tree refuses a move that would put an item inside itself',
      testCycles,
    ],
    ['a task with no parent is in the inbox', testInbox],
    ['availability follows the truth table of PLAN 3.3', testAvailability],
    ['a listing is in the order the filter asks for', testOrdering],
    [
      'Children, Subtree and Availability answer on their own terms',
      testDirectAccessors,
    ],
    [
      'removal is a tombstone and purging is the only real delete',
      testTombstones,
    ],
    ['tags round trip and filter as a set', testTags],
    [
      'a tag carries a status, and an inactive one holds its tasks back',
      testTagStatus,
    ],
    ['perspectives are saved filters and nothing else', testPerspectives],
    ['a repeating task keeps its repeat and its series', testRepetition],
    [
      'the last child of a completed_by_children container completes it',
      testCompletedByChildren,
    ],
    ['a review interval drives the review listing', testReview],
    [
      'every sentinel is returned where the contract says it is',
      testSentinels,
    ],
    [
      'every id-addressed call accepts an id in any case',
      testIDNormalization,
    ],
    ['user-defined fields survive the round trip unchanged', testOpenFields],
    [
      'filters narrow a listing the way they are documented to',
      testFilters,
    ],
  ];
  for (const [name, suite] of suites) {
    register(name, async (t) => {
      const f = await newFixture(t, newStore);
      await suite(t, f);
    });
  }
}

/** A mutator applied to a task before it is stored. */
export type Mutator = (t: Task) => void;

/** Fixture is one store and the small amount of ceremony every sub-suite needs. */
export class Fixture {
  readonly t: TestContext;
  readonly s: Store;
  /**
   * now is fixed so that a truth table is a truth table and not a race with
   * the clock.
   */
  readonly now: Date;

  constructor(t: TestContext, s: Store, now: Date) {
    this.t = t;
    this.s = s;
    this.now = now;
  }

  /**
   * with returns the same fixture reporting against t. A sub-suite that
   * splits into `t.test` cases needs it: in Go a helper that failed against
   * the parent's `*T` reported "a subtest called FailNow on a parent test"
   * instead of the rule it was checking, and here a diagnostic written
   * against a finished parent is lost just as silently.
   */
  with(t: TestContext): Fixture {
    return new Fixture(t, this.s, this.now);
  }

  /** add stores a new node and returns it as the store accepted it. */
  async add(
    kind: Kind,
    title: string,
    ...mutate: Mutator[]
  ): Promise<Task> {
    const t = newTask(newID(), kind, title, this.now);
    for (const m of mutate) {
      m(t);
    }
    try {
      await this.s.add(t);
    } catch (err) {
      assert.fail(
        `Add(${kind} ${JSON.stringify(title)}) must succeed for a well-formed task, but failed: ${reason(err)}`,
      );
    }
    return t;
  }

  /** mustAdd is add for a task the caller built itself. */
  async mustAdd(t: Task): Promise<Task> {
    try {
      await this.s.add(t);
    } catch (err) {
      assert.fail(
        `Add(${t.id}) must succeed for a well-formed task, but failed: ${reason(err)}`,
      );
    }
    return t;
  }

  async get(taskID: string): Promise<Task> {
    try {
      return await this.s.get(taskID);
    } catch (err) {
      assert.fail(
        `Get(${taskID}) must return a task that was just stored, but failed: ${reason(err)}`,
      );
    }
  }

  async update(t: Task): Promise<void> {
    try {
      await this.s.update(t);
    } catch (err) {
      assert.fail(
        `Update(${t.id}) must succeed for a well-formed task, but failed: ${reason(err)}`,
      );
    }
  }

  async list(filter: Filter): Promise<Task[]> {
    if (filter.now === undefined) {
      filter.now = this.now;
    }
    try {
      return await this.s.list(filter);
    } catch (err) {
      assert.fail(`List must succeed for a valid filter, but failed: ${reason(err)}`);
    }
  }

  /** availability asks §3.3 about these ids at the fixture's fixed instant. */
  async availability(...ids: string[]): Promise<Map<string, Availability>> {
    try {
      return await this.s.availability(this.now, ...ids);
    } catch (err) {
      assert.fail(
        `Availability must succeed for stored ids, but failed: ${reason(err)}`,
      );
    }
  }

  /** answer is the availability of one id, or a failure naming the id. */
  async answer(taskID: string): Promise<Availability> {
    const got = (await this.availability(taskID)).get(taskID);
    if (got === undefined) {
      assert.fail(`Availability must answer for ${taskID}, which exists`);
    }
    return got;
  }
}

export async function newFixture(
  t: TestContext,
  newStore: Factory,
): Promise<Fixture> {
  const s = await newStore(t);
  t.after(async () => {
    try {
      await s.close();
    } catch (err) {
      assert.fail(`closing the store failed: ${reason(err)}`);
    }
  });
  try {
    await s.init();
  } catch (err) {
    assert.fail(
      `Init must be idempotent and must work on an empty store, but it failed: ${reason(err)}`,
    );
  }
  return new Fixture(t, s, new Date(Date.UTC(2026, 5, 1, 12, 0, 0)));
}

/**
 * Failures collects the assertions that Go reported with `t.Errorf`: a
 * truth-table case that fails should not hide the twenty cases after it.
 * `check` turns whatever was collected into one failure.
 */
export class Failures {
  private readonly messages: string[] = [];

  add(message: string): void {
    this.messages.push(message);
  }

  get length(): number {
    return this.messages.length;
  }

  check(): void {
    if (this.messages.length > 0) {
      assert.fail(this.messages.join('\n\n'));
    }
  }
}

/**
 * requireAvailable states the rule and the answer it expects, so a failure
 * reads as the rule that was broken.
 */
export async function requireAvailable(
  _t: TestContext,
  f: Fixture,
  rule: string,
  taskID: string,
  want: boolean,
): Promise<void> {
  const a = await f.answer(taskID);
  if (a.available !== want) {
    assert.fail(
      `${rule}\n  available=${a.available} (rule ${JSON.stringify(a.rule)}), expected available=${want}`,
    );
  }
}

/** under returns a mutator placing a node under another. */
export function under(parent: Task): Mutator {
  return (t) => {
    t.parentID = parent.id;
  };
}

export function at(position: number): Mutator {
  return (t) => {
    t.position = position;
  };
}

export function titles(ts: Task[]): string[] {
  return ts.map((t) => t.title);
}

export function ids(ts: Task[]): string[] {
  return ts.map((t) => t.id);
}

/** requireTitles fails with the rule, not just the diff. */
export function requireTitles(
  _t: TestContext,
  rule: string,
  got: Task[],
  ...want: string[]
): void {
  const have = titles(got);
  if (have.length !== want.length) {
    assert.fail(
      `${rule}\n  listing has ${have.length} item(s) ${list(have)}, expected ${want.length}: ${list(want)}`,
    );
  }
  for (let i = 0; i < want.length; i++) {
    if (have[i] !== want[i]) {
      assert.fail(
        `${rule}\n  listing is ${list(have)}, expected ${list(want)}`,
      );
    }
  }
}

/** requireSet is requireTitles where the order is not part of the rule. */
export function requireSet(
  _t: TestContext,
  rule: string,
  got: Task[],
  ...want: string[]
): void {
  const have = new Set(titles(got));
  if (have.size !== want.length) {
    assert.fail(
      `${rule}\n  listing holds ${list(titles(got))}, expected exactly ${list(want)}`,
    );
  }
  for (const w of want) {
    if (!have.has(w)) {
      assert.fail(
        `${rule}\n  listing holds ${list(titles(got))}, expected it to contain ${JSON.stringify(w)}`,
      );
    }
  }
}

/**
 * requireIs is `errors.Is` as an assertion. The sentinels are values attached
 * as a thrown error's `cause`, so this walks that chain rather than comparing
 * messages: a provider is free to wrap a sentinel in an error that says where
 * it happened, and must be.
 */
export function requireIs(
  _t: TestContext,
  rule: string,
  err: unknown,
  want: Error,
): void {
  if (!wrapsSentinel(err, want)) {
    assert.fail(
      `${rule}\n  expected an error wrapping ${want.message}, got ${reason(err)}`,
    );
  }
}

export function requireNoError(
  _t: TestContext,
  rule: string,
  err: unknown,
): void {
  if (err !== undefined) {
    assert.fail(`${rule}\n  but it failed: ${reason(err)}`);
  }
}

/**
 * failed runs an operation that is expected to be refused and returns the
 * error it threw, or undefined when it succeeded. Go's store calls returned
 * an `error` that could be handed straight to `requireIs`; here it has to be
 * caught first, and every refusal in the suite is checked through this.
 */
export async function failed(op: () => Promise<unknown>): Promise<unknown> {
  try {
    await op();
  } catch (err) {
    return err;
  }
  return undefined;
}

/** Walks the `cause` chain, outermost first, the way errors.Is does. */
export function wrapsSentinel(err: unknown, want: Error): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur !== null && cur !== undefined && !seen.has(cur)) {
    if (cur === want) {
      return true;
    }
    seen.add(cur);
    cur = typeof cur === 'object' && 'cause' in cur ? cur.cause : undefined;
  }
  return false;
}

/** timeAt returns the instant `ms` milliseconds after base, as Go's base.Add did. */
export function timeAt(base: Date, ms: number): Date {
  return new Date(base.getTime() + ms);
}

// Durations, spelled out because TypeScript has no time.Duration and a bare
// 259200000 in a test reads as noise.
export const second = 1000;
export const minute = 60 * second;
export const hour = 60 * minute;
export const day = 24 * hour;

/** describe renders an availability answer the way a failure message wants it. */
export function describe(a: Availability): string {
  if (a.available) {
    return 'available';
  }
  return `blocked by rule ${JSON.stringify(a.rule)} on ${a.blockedBy}`;
}

/** list renders a string slice the way Go's %v did, which failures quote. */
export function list(xs: readonly string[]): string {
  return `[${xs.join(' ')}]`;
}

/** reason renders a caught value for a failure message. */
export function reason(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
