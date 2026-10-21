// Creating, reading and upgrading the schema of a remote store.
//
// Go had these as methods on Store in the same package. A TypeScript class
// cannot be split across files, so they are functions over a Store here and
// turso.ts delegates to them; the module boundary is the only difference.

import { configf, providerf } from '@todocloud/core/exit';
import { isNotInitialized, ErrNotInitialized } from '@todocloud/core/store';
import * as schema from '@todocloud/core/store/schema';
import { VersionError, checkVersion } from '@todocloud/core/store/version';

import { isRemoteError } from './client.ts';
import { Batch, errClosed, messageOf, missingTable, type Store } from './turso.ts';

/**
 * SchemaVersion is the schema version this build writes and expects.
 *
 * It is the shared constant, not a second copy of the number: the two stores
 * hold the same schema, `tdo export | tdo import` moves tasks between them,
 * and a version that drifted apart would make one of the two silently wrong
 * about which migrations it owes. The DDL and the ladder come from the same
 * module for the same reason.
 */
export const SchemaVersion = schema.Version;

/**
 * metaSchemaVersion is the key the version lives under in the meta table.
 * Every provider uses the same name, so `tdo migrate` reads the same thing
 * everywhere.
 */
export const metaSchemaVersion = schema.MetaKey;

/**
 * init creates the schema and records the version. It is idempotent.
 *
 * Every statement goes up in one pipeline, so `tdo init` against a remote
 * database is a single round trip. They are deliberately all idempotent —
 * CREATE ... IF NOT EXISTS, and an upsert for the version — rather than
 * wrapped in a transaction: the pipeline reports each statement's outcome
 * separately, and a half-applied idempotent schema is repaired by running
 * `tdo init` again, whereas a COMMIT that was queued behind a failed
 * statement would not be.
 */
export async function init(s: Store): Promise<void> {
  if (s.client === undefined) {
    throw errClosed;
  }
  // init is idempotent and therefore runs against a store that already has
  // a schema — including one a newer tdo wrote. Stamping this build's
  // version over a higher one would leave the marker lying about a schema
  // it no longer describes, and every later checkSchema would pass while
  // the two disagreed. Refuse instead.
  let found: number | undefined;
  try {
    found = await schemaVersion(s);
  } catch (err) {
    if (!isNotInitialized(err)) {
      throw err;
    }
  }
  if (found !== undefined && found > schema.Version) {
    throw configf(
      new VersionError(s.describe(), found, schema.Version),
    ) as Error;
  }

  const b = new Batch();
  for (const q of schema.initial()) {
    b.add(q, false);
  }
  b.add(schema.SetVersionSQL, false, metaSchemaVersion, schema.Version);
  try {
    await s.send(b);
  } catch (err) {
    throw wrapSchema(err, 'create schema');
  }
  s.rememberVersion(schema.Version);
}

/**
 * schemaVersion reports the version recorded in the store, or
 * ErrNotInitialized when the meta table or the row is missing.
 */
export async function schemaVersion(s: Store): Promise<number> {
  const q = `SELECT value FROM meta WHERE key = ?`;
  let rows;
  try {
    rows = (await s.exec(q, true, metaSchemaVersion)).rows;
  } catch (err) {
    if (missingTable(err)) {
      // A database with no meta table is a database with no schema.
      throw new Error(`turso: ${s.database}: ${ErrNotInitialized.message}`, {
        cause: ErrNotInitialized,
      });
    }
    throw s.wrap(err, 'read ' + metaSchemaVersion);
  }
  const first = rows[0];
  if (first === undefined || first.length === 0) {
    throw new Error(
      `turso: no ${metaSchemaVersion} row: ${ErrNotInitialized.message}`,
      { cause: ErrNotInitialized },
    );
  }
  const v = (first[0] as NonNullable<typeof first[0]>).int64();
  if (v === undefined) {
    // A meta table holding something that is not a version is not a
    // store this build wrote; that means the same thing as no schema.
    throw new Error(
      `turso: ${metaSchemaVersion} is not a version: ${ErrNotInitialized.message}`,
      { cause: ErrNotInitialized },
    );
  }
  s.rememberVersion(Number(v));
  return Number(v);
}

/**
 * checkSchema reports whether the store holds the schema this build writes.
 *
 * It is the check every command makes before it does anything else, and for
 * this provider it is free: openExisting already reads the meta row to prove
 * the database is initialized, so the version is in hand before the command
 * asks. Only a store opened with open (which `tdo init` uses, and which makes
 * no request) pays for a round trip here.
 *
 * The cached value is the version this process has been working against. A
 * migration run by another process while this one is mid-command would not
 * be noticed, and that is the right trade: the alternative is a round trip
 * per command to close a window that a single CLI invocation barely has.
 */
export async function checkSchema(s: Store): Promise<void> {
  if (!s.versionKnown) {
    await schemaVersion(s);
  }
  const mismatch = checkVersion(s.version, s.describe());
  if (mismatch !== undefined) {
    throw mismatch;
  }
}

/**
 * migrate upgrades the store to the current version. A store that has never
 * been initialized is created from scratch, and one written by a newer
 * build is refused rather than guessed at.
 *
 * Each step is its own pair of round trips: one pipeline that runs the
 * step's statements, and — only once every one of them has come back ok — a
 * second that records the new version. The two cannot be combined. There is
 * no transaction over the pipeline and the server keeps executing after a
 * statement fails, so a version write sent in the same pipeline would land
 * even though the step it claims to have finished did not.
 *
 * Recording the version per step is what makes an interrupted migration
 * recoverable on a store nobody can restore from a backup: whatever happens,
 * the meta row names a version the store has actually reached, and the next
 * `tdo migrate` picks up from there. The price is that a step may run twice
 * — a crash between the statements and the version write leaves the store
 * looking like it still owes that step — which is why every step must be
 * idempotent (see schema.Step).
 */
export async function migrate(s: Store): Promise<void> {
  let current = 0;
  try {
    current = await schemaVersion(s);
  } catch (err) {
    if (!isNotInitialized(err)) {
      throw err;
    }
    // Nothing to carry forward: create the current schema directly.
    return init(s);
  }
  if (current > schema.Version) {
    throw configf(
      new VersionError(s.describe(), current, schema.Version),
    ) as Error;
  }
  if (current === schema.Version) {
    return;
  }

  for (const step of schema.pending(current)) {
    const b = new Batch();
    for (const q of step.statements) {
      b.add(q, false);
    }
    try {
      await s.send(b);
    } catch (err) {
      throw wrapSchema(err, `migration to ${step.to} (${step.name})`);
    }
    const mark = new Batch();
    mark.add(schema.SetVersionSQL, false, metaSchemaVersion, step.to);
    try {
      await s.send(mark);
    } catch (err) {
      throw wrapSchema(err, `recording version ${step.to}`);
    }
    s.rememberVersion(step.to);
  }
  // The ladder may be empty for a recorded version below the current one —
  // a version bumped without a rung, which the schema module's own checks
  // make hard but which tampering can still produce. Recording the target
  // afterwards means migrate never returns success while leaving the marker
  // where it was. It is a second write rather than part of the last step's
  // batch for the same reason the per-step marker is: a pipeline keeps
  // executing after a failed statement, so a version must only be written
  // once the work it names has come back ok.
  const final = new Batch();
  final.add(schema.SetVersionSQL, false, metaSchemaVersion, schema.Version);
  try {
    await s.send(final);
  } catch (err) {
    throw wrapSchema(err, `recording version ${schema.Version}`);
  }
  s.rememberVersion(schema.Version);
}

/**
 * wrapSchema reports a failed init or migrate. Unlike the task methods it
 * does not translate a missing table into ErrNotInitialized: these are the
 * two commands whose job is to create one, so "no such table" here is a real
 * failure and not advice to run `tdo init`.
 */
function wrapSchema(err: unknown, what: string): Error {
  const remote = isRemoteError(err);
  if (remote !== undefined) {
    return providerf(
      new Error(`turso: ${what}: ${remote.message}`, { cause: err }),
    ) as Error;
  }
  if (err instanceof Error) {
    return new Error(`turso: ${what}: ${err.message}`, { cause: err });
  }
  return new Error(`turso: ${what}: ${messageOf(err)}`, { cause: err });
}
