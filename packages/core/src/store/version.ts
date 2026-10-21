// The schema-version seam: the sentinel, the error that carries the detail,
// the two optional capabilities a provider may have, and the migration plan
// the command layer shows before it changes anything.
//
// Port notes:
//
//   - Go's `(*VersionError).Is` made `errors.Is(err, ErrSchemaMismatch)` true
//     for every VersionError. Here `VersionError` carries ErrSchemaMismatch as
//     its `cause`, so the chain walk in `isSchemaMismatch` finds it the same
//     way, and `exit.classify` needs to know about only the sentinel.
//   - Go's optional interfaces were type assertions on Store. They are
//     structural here, which is what a TypeScript interface already is: a
//     provider implements VersionChecker by having a `checkSchema` method, and
//     `checkSchema` below tests for it rather than requiring a declaration.

import { Version, pending } from './schema.ts';
import { isNotInitialized, type Store } from './store.ts';

/**
 * ErrSchemaMismatch is reported when the store's schema version is not the
 * one this build writes. It is a configuration problem, exit 3, and the
 * message always says what to do about it: migrate the store when it is
 * older, upgrade the binary when it is newer.
 *
 * It exists as a sentinel so that the command layer can branch without
 * parsing prose and so that no raw SQL error ever reaches the user in its
 * place: a binary that ran a query against a schema it does not understand
 * would at best fail oddly and at worst answer wrongly.
 */
export const ErrSchemaMismatch = new Error(
  "the store's schema version is not the one this tdo expects",
);

/** Reports whether err, or anything it wraps, is ErrSchemaMismatch. */
export function isSchemaMismatch(err: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur !== null && cur !== undefined && !seen.has(cur)) {
    if (cur === ErrSchemaMismatch) {
      return true;
    }
    seen.add(cur);
    cur = typeof cur === 'object' && 'cause' in cur ? cur.cause : undefined;
  }
  return false;
}

/** VersionError is the detail behind ErrSchemaMismatch. */
export class VersionError extends Error {
  override readonly name = 'VersionError';
  /**
   * store is the provider's own description of where the data is. It is
   * credential-free: it is whatever describe returns.
   */
  readonly store: string;
  /**
   * found is the version recorded in the store, want the one this build
   * writes.
   */
  readonly found: number;
  readonly want: number;

  constructor(store: string, found: number, want: number) {
    super(VersionError.describe(store, found, want), {
      cause: ErrSchemaMismatch,
    });
    this.store = store;
    this.found = found;
    this.want = want;
  }

  /**
   * older reports whether the store is behind the binary, which is the case
   * `tdo migrate` fixes.
   */
  older(): boolean {
    return this.found < this.want;
  }

  private static describe(
    store: string,
    found: number,
    want: number,
  ): string {
    if (found < want) {
      return `${store} is at schema version ${found} and this tdo expects ${want}; run \`tdo migrate\` to upgrade it`;
    }
    return `${store} is at schema version ${found} and this tdo only understands ${want}; upgrade tdo`;
  }
}

/**
 * checkVersion compares a version read from a store with the one this build
 * writes and returns a VersionError when they differ, or undefined when they
 * agree. Go returned an `error`; the caller raises it.
 */
export function checkVersion(
  found: number,
  describe: string,
): VersionError | undefined {
  if (found === Version) {
    return undefined;
  }
  return new VersionError(describe, found, Version);
}

/**
 * VersionChecker is implemented by a provider that can answer "is this store
 * the version I expect?" without paying for a round trip — because it
 * already asked, or because asking is free.
 *
 * It is an optional capability rather than a method on Store so that adding
 * it breaks no provider that has not been taught it yet; checkSchema falls
 * back to schemaVersion.
 */
export interface VersionChecker {
  checkSchema(): Promise<void>;
}

function isVersionChecker(s: Store): s is Store & VersionChecker {
  return typeof (s as Partial<VersionChecker>).checkSchema === 'function';
}

/**
 * checkSchema verifies that s holds the schema this build writes, throwing
 * when it does not.
 *
 * This is the seam every command uses. It raises ErrNotInitialized for a
 * store with no schema (exit 3, "run `tdo init`"), ErrSchemaMismatch for one
 * at the wrong version (exit 3, with the right advice either way), and
 * returns normally when the store can be used. A command that skips it can
 * return a wrong answer against a schema it does not understand, which is
 * worse than an error.
 *
 * It is cheap: a provider that already knows the version answers from what
 * it has. For turso that is the probe openExisting makes, so a checked
 * command costs exactly the round trips an unchecked one did.
 */
export async function checkSchema(s: Store): Promise<void> {
  if (isVersionChecker(s)) {
    return s.checkSchema();
  }
  const v = await s.schemaVersion();
  const err = checkVersion(v, s.describe());
  if (err !== undefined) {
    throw err;
  }
}

/**
 * Backupper is implemented by a provider that can copy the data aside before
 * a migration changes it. A provider that cannot — anything remote — simply
 * does not implement it, and planMigration then reports that there will be
 * no backup.
 */
export interface Backupper {
  /**
   * backupForMigration copies the store as it is now and returns the path of
   * the copy. `from` is the version being left, so that the name says which
   * schema the copy holds.
   */
  backupForMigration(from: number): Promise<string>;
}

function isBackupper(s: Store): s is Store & Backupper {
  return typeof (s as Partial<Backupper>).backupForMigration === 'function';
}

/**
 * MigrationPlan is what the command layer needs to know before it runs a
 * migration: what will happen, what was saved first, and whether it has to
 * ask the user.
 */
export interface MigrationPlan {
  /** store is the provider's credential-free description of itself. */
  store: string;
  /**
   * from is the version recorded now; to is the version migrate will reach.
   * from is 0 when the store holds no schema at all, in which case migrate
   * creates one.
   */
  from: number;
  to: number;
  /** upToDate is true when there is nothing to do. */
  upToDate: boolean;
  /**
   * steps names the migrations that will run, in order, for a command that
   * wants to say what it is about to do.
   */
  steps: string[];
  /**
   * backupPath is where the data was copied before anything changed. It is
   * empty when no backup was taken, and a command that got one should print
   * it: a user who is told where the copy is can undo the migration
   * themselves.
   */
  backupPath: string;
  /**
   * confirm is true when no backup could be taken, which is the case for
   * every remote store. The command layer must then get an explicit yes
   * before calling migrate, and must refuse rather than prompt when stdin is
   * not a terminal — the same rule `tdo rm --purge` follows.
   */
  confirm: boolean;
  /**
   * warning is the sentence to show the user when confirm is true. It names
   * the store and says plainly that there is no backup.
   */
  warning: string;
}

/**
 * planMigration reads the store's version, refuses one written by a newer
 * binary, and — for a provider that can — takes the backup, before any step
 * runs. The command layer calls it, shows the user what it says, and then
 * calls migrate.
 *
 * The backup is taken here, not inside migrate, so that the path can be
 * printed before the risky part starts: a user watching a migration fail
 * should already have been told where the copy is.
 */
export async function planMigration(s: Store): Promise<MigrationPlan> {
  const plan: MigrationPlan = {
    store: s.describe(),
    from: 0,
    to: Version,
    upToDate: false,
    steps: [],
    backupPath: '',
    confirm: false,
    warning: '',
  };

  let current = 0;
  let initialized = false;
  try {
    current = await s.schemaVersion();
    initialized = true;
  } catch (err) {
    if (!isNotInitialized(err)) {
      throw err;
    }
    // A store with no schema is not a migration; migrate creates one.
    current = 0;
  }
  plan.from = current;

  if (current > Version) {
    throw new VersionError(plan.store, current, Version);
  }
  if (current === Version) {
    plan.upToDate = true;
    return plan;
  }
  for (const step of pending(current)) {
    plan.steps.push(step.name);
  }

  // An uninitialized store holds nothing to lose, so neither the backup nor
  // the confirmation applies to it. The test is whether there was a schema to
  // read, not whether the version came back as zero: a store that somehow
  // recorded version 0 still has rows in it.
  if (!initialized) {
    return plan;
  }

  if (!isBackupper(s)) {
    plan.confirm = true;
    plan.warning =
      `${plan.store} is remote: tdo cannot take a backup of it, and a ` +
      `migration cannot be undone. Take your provider's own snapshot first ` +
      `if you want one.`;
    return plan;
  }
  plan.backupPath = await s.backupForMigration(current);
  return plan;
}
