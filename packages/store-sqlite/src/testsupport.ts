// Test-only helpers, shared by the test files of this package the way Go's
// `sqlite_test.go` shared `openStore` and `newTask` with the other files of
// the same package. It is not part of the package's exports map: nothing
// outside `*.test.ts` in this directory may import it.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';

import { Fields, KindTask, StatusActive, Task } from '@todocloud/core/task';

import { MemoryPath, open, type Store } from './sqlite.ts';

/**
 * Literal ids for the tests that need a deterministic order or a shared
 * prefix. They are 26-character Crockford base32, upper case, no I/L/O/U.
 */
export const idA = '01J3ABCDEFGHJKMNPQRSTVWXYZ';
export const idB = '01J3BBCDEFGHJKMNPQRSTVWXYZ';
export const idC = '01J3CBCDEFGHJKMNPQRSTVWXYZ';
export const idB2 = '01J3BBCDEFGHJKMNPQRSTVWXY0';

/**
 * tempDir returns a fresh directory that is removed when the test ends. It is
 * Go's `t.TempDir()`, and it is the only place these tests are allowed to
 * write: nothing here may touch a real store path or anything under
 * ~/.config/todocloud.
 */
export function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'todocloud-sqlite-'));
  t.after(() => {
    // `after` hooks run in the order they were registered, and this one is
    // registered before the store that will open a file in here — the
    // caller cannot do it the other way around, since it needs the
    // directory to open the store in. On a POSIX system that is fine: a
    // file is unlinked while it is open and goes when the handle does. On
    // Windows an open file cannot be removed at all, so the directory of a
    // store that has not been closed yet is an EPERM, and the test that
    // passed fails in its own teardown.
    //
    // The retries cover a handle that is closing; after them, a leftover
    // directory under the OS temp is not worth failing a green test over,
    // and it is not what any of these tests is about. Everywhere else the
    // failure still stands.
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch (err) {
      if (process.platform !== 'win32') {
        throw err;
      }
    }
  });
  return dir;
}

/** openStore returns an initialized in-memory store, closed when t ends. */
export async function openStore(t: TestContext): Promise<Store> {
  const s = open(MemoryPath);
  t.after(() => s.close());
  await s.init();
  return s;
}

/** newTask builds a valid task with the given id and fields. */
export function newTask(
  taskID: string,
  title: string,
  fields?: Fields,
): Task {
  const now = new Date('2026-03-04T05:06:07Z');
  const t = new Task();
  t.id = taskID;
  t.kind = KindTask;
  t.title = title;
  t.status = StatusActive;
  t.createdAt = now;
  t.updatedAt = now;
  t.fields = fields ?? {};
  return t;
}

/**
 * rejects asserts that the promise fails with an error the predicate accepts,
 * and hands the error back so a test can say more about it. Go wrote
 * `errors.Is(err, want)` inline; the predicates in core are the same test.
 */
export async function rejects(
  promise: Promise<unknown>,
  pred: (err: unknown) => boolean,
  message: string,
): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    assert.ok(pred(err), `${message}, but it failed with: ${String(err)}`);
    return err;
  }
  assert.fail(`${message}, but it succeeded`);
}

/** throwsWith is `rejects` for the synchronous half of the API. */
export function throwsWith(
  fn: () => unknown,
  pred: (err: unknown) => boolean,
  message: string,
): unknown {
  try {
    fn();
  } catch (err) {
    assert.ok(pred(err), `${message}, but it failed with: ${String(err)}`);
    return err;
  }
  return assert.fail(`${message}, but it succeeded`);
}

/** errorText renders an error the way a user would see it, cause chain and all. */
export function errorText(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur !== null && cur !== undefined && !seen.has(cur)) {
    seen.add(cur);
    parts.push(cur instanceof Error ? cur.message : String(cur));
    cur =
      typeof cur === 'object' && cur !== null && 'cause' in cur
        ? cur.cause
        : undefined;
  }
  return parts.join(': ');
}
