// The one number every command trusts.

import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';

import {
  ErrSchemaMismatch,
  type Store,
  VersionError,
} from '@todocloud/core';
import { MetaKey, Version } from '@todocloud/core/store/schema';

import type { SQL } from './migrate.ts';
import { failed, Failures, reason, wrapsSentinel } from './storetest.ts';

/**
 * runVersionMarker checks the one number every command trusts.
 *
 * The recorded version decides whether a binary believes it understands the
 * rows it is about to read, so the ways of writing it have to leave it telling
 * the truth. The case that motivated this: init is idempotent, so it meets
 * stores that already have a schema — including one a newer tdo wrote.
 * Stamping this binary's version over a higher one leaves the marker
 * describing a schema that is not there, and from then on every version check
 * passes while the two disagree. Nothing later can detect it.
 */
export async function runVersionMarker(
  t: TestContext,
  h: SQL,
): Promise<void> {
  await t.test(
    'a second Init does not change the recorded version',
    async (t) => {
      const s = await newInitialized(t, h);
      const err = await failed(() => s.init());
      if (err !== undefined) {
        assert.fail(
          `Init must be idempotent, but a second call failed: ${reason(err)}`,
        );
      }
      await requireVersion(t, h, s, Version, 'after a second Init');
    },
  );

  await t.test('Migrate on a current store is a clean no-op', async (t) => {
    const s = await newInitialized(t, h);
    const err = await failed(() => s.migrate());
    if (err !== undefined) {
      assert.fail(
        `Migrate on a current store must succeed and do nothing: ${reason(err)}`,
      );
    }
    await requireVersion(
      t,
      h,
      s,
      Version,
      'after Migrate on a current store',
    );
  });

  // Both writers must refuse a store from the future rather than rewrite its
  // marker downwards.
  const newer = Version + 1;
  const writers: Array<{ name: string; call: (s: Store) => Promise<void> }> = [
    { name: 'Init', call: (s) => s.init() },
    { name: 'Migrate', call: (s) => s.migrate() },
  ];
  for (const tc of writers) {
    await t.test(
      `${tc.name} refuses a store written by a newer tdo`,
      async (t) => {
        const s = await newInitialized(t, h);
        await setVersion(t, h, s, newer);

        // Collected rather than fatal, because the marker check below is the
        // more important of the two: a refusal with the wrong sentinel is a
        // mapping bug, while a refusal that rewrote the marker is data loss.
        const failures = new Failures();
        const err = await failed(() => tc.call(s));
        if (err === undefined) {
          failures.add(
            `${tc.name} against a store at version ${newer} must refuse; it reported success`,
          );
        } else {
          if (!wrapsSentinel(err, ErrSchemaMismatch)) {
            failures.add(
              `${tc.name} returned ${reason(err)}, which does not wrap ErrSchemaMismatch; that sentinel is what the command layer maps to exit 3`,
            );
          }
          const ve = asVersionError(err);
          if (ve !== undefined && ve.found !== newer) {
            failures.add(
              `${tc.name} reported the store at version ${ve.found}, want ${newer}`,
            );
          }
        }
        try {
          await requireVersion(t, h, s, newer, `after ${tc.name} refused`);
        } catch (e) {
          failures.add(reason(e));
        }
        failures.check();
      },
    );
  }
}

/** newInitialized returns a store with the current schema in it. */
async function newInitialized(t: TestContext, h: SQL): Promise<Store> {
  const s = await h.newStore(t);
  t.after(async () => {
    try {
      await s.close();
    } catch {
      // Closing a store the case is finished with is not a conformance
      // failure, and Go discarded this error too.
    }
  });
  const err = await failed(() => s.init());
  if (err !== undefined) {
    assert.fail(`Init on an empty store: ${reason(err)}`);
  }
  return s;
}

/** asVersionError is `errors.As` for the one wrapped type the suite reads. */
function asVersionError(err: unknown): VersionError | undefined {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur !== null && cur !== undefined && !seen.has(cur)) {
    if (cur instanceof VersionError) {
      return cur;
    }
    seen.add(cur);
    cur = typeof cur === 'object' && 'cause' in cur ? cur.cause : undefined;
  }
  return undefined;
}

async function setVersion(
  t: TestContext,
  h: SQL,
  s: Store,
  v: number,
): Promise<void> {
  await h.exec(
    t,
    s,
    `INSERT INTO meta (key, value) VALUES (${quote(MetaKey)}, '${v}')
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
}

async function requireVersion(
  t: TestContext,
  h: SQL,
  s: Store,
  want: number,
  when: string,
): Promise<void> {
  const rows = await h.query(
    t,
    s,
    `SELECT value FROM meta WHERE key = ${quote(MetaKey)}`,
  );
  const row = rows[0];
  if (rows.length !== 1 || row === undefined || row.length !== 1) {
    assert.fail(
      `${when}: the meta table holds ${rows.length} version row(s), want exactly 1`,
    );
  }
  const raw = row[0] as string;
  if (!/^-?[0-9]+$/.test(raw)) {
    assert.fail(
      `${when}: the recorded version ${JSON.stringify(raw)} is not a number`,
    );
  }
  const got = Number(raw);
  if (got !== want) {
    assert.fail(
      `${when}: the recorded schema version is ${got}, want ${want}`,
    );
  }
}

/**
 * quote renders a SQL string literal. The only values it ever sees are this
 * package's own constants, but doubling the quote keeps it honest.
 */
export function quote(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}
