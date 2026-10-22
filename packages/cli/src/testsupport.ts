// The test harness for the command layer.
//
// Go kept this in cli_test.go, which the whole package's tests shared. Node's
// test runner gives a test file no access to another's, so it lives in its own
// module — the convention `packages/core/src/taskops/testsupport.ts` and
// `packages/store-sqlite/src/testsupport.ts` already follow. Every command's
// tests are expected to use it rather than build a second one.
//
// It runs the real command tree against a temporary SQLite database and a
// temporary state directory, capturing both streams. Nothing here touches the
// user's own configuration, state directory or keychain: the environment is
// injected, the keychain lookup is a stub that reports no entry, and the
// state directory is redirected in the process environment as well, because
// shortref reads it from there.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TestContext } from 'node:test';

import { Secret } from '@todocloud/core/secret';
import type { Writer } from '@todocloud/core/output';
import type { Store } from '@todocloud/core/store';
import { type Task, newTask } from '@todocloud/core/task';
import * as id from '@todocloud/core/id';
import { open as openSQLite } from '@todocloud/store-sqlite';

import { type CommandFactory, type Env, RunWith, type Ticker } from './app.ts';

/** buffer is a Writer that keeps everything written to it. */
export class buffer implements Writer {
  text = '';

  write(s: string): void {
    this.text += s;
  }
}

/** Result is one command's observable behaviour. */
export interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Harness runs commands against a temporary store. Create one with
 * newHarness, which registers its own cleanup on the test context.
 */
export class Harness {
  /** dir is the temporary directory everything lives under. */
  readonly dir: string;
  /** db is the SQLite file the commands open. */
  readonly db: string;
  /** env is what every run injects; a test may add to it. */
  readonly env: Record<string, string>;
  /** factories is the command table under test. */
  factories: readonly CommandFactory[] | undefined;
  /**
   * stdoutIsTTY is what the injected environment claims about stdout. It is
   * false by default, which is the honest answer for a captured buffer and
   * the one `--watch` refuses.
   */
  stdoutIsTTY = false;
  /** ticker paces a `--watch` loop; see FrameTicker. */
  ticker: Ticker | undefined;

  constructor(dir: string, db: string, env: Record<string, string>) {
    this.dir = dir;
    this.db = db;
    this.env = env;
  }

  /** envFor builds the injected Env, with both streams captured. */
  private envFor(out: buffer, err: buffer): Env {
    return {
      stdout: out,
      stderr: err,
      stdin: { read: (): Promise<string> => Promise.resolve('') },
      getenv: (name: string): string => this.env[name] ?? '',
      stdinIsTTY: (): boolean => false,
      stdoutIsTTY: (): boolean => this.stdoutIsTTY,
      ticker: this.ticker,
      // No test may query the developer's real keychain (CLAUDE.md §1.5).
      keyring: () => ({ value: new Secret(''), present: false }),
    };
  }

  /** run executes one command line and returns what it produced. */
  async run(...args: string[]): Promise<Result> {
    const out = new buffer();
    const err = new buffer();
    const code = await RunWith(this.envFor(out, err), ['tdo', ...args], this.factories);
    return { code, stdout: out.text, stderr: err.text };
  }

  /** mustRun throws unless the command exits 0. */
  async mustRun(...args: string[]): Promise<Result> {
    const res = await this.run(...args);
    if (res.code !== 0) {
      throw new Error(
        `tdo ${args.join(' ')}: exit ${res.code}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`,
      );
    }
    return res;
  }

  /** store opens the temporary store directly, for a test's own setup. */
  withStore<T>(fn: (st: Store) => Promise<T>): Promise<T> {
    return withStore(this.db, fn);
  }

  /**
   * add writes a task straight into the store, which is how a test gets rows
   * without the `add` command. The task is returned as it was stored.
   */
  async add(title: string, taskID?: string): Promise<Task> {
    const t = newTask(taskID ?? id.New(), 'task', title, new Date());
    await this.withStore(async (st) => st.add(t));
    return t;
  }

  /**
   * decode parses stdout as a single JSON value, which also asserts that
   * nothing but JSON reached stdout.
   */
  decode(res: Result): Record<string, unknown> {
    const text = res.stdout.trim();
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`stdout is not a JSON object: ${res.stdout}`);
    }
    if (text.includes('\n')) {
      throw new Error(`stdout holds more than one JSON value: ${res.stdout}`);
    }
    return value as Record<string, unknown>;
  }

  /** tasksOf pulls the list out of a {"tasks":[…]} response. */
  tasksOf(res: Result): Record<string, unknown>[] {
    const obj = this.decode(res);
    const raw = obj['tasks'];
    if (!Array.isArray(raw)) {
      throw new Error(`no tasks array in ${res.stdout}`);
    }
    return raw as Record<string, unknown>[];
  }

  /**
   * taskOf pulls the single task out of a response. Every command emits
   * {"tasks":[…],"count":n}, so a command that acts on one item emits a
   * one-element array and this is `.tasks[0]`.
   */
  taskOf(res: Result): Record<string, unknown> {
    const tasks = this.tasksOf(res);
    if (tasks.length !== 1) {
      throw new Error(`expected exactly one task in ${res.stdout}, got ${tasks.length}`);
    }
    return tasks[0] as Record<string, unknown>;
  }
}

/**
 * FrameTicker drives a `--watch` loop for exactly `frames` draws and records
 * the interval it was asked to wait each time. It is how the loop is tested
 * without waiting for a timer or sending a signal; see the note on Ticker in
 * app.ts.
 */
export class FrameTicker implements Ticker {
  /** waits holds the interval of every wait, in the order they happened. */
  readonly waits: number[] = [];

  private readonly frames: number;

  constructor(frames: number) {
    this.frames = frames;
  }

  wait(ms: number): Promise<boolean> {
    this.waits.push(ms);
    return Promise.resolve(this.waits.length < this.frames);
  }
}

/**
 * watchFor makes the harness watchable: stdout claims a terminal and the loop
 * runs for `frames` draws. The ticker is returned so a test can read the pace
 * the command chose.
 */
export function watchFor(h: Harness, frames: number): FrameTicker {
  const ticker = new FrameTicker(frames);
  h.stdoutIsTTY = true;
  h.ticker = ticker;
  return ticker;
}

/** withStore opens a SQLite store at path, runs fn and closes it. */
export async function withStore<T>(dbPath: string, fn: (st: Store) => Promise<T>): Promise<T> {
  const st = openSQLite(dbPath);
  try {
    return await fn(st);
  } finally {
    await st.close();
  }
}

/**
 * newHarness creates a harness with an initialized store. The schema is
 * created directly rather than through `tdo init`, so that the harness does
 * not depend on which commands have been ported.
 */
export async function newHarness(
  t: TestContext,
  factories?: readonly CommandFactory[],
): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdo-cli-'));
  const db = path.join(dir, 'tasks.db');
  const state = path.join(dir, 'state');

  // shortref reads the state directory from the process environment, so the
  // cache has to be redirected there as well as in the injected environment.
  const previousState = process.env['TODOCLOUD_STATE_DIR'];
  process.env['TODOCLOUD_STATE_DIR'] = state;
  t.after(() => {
    if (previousState === undefined) {
      delete process.env['TODOCLOUD_STATE_DIR'];
    } else {
      process.env['TODOCLOUD_STATE_DIR'] = previousState;
    }
    // The store this harness opened is closed by an `after` hook of its own,
    // and `after` hooks run in the order they were registered — this one
    // first, because the directory has to exist before the store can be
    // opened in it. POSIX unlinks an open file and lets the handle finish;
    // Windows refuses to remove one at all, so a test that passed failed in
    // its own teardown with EBUSY. The retries cover a handle that is
    // closing; after them, a leftover directory under the OS temp is not
    // worth failing a green test over, and only on Windows is it tolerated.
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch (err) {
      if (process.platform !== 'win32') {
        throw err;
      }
    }
  });

  const h = new Harness(dir, db, {
    TODOCLOUD_PROVIDER: 'sqlite',
    TODOCLOUD_SQLITE_PATH: db,
    TODOCLOUD_STATE_DIR: state,
    // Keep the developer's own configuration out of the test.
    HOME: dir,
    XDG_CONFIG_HOME: path.join(dir, 'config'),
    XDG_STATE_HOME: state,
    TODOCLOUD_CONFIG: '',
  });
  if (factories !== undefined) {
    h.factories = factories;
  }
  await withStore(db, async (st) => st.init());
  return h;
}

/**
 * assertCleanFailure is the Go helper of the same name: a refusal must say
 * something on stderr, and it must not leak the engine, the runtime or a file
 * path from inside the implementation.
 */
export function assertCleanFailure(t: TestContext, stderr: string): void {
  if (stderr.trim() === '') {
    t.diagnostic('the rejection printed nothing on stderr');
    throw new Error('the rejection printed nothing on stderr');
  }
  for (const leak of [
    'at Object.',
    'node:internal',
    '.ts:',
    'SQLITE_',
    'no such table',
    'node_modules',
  ]) {
    if (stderr.includes(leak)) {
      throw new Error(`the error leaks ${JSON.stringify(leak)}: ${stderr}`);
    }
  }
}
