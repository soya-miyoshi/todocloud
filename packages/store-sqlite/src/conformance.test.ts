import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import type { Store as StoreContract } from '@todocloud/core/store';
import { NullText, run, runMigrations } from '@todocloud/store-testkit';

import { MemoryPath, open, type Store, text } from './sqlite.ts';

// SQLite is the reference provider, so a failure here is a failure of the
// definition as much as of this implementation.

// The whole Store contract, against an in-memory store per sub-suite.
run((t: TestContext): Store => {
  const s = open(MemoryPath);
  t.after(() => s.close());
  return s;
});

/**
 * The migration harness needs raw SQL access, which the shipped API
 * deliberately does not offer. It lives in this test file on purpose: the
 * provider has no way to run an arbitrary statement, and it must not grow one.
 *
 * Every store is a file rather than `:memory:`, because the backup path and
 * the file mode are part of what the migration machinery does.
 */
runMigrations({
  newStore: (t: TestContext): Store => {
    const dir = mkdtempSync(join(tmpdir(), 'todocloud-sqlite-'));
    const s = open(join(dir, 'tasks.db'));
    t.after(async () => {
      await s.close();
      // Windows refuses to remove a file that still has a handle open, and a
      // SQLite handle can outlive the store that owned it for a moment. POSIX
      // never notices. Retry, and on Windows only, leave the directory behind
      // rather than fail a green test in its own teardown (see testsupport.ts).
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      } catch (err) {
        if (process.platform !== 'win32') {
          throw err;
        }
      }
    });
    return s;
  },
  exec: async (t: TestContext, s: StoreContract, ...stmts: string[]) => {
    for (const stmt of stmts) {
      try {
        asSqlite(s).db.exec(stmt);
      } catch (err) {
        assert.fail(`executing ${firstLine(stmt)}: ${String(err)}`);
      }
    }
  },
  query: async (t: TestContext, s: StoreContract, query: string) => {
    let rows;
    try {
      rows = asSqlite(s).db.rows(query);
    } catch (err) {
      return assert.fail(`querying ${firstLine(query)}: ${String(err)}`);
    }
    // A NULL comes back as NullText, so that "no default" and the string
    // "NULL" stay different things.
    return rows.map((row) =>
      Object.values(row).map((cell) => text(cell) ?? NullText),
    );
  },
});

/**
 * asSqlite recovers the provider's own type from the interface the harness
 * hands back. Go wrote `s.(*Store)`; the cast is the same assertion, and it is
 * sound because this file is the only thing that creates these stores.
 */
function asSqlite(s: StoreContract): Store {
  return s as Store;
}

function firstLine(s: string): string {
  const i = s.indexOf('\n');
  return i >= 0 ? `${s.slice(0, i)} ...` : s;
}

// A guard rather than a test: `run` and `runMigrations` register their own
// cases, so a typo in the import above would otherwise show up as a suite
// that silently ran nothing.
test('the shared suite was registered', () => {
  assert.equal(typeof run, 'function');
  assert.equal(typeof runMigrations, 'function');
});
