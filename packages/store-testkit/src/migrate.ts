// The migration conformance harness.
//
// Everything else in this package checks what a store does. This checks what
// happens to a store that already exists when a newer binary is pointed at
// it, which is the one failure in the project that cannot be undone: a Turso
// database lives in the user's own cloud account, there is no transaction over
// the wire and nothing to restore from.
//
// For every version that was ever released, the harness builds a store from
// that version's frozen DDL, fills it with representative data, runs the
// provider's own migrate, and then asserts two things:
//
//   - the data is still there and still means what it meant, read back
//     through the Store API rather than through SQL; and
//   - the resulting schema is identical to the one init writes today.
//
// The second assertion is the point of the whole file. An `init` and a
// `migrate` that quietly produce different schemas is the bug that corrupts
// data a year later, on exactly the installs nobody can restore, and the only
// way to catch it is to build both and compare them.

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import type { Store } from '@todocloud/core';
import {
  historical as historicalDDL,
  historicalVersions,
} from '@todocloud/core/store/historical';
import { MetaKey, Version } from '@todocloud/core/store/schema';

import { DefaultData } from './migratedata.ts';
import {
  compareSnapshots,
  diffSchemas,
  type SchemaSnapshot,
  snapshotSchema,
} from './schemadiff.ts';
import { failed, type Register, reason } from './storetest.ts';
import { runVersionMarker } from './version.ts';

/**
 * SQL is the raw access the harness needs and the Store interface does not
 * offer: planting a historical schema is by definition writing statements no
 * current provider method would write, and comparing two schemas means reading
 * the engine's own catalogue.
 *
 * A provider supplies it from its own test file, so none of this is exported
 * from the provider itself. There is no raw-SQL escape hatch in the shipped
 * API, and there must not be one.
 *
 * Go's field was `New`; it is `newStore` here so that nothing reads as the
 * `new` operator. Every member may be async, because two of the three
 * providers are over the wire.
 */
export interface SQL {
  /** newStore returns a store with no schema at all, already open. */
  newStore: (t: TestContext) => Store | Promise<Store>;
  /**
   * exec runs statements in order against that store and fails the test if any
   * of them does.
   */
  exec: (t: TestContext, s: Store, ...stmts: string[]) => Promise<void>;
  /**
   * query runs one query and returns its rows. A NULL comes back as NullText,
   * so that "no default" and the string "NULL" stay different things.
   */
  query: (t: TestContext, s: Store, query: string) => Promise<string[][]>;
}

/** NullText is how query renders a SQL NULL. */
export const NullText = '<null>';

/**
 * VersionData is representative data written at one version and what it must
 * still mean once the store has been migrated.
 */
export interface VersionData {
  /**
   * insert is raw SQL valid at that version. It is raw because a store at an
   * old version may not have the columns today's provider writes.
   */
  insert?: string[] | undefined;
  /**
   * verify reads the data back through the Store API after the migration.
   * Reading it back through SQL would only prove the rows are where the
   * migration left them; reading it through the API proves the tool can still
   * make sense of them.
   */
  verify?: ((t: TestContext, s: Store) => Promise<void>) | undefined;
}

/**
 * Ladder is one migration conformance run. runMigrations fills it in for the
 * shipped schema; the harness's own self-test fills it in with a ladder of its
 * own, which is how a harness that has never failed becomes one that is known
 * to work.
 */
export interface Ladder {
  sql: SQL;
  /** target is the version the ladder reaches. */
  target: number;
  /** historical maps each released version to the DDL that created it. */
  historical: Map<number, string[]>;
  /** init creates a store at target from nothing, the way `tdo init` does. */
  init: (t: TestContext, s: Store) => Promise<void>;
  /**
   * migrate carries an existing store forward, the way `tdo migrate` does. It
   * returns what went wrong rather than throwing it, because Go's signature
   * returned an `error` the harness reports itself: `failed(() => s.migrate())`
   * is the whole implementation.
   */
  migrate: (t: TestContext, s: Store) => Promise<unknown>;
  /**
   * data is keyed by the version it is written at. A version with no entry is
   * migrated empty, which still checks the schema.
   */
  data: Map<number, VersionData>;
}

/**
 * runMigrations checks the shipped ladder against one provider.
 *
 *     runMigrations({ newStore, exec, query });
 */
export function runMigrations(h: SQL, register: Register = test): void {
  register(
    'the recorded version marker is never written down to a lie',
    async (t) => {
      await runVersionMarker(t, h);
    },
  );
  register('the shipped migration ladder conforms', async (t) => {
    const historical = new Map<number, string[]>();
    for (const v of historicalVersions()) {
      const stmts = historicalDDL(v);
      if (stmts === undefined) {
        assert.fail(
          `historicalVersions names version ${v} but historical has no DDL for it`,
        );
      }
      historical.set(v, stmts);
    }
    await runLadder(t, {
      sql: h,
      target: Version,
      historical,
      init: async (t, s) => {
        const err = await failed(() => s.init());
        if (err !== undefined) {
          assert.fail(
            `Init must create the current schema on an empty store, but it failed: ${reason(err)}`,
          );
        }
      },
      migrate: (_t, s) => failed(() => s.migrate()),
      data: DefaultData,
    });
  });
}

/**
 * runLadder is runMigrations with the ladder spelled out. It registers its
 * cases as subtests of `t`, which is why it takes a TestContext where
 * runMigrations takes a Register: it is always inside a case of its own.
 */
export async function runLadder(t: TestContext, l: Ladder): Promise<void> {
  if (l.historical.size === 0) {
    assert.fail(
      'the migration harness was given no historical schema to migrate from; every released version needs one',
    );
  }
  const versions = [...l.historical.keys()].sort((a, b) => a - b);

  // The schema init produces today. Every run is compared against this one and
  // nothing else.
  const fresh = await snapshotOf(t, l, 'a freshly initialized store', (t, s) =>
    l.init(t, s),
  );

  for (const from of versions) {
    await t.test(
      `a store created at version ${from} migrates to version ${l.target} and ends up with the schema init would have written`,
      async (t) => {
        const s = await plant(t, l, from);
        const data = l.data.get(from);
        if (data?.insert !== undefined && data.insert.length > 0) {
          await l.sql.exec(t, s, ...data.insert);
        }

        const err = await l.migrate(t, s);
        if (err !== undefined) {
          assert.fail(
            `Migrate must carry a store at version ${from} forward, but it failed: ${reason(err)}`,
          );
        }
        await requireVersion(
          s,
          l.target,
          `after migrating from version ${from}`,
        );

        const got = await snapshotSchema(t, l.sql, s);
        diffSchemas(
          t,
          `a store migrated from version ${from} must end up with exactly the schema \`tdo init\` writes today;\n  an init and a migrate that disagree are how a column comes to exist on new installs and not on old ones`,
          fresh,
          got,
        );

        if (data?.verify !== undefined) {
          await data.verify(t, s);
        }
      },
    );

    await t.test(
      `a migration from version ${from} that was interrupted before it recorded the version is resumed, not refused`,
      async (t) => {
        // The version is recorded after each step and in its own round trip,
        // so a store can be left with a step's statements applied and its
        // version not yet moved. That is the state this builds: migrate, wind
        // the recorded version back, migrate again. Every step therefore has
        // to survive being run a second time over its own result.
        const s = await plant(t, l, from);
        const data = l.data.get(from);
        if (data?.insert !== undefined && data.insert.length > 0) {
          await l.sql.exec(t, s, ...data.insert);
        }
        let err = await l.migrate(t, s);
        if (err !== undefined) {
          assert.fail(
            `the first migration from version ${from} failed: ${reason(err)}`,
          );
        }
        await setVersion(t, l, s, from);

        err = await l.migrate(t, s);
        if (err !== undefined) {
          assert.fail(
            `a migration resumed from version ${from} must succeed, so that an interrupted \`tdo migrate\` is fixed by running it again, but it failed: ${reason(err)}`,
          );
        }
        await requireVersion(
          s,
          l.target,
          `after resuming a migration from version ${from}`,
        );
        diffSchemas(
          t,
          `a step that ran twice must leave the same schema as a step that ran once;\n  this is the retry an interrupted migration from version ${from} performs`,
          fresh,
          await snapshotSchema(t, l.sql, s),
        );
        if (data?.verify !== undefined) {
          await data.verify(t, s);
        }
      },
    );
  }
}

/**
 * plant builds a store holding exactly the schema of version from, with that
 * version recorded, and nothing else.
 */
async function plant(
  t: TestContext,
  l: Ladder,
  from: number,
): Promise<Store> {
  const s = await l.sql.newStore(t);
  t.after(async () => {
    try {
      await s.close();
    } catch {
      // A store the case is finished with; Go's t.Cleanup discarded this too.
    }
  });
  await l.sql.exec(t, s, ...(l.historical.get(from) ?? []));
  await setVersion(t, l, s, from);
  return s;
}

async function setVersion(
  t: TestContext,
  l: Ladder,
  s: Store,
  v: number,
): Promise<void> {
  await l.sql.exec(
    t,
    s,
    `INSERT INTO meta (key, value) VALUES ('${MetaKey}', ${v}) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
}

async function requireVersion(
  s: Store,
  want: number,
  when: string,
): Promise<void> {
  let got = 0;
  try {
    got = await s.schemaVersion();
  } catch (err) {
    assert.fail(`SchemaVersion ${when}: ${reason(err)}`);
  }
  if (got !== want) {
    assert.fail(
      `the store must be at version ${want} ${when}, but it reports ${got}`,
    );
  }
}

/** snapshotOf builds a store, runs build on it and snapshots the result. */
async function snapshotOf(
  t: TestContext,
  l: Ladder,
  what: string,
  build: (t: TestContext, s: Store) => Promise<void>,
): Promise<SchemaSnapshot> {
  const s = await l.sql.newStore(t);
  t.after(async () => {
    try {
      await s.close();
    } catch {
      // See plant.
    }
  });
  await build(t, s);
  const snap = await snapshotSchema(t, l.sql, s);
  if (snap.tables.size === 0) {
    assert.fail(
      `${what} holds no tables at all; the harness is not looking at the store it thinks it is`,
    );
  }
  return snap;
}

/**
 * ladderDiff builds the two stores runLadder compares — one that init created,
 * one planted at version from and carried forward by migrate — and returns a
 * description of how their schemas differ, or "" when they are the same. It is
 * Go's `Ladder.Diff`, a free function because Ladder is an interface a
 * provider fills in rather than a class it constructs.
 *
 * It exists so that the harness itself can be tested. A conformance check that
 * has never rejected anything is not known to work, and the only way to watch
 * this one reject something is to hand it a ladder that really does drift from
 * init and read what it says, without the attempt failing the test that is
 * making it.
 */
export async function ladderDiff(
  t: TestContext,
  l: Ladder,
  from: number,
): Promise<string> {
  const fresh = await snapshotOf(t, l, 'a freshly initialized store', (t, s) =>
    l.init(t, s),
  );
  const s = await plant(t, l, from);
  const data = l.data.get(from);
  if (data?.insert !== undefined && data.insert.length > 0) {
    await l.sql.exec(t, s, ...data.insert);
  }
  const err = await l.migrate(t, s);
  if (err !== undefined) {
    return `the migration from version ${from} failed outright: ${reason(err)}`;
  }
  return compareSnapshots(fresh, await snapshotSchema(t, l.sql, s));
}
