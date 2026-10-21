// The schema half of the provider: create, read the version, migrate, and
// take the copy a migration is allowed to rely on. Go kept these in
// `schema.go` on the same type; see the port note at the top of `sqlite.ts`
// for why they are functions over the store here.

import { chmodSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

import { ErrNotInitialized, isNotInitialized } from '@todocloud/core/store';
import {
  MetaKey,
  SetVersionSQL,
  Version,
  initial,
  pending,
} from '@todocloud/core/store/schema';
import { VersionError, checkVersion } from '@todocloud/core/store/version';

import { fileMode, intBind, MemoryPath, type Store } from './sqlite.ts';

/**
 * SchemaVersion is the schema version this build writes and expects.
 *
 * It is an alias for the shared constant, not a second copy of the number.
 * The DDL and the migration ladder live in @todocloud/core/store/schema so
 * that the two providers cannot drift apart; the version has to come from the
 * same place for the same reason.
 */
export const SchemaVersion = Version;

/**
 * metaSchemaVersion is the key under which the version lives in the meta
 * table. Every provider uses the same name, so `tdo migrate` reads the same
 * thing everywhere.
 */
export const metaSchemaVersion = MetaKey;

/** init creates the schema and records the version. It is idempotent. */
export async function init(s: Store): Promise<void> {
  // init is idempotent and therefore runs against a store that already has
  // a schema — including one a newer tdo wrote. Stamping this build's
  // version over a higher one would leave the marker lying about a schema
  // it no longer describes, and every later checkSchema would pass while
  // the two disagreed. Refuse instead.
  try {
    const found = await schemaVersion(s);
    if (found > Version) {
      throw new VersionError(s.describe(), found, Version);
    }
  } catch (err) {
    if (!isNotInitialized(err)) {
      throw err;
    }
  }

  s.transaction('init', () => {
    for (const stmt of initial()) {
      try {
        s.db.exec(stmt);
      } catch (err) {
        throw new Error('sqlite: create schema', { cause: err });
      }
    }
    setVersion(s, Version);
  });
}

/**
 * schemaVersion reports the version recorded in the store, or
 * ErrNotInitialized when the meta table or the row is missing.
 */
export async function schemaVersion(s: Store): Promise<number> {
  let row: Record<string, unknown> | undefined;
  try {
    row = s.db.one(`SELECT value FROM meta WHERE key = ?`, metaSchemaVersion);
  } catch {
    // A missing meta table lands here; it means the same thing as a missing
    // row, and the driver's "no such table" must not reach the user.
    throw new Error(`sqlite: read ${metaSchemaVersion}`, {
      cause: ErrNotInitialized,
    });
  }
  if (row === undefined) {
    throw new Error(`sqlite: no ${metaSchemaVersion} row`, {
      cause: ErrNotInitialized,
    });
  }
  return Number(row['value']);
}

/**
 * checkSchema reports whether the store holds the schema this build writes.
 * It is the cheap check every command makes before it does anything else:
 * one indexed read of a one-row table, and a clear error either way instead
 * of a query against a schema this build does not understand.
 */
export async function checkSchema(s: Store): Promise<void> {
  const v = await schemaVersion(s);
  const err = checkVersion(v, s.describe());
  if (err !== undefined) {
    throw err;
  }
}

/**
 * migrate upgrades the store to the current version. A store that has never
 * been initialized is created from scratch, and one written by a newer build
 * is refused.
 *
 * The whole ladder runs in one transaction, which SQLite can do and the
 * remote providers cannot, so an interrupted migration leaves the file
 * exactly as it was. The version is nevertheless recorded after every step
 * rather than once at the end: it costs one statement, it keeps this
 * provider's ladder-running identical to the one that has no transaction to
 * fall back on, and it means a step that one day has to run outside the
 * transaction does not need a different resumption story.
 */
export async function migrate(s: Store): Promise<void> {
  let current: number;
  try {
    current = await schemaVersion(s);
  } catch (err) {
    if (!isNotInitialized(err)) {
      throw err;
    }
    // Nothing to carry forward: create the current schema directly.
    return init(s);
  }
  if (current > Version) {
    throw new VersionError(s.describe(), current, Version);
  }
  if (current === Version) {
    return;
  }

  s.transaction('migrate', () => {
    for (const step of pending(current)) {
      for (const stmt of step.statements) {
        try {
          s.db.exec(stmt);
        } catch (err) {
          throw new Error(
            `sqlite: migration to ${step.to} (${step.name})`,
            { cause: err },
          );
        }
      }
      setVersion(s, step.to);
    }
    // The ladder may be empty for a recorded version below the current one —
    // a version bumped without a rung, which the schema module's own checks
    // make hard but which tampering can still produce. Recording the target
    // after the loop means migrate never commits while leaving the marker
    // where it was, quietly reporting success without arriving.
    setVersion(s, Version);
  });
}

/**
 * backupSuffix marks a file as a copy this tool made. It is spelled out
 * rather than abbreviated because the one person who will ever read it is
 * looking at a directory listing and wondering what happened to their tasks.
 */
const backupSuffix = '.backup-v';

/**
 * backupForMigration copies the database beside itself before a migration
 * changes it, and returns the path of the copy. It implements Backupper,
 * which is how `tdo migrate` knows a local store can be protected and a
 * remote one cannot.
 *
 * The copy is made with VACUUM INTO rather than by copying bytes: the
 * database runs in WAL mode, so the file alone is not the whole database,
 * and a plain file copy would silently leave behind whatever is still in the
 * write-ahead log. VACUUM INTO asks the engine for a consistent copy of
 * everything.
 *
 * An existing backup is never overwritten. A migration that failed once has
 * already left a copy that is the only version of that data in its old
 * shape, and a second attempt must not land on top of it.
 */
export async function backupForMigration(
  s: Store,
  from: number,
): Promise<string> {
  if (s.db.path === MemoryPath) {
    // There is no file, and an in-memory store holds nothing that outlives
    // the process anyway.
    return '';
  }
  const path = backupPath(s, from);
  try {
    // The path is built here from the store's own path and an integer, so
    // there is no user input in this statement; SQLite has no placeholder
    // for the target of VACUUM INTO.
    s.db.exec(`VACUUM INTO ${quoteLiteral(path)}`);
  } catch (err) {
    throw new Error(`sqlite: back up ${s.db.path} to ${path}`, { cause: err });
  }
  // A task list is private data and VACUUM INTO creates the file with the
  // process umask, which on most machines means world-readable. `chmodSync`
  // is not masked by the umask, which is why the mode is set afterwards
  // rather than asked for up front.
  try {
    chmodSync(path, fileMode);
  } catch (err) {
    throw new Error(`sqlite: securing the backup at ${path}`, { cause: err });
  }
  return path;
}

/**
 * backupPath picks a name that says both that the file is a backup and which
 * schema version it holds, and that does not already exist.
 */
function backupPath(s: Store, from: number): string {
  const base = `${s.db.path}${backupSuffix}${from}`;
  for (let n = 0; n < 100; n++) {
    const candidate = n === 0 ? base : `${base}.${n + 1}`;
    try {
      statSync(candidate);
    } catch (err) {
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        err.code === 'ENOENT'
      ) {
        return candidate;
      }
      throw new Error(
        `sqlite: checking for a free backup name at ${dirname(s.db.path)}`,
        { cause: err },
      );
    }
  }
  throw new Error(
    `sqlite: ${base} already has 100 backups; move some of them away first`,
  );
}

/**
 * quoteLiteral renders a path as a SQL string literal. VACUUM INTO takes no
 * bound parameter, so this is the one place a value is spliced into a
 * statement; a single quote in a path is doubled, which is the only escape
 * SQLite string literals have.
 */
export function quoteLiteral(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}

function setVersion(s: Store, v: number): void {
  try {
    s.db.run(SetVersionSQL, metaSchemaVersion, intBind(v));
  } catch (err) {
    throw new Error(`sqlite: record ${metaSchemaVersion}`, { cause: err });
  }
}
