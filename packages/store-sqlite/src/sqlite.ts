// Package store-sqlite stores tasks in a local SQLite file.
//
// It is the reference provider: the one every test runs against, the one the
// shared conformance suite is written for, and the one whose column layout
// the cloud providers imitate. The required fields of PLAN.md §3.2 are
// columns, tags are a join table, and the user-defined part of a task is one
// JSON object in the fields column, so adding an attribute never needs a
// migration.
//
// The tree rules and the availability computation are not written here. They
// live in @todocloud/core as pure functions over an in-memory tree, and this
// package loads the rows and asks. That is what keeps every provider's answer
// to "is this available?" the same answer.
//
// The driver is `node:sqlite`, which ships with Node, so the package has no
// runtime dependency and no native build step — the TypeScript counterpart of
// what `CGO_ENABLED=0` bought the Go tree.
//
// Port notes, where TypeScript cannot hold the Go shape exactly:
//
//   - `Store` is async (see the interface in @todocloud/core/store), while
//     `node:sqlite` is a synchronous API. Every method therefore does its
//     work synchronously and returns an already-settled promise. `describe`
//     stays synchronous because the interface says so.
//   - Go's `context.Context` first parameter is gone from every method and is
//     deliberately not replaced by an `AbortSignal`: there is nothing to
//     cancel between two synchronous statements.
//   - Go's sentinel errors were compared with `errors.Is`. Here the sentinel
//     is attached as a thrown error's `cause`, and the `isX` predicates in
//     core walk that chain.
//   - Go had a `*sql.DB` and a `*sql.Tx` with the same query surface, so a
//     check and the write it guarded each existed twice, once per receiver
//     (`get`/`getTx`, `loadTree`/`loadTreeTx`). `node:sqlite` has one
//     synchronous connection and a transaction is `BEGIN`/`COMMIT` on it, so
//     the two collapse into one: a method called inside `#transaction` reads
//     the same tree the write will see, which is what the Tx variants existed
//     for.
//   - Go split the methods over three files in one package. A TypeScript
//     class cannot be split, so `Store` is declared here and the bodies of
//     the listing and schema halves stay in `query.ts` and `schema.ts` as
//     functions over the low-level handle below. The file boundaries, and
//     what is in each, are the Go ones.

import { chmodSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { Normalize } from '@todocloud/core/id';
import {
  type Availability,
  ErrAmbiguous,
  ErrExists,
  ErrNotEmpty,
  ErrNotFound,
  ErrNotInitialized,
  isNotFound,
  type Perspective,
  type Store as StoreContract,
  type Tag,
} from '@todocloud/core/store';
import { checkParent, cycleError } from '@todocloud/core/store/availability';
import { autoComplete, triggersAutoCompletion } from '@todocloud/core/store/completion';
import type { Filter } from '@todocloud/core/store/filter';
import type { Backupper, VersionChecker } from '@todocloud/core/store/version';
import {
  Fields,
  formatTime,
  type JSONValue,
  parseTime,
  type Repeat,
  type ReviewInterval,
  type Status,
  Task,
} from '@todocloud/core/task';

import {
  availability,
  children,
  deletePerspective,
  list,
  loadTree,
  perspective,
  perspectives,
  removeTag,
  renameTag,
  savePerspective,
  setTagStatus,
  subtree,
  tags,
} from './query.ts';
import {
  backupForMigration,
  checkSchema,
  init,
  migrate,
  schemaVersion,
} from './schema.ts';

/**
 * MemoryPath opens a private in-memory database. Tests use it; a user never
 * does, because the tasks would vanish with the process.
 */
export const MemoryPath = ':memory:';

/**
 * fileMode is the mode the database and its journal files are kept at. A task
 * list is private data, and SQLite creates its files with the process umask,
 * which on most machines means world-readable.
 */
export const fileMode = 0o600;

/** The values `node:sqlite` will bind to a placeholder. */
export type Bind = string | number | bigint | null | Uint8Array;

/**
 * Db is the low-level handle: one connection, a path to name it by, and the
 * four statement shapes this provider needs. Go had `*sql.DB` for this.
 *
 * It is exported because `query.ts` and `schema.ts` hold the other two thirds
 * of the provider and a TypeScript module has no package-private visibility.
 * Nothing outside the package should hold one.
 */
export class Db {
  readonly path: string;
  #db: DatabaseSync | undefined;

  constructor(db: DatabaseSync, path: string) {
    this.#db = db;
    this.path = path;
  }

  /** open reports whether the handle is still usable. */
  get open(): boolean {
    return this.#db !== undefined;
  }

  /**
   * handle returns the connection. Go let a call on a closed store panic on a
   * nil pointer; an error that says which store is closed is the same bug
   * reported better.
   */
  handle(): DatabaseSync {
    if (this.#db === undefined) {
      throw new Error(`sqlite: ${this.path}: the store is closed`);
    }
    return this.#db;
  }

  /** exec runs a statement that takes no parameters and returns no rows. */
  exec(sql: string): void {
    this.handle().exec(sql);
  }

  /** run executes a statement and reports how many rows it changed. */
  run(sql: string, ...args: Bind[]): number {
    return Number(this.handle().prepare(sql).run(...args).changes);
  }

  /** one returns the first row, or undefined when there is none. */
  one(sql: string, ...args: Bind[]): Row | undefined {
    const row = this.handle().prepare(sql).get(...args);
    return row === undefined ? undefined : (row as Row);
  }

  /** rows returns every row. */
  rows(sql: string, ...args: Bind[]): Row[] {
    return this.handle().prepare(sql).all(...args) as Row[];
  }

  /** close releases the connection. It is safe to call more than once. */
  close(): void {
    const db = this.#db;
    this.#db = undefined;
    if (db !== undefined) {
      db.close();
    }
  }
}

/** Row is one result row, keyed by column name. */
export type Row = Record<string, string | number | bigint | null | Uint8Array>;

/**
 * open opens the database at path, creating the file and its parent
 * directories when they are missing. Only `tdo init` may create a store;
 * every other command opens one with openExisting.
 *
 * The special path ":memory:" opens a private in-memory database. A leading
 * "~" is not expanded here: the config module resolves the path before
 * calling open, so that this package has no opinion about the filesystem
 * layout.
 */
export function open(path: string): Store {
  if (path !== MemoryPath) {
    const dir = dirname(path);
    if (dir !== '') {
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      } catch (err) {
        throw new Error(`sqlite: create ${dir}`, { cause: err });
      }
    }
  }
  return openDSN(path, path);
}

/**
 * openExisting opens a store that must already exist. It throws an error
 * wrapping ErrNotInitialized when the file is absent, and it never creates a
 * file or a directory: the path is checked first, and the driver is handed a
 * DSN that cannot create one either.
 *
 * A read-only command that creates an empty second task list is worse than a
 * command that fails, because the empty list looks exactly like the real one.
 */
export function openExisting(path: string): Store {
  // An in-memory database never exists before it is opened, so there is
  // nothing for a command other than `tdo init` to find.
  if (path === MemoryPath) {
    throw new Error(`sqlite: ${path}`, { cause: ErrNotInitialized });
  }
  try {
    statSync(path);
  } catch (err) {
    if (isNotExist(err)) {
      throw new Error(`sqlite: ${path}`, { cause: ErrNotInitialized });
    }
    throw new Error(`sqlite: open ${path}`, { cause: err });
  }
  // mode=rw fails rather than creating the file, which keeps the guard above
  // from being the only thing standing between a typo and a stray database.
  // `node:sqlite` passes a `file:` name through as a SQLite URI, so the DSN
  // the Go provider relied on works here unchanged.
  return openDSN(path, `file:${path}?mode=rw`);
}

/**
 * openDSN is the shared body: dsn decides whether the driver may create the
 * file, and path is what the store reports about itself. Go kept it
 * unexported; it is exported here because a module has no package-private
 * visibility and the test that pins the `mode=rw` behaviour needs it.
 */
export function openDSN(path: string, dsn: string): Store {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dsn);
  } catch (err) {
    throw new Error(`sqlite: open ${path}`, { cause: err });
  }

  for (const pragma of [
    'PRAGMA foreign_keys = ON',
    'PRAGMA busy_timeout = 5000',
    'PRAGMA journal_mode = WAL',
  ]) {
    try {
      db.exec(pragma);
    } catch (err) {
      db.close();
      throw new Error(`sqlite: ${pragma}`, { cause: err });
    }
  }

  const st = new Store(new Db(db, path));
  secureFiles(path);
  return st;
}

/**
 * secureFiles tightens the database file and the two files WAL mode creates
 * beside it. It runs on every open because the journal files come and go with
 * the connection, so creating them once at the right mode is not enough.
 *
 * `node:sqlite` has no mode option and neither has SQLite itself: both create
 * their files with the process umask, and `fs.writeFileSync`/`openSync` modes
 * are masked by it too, so there is no way to ask for 0600 up front. The mode
 * is therefore set afterwards with `chmodSync`, which the umask does not
 * touch.
 *
 * A failure is deliberately ignored: the store still works, and refusing to
 * open a task list because its mode could not be changed would be worse than
 * the exposure. The permission test covers the case that matters, which is a
 * file this tool created itself.
 */
export function secureFiles(path: string): void {
  if (path === MemoryPath) {
    return;
  }
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    let perm: number;
    try {
      perm = statSync(file).mode & 0o777;
    } catch {
      continue;
    }
    if (perm === fileMode) {
      continue;
    }
    if ((perm & 0o177) !== 0) {
      try {
        chmodSync(file, fileMode);
      } catch {
        // See the note above: a mode that cannot be changed is not a reason
        // to refuse the store.
      }
    }
  }
}

/** isNotExist is Go's errors.Is(err, os.ErrNotExist). */
function isNotExist(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    err.code === 'ENOENT'
  );
}

/** Store is a SQLite-backed task store. */
export class Store implements StoreContract, VersionChecker, Backupper {
  /**
   * db is the connection. `query.ts` and `schema.ts` read it for the same
   * reason they exist: they are the rest of this class.
   *
   * Go kept this field unexported, which made it reachable from the package's
   * own tests and from nowhere else. TypeScript has no visibility between
   * `private` and public, and two of the three files that make up this
   * provider need it, so it is public — but it is not API. The shipped
   * surface offers no way to run an arbitrary statement, and nothing outside
   * this package and its tests may reach through here to add one.
   */
  readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * describe returns the database path, which is not a credential, and
   * nothing else.
   */
  describe(): string {
    return `sqlite: ${this.db.path}`;
  }

  /** ping checks that the handle works and that the schema is present. */
  async ping(): Promise<void> {
    if (!this.db.open) {
      throw new Error(`sqlite: ping ${this.db.path}: the store is closed`);
    }
    await this.schemaVersion();
  }

  /** close releases the handle. It is safe to call more than once. */
  async close(): Promise<void> {
    try {
      this.db.close();
    } catch (err) {
      throw new Error(`sqlite: close ${this.db.path}`, { cause: err });
    }
  }

  // ---- schema.ts ----------------------------------------------------------

  /** init creates the schema and records the version. It is idempotent. */
  init(): Promise<void> {
    return init(this);
  }

  /**
   * schemaVersion reports the version recorded in the store, or
   * ErrNotInitialized when the meta table or the row is missing.
   */
  schemaVersion(): Promise<number> {
    return schemaVersion(this);
  }

  /**
   * checkSchema reports whether the store holds the schema this build writes.
   */
  checkSchema(): Promise<void> {
    return checkSchema(this);
  }

  /** migrate upgrades the store to the current version. */
  migrate(): Promise<void> {
    return migrate(this);
  }

  /**
   * backupForMigration copies the database beside itself before a migration
   * changes it, and returns the path of the copy.
   */
  backupForMigration(from: number): Promise<string> {
    return backupForMigration(this, from);
  }

  // ---- query.ts -----------------------------------------------------------

  /** list returns the tasks matching f, sorted as f requests. */
  list(f: Filter): Promise<Task[]> {
    return list(this, f);
  }

  /**
   * children returns the direct children of parentID in tree order. An empty
   * parentID returns the top level.
   */
  children(parentID: string): Promise<Task[]> {
    return children(this, parentID);
  }

  /** subtree returns id and everything beneath it, in pre-order. */
  subtree(taskID: string): Promise<Task[]> {
    return subtree(this, taskID);
  }

  /** availability computes §3.3 for each id over the whole tree. */
  availability(now: Date, ...ids: string[]): Promise<Map<string, Availability>> {
    return availability(this, now, ...ids);
  }

  /** tags returns every tag with its status and its count, sorted by name. */
  tags(): Promise<Tag[]> {
    return tags(this);
  }

  /**
   * setTagStatus records a tag's status, creating the row when the tag has
   * none yet.
   */
  setTagStatus(name: string, status: Status, now: Date): Promise<void> {
    return setTagStatus(this, name, status, now);
  }

  /** renameTag moves every task from one tag to another. */
  renameTag(from: string, to: string, now: Date): Promise<void> {
    return renameTag(this, from, to, now);
  }

  /** removeTag takes a tag off every task and forgets its status. */
  removeTag(name: string): Promise<number> {
    return removeTag(this, name);
  }

  /** savePerspective stores a perspective, replacing one of the same name. */
  savePerspective(p: Perspective): Promise<void> {
    return savePerspective(this, p);
  }

  /** perspective returns one by name, or throws ErrNotFound. */
  perspective(name: string): Promise<Perspective> {
    return perspective(this, name);
  }

  /** perspectives returns all of them, sorted by name. */
  perspectives(): Promise<Perspective[]> {
    return perspectives(this);
  }

  /** deletePerspective removes one by name. */
  deletePerspective(name: string): Promise<void> {
    return deletePerspective(this, name);
  }

  // ---- sqlite.ts ----------------------------------------------------------

  /**
   * add inserts a new task with its tags. A duplicate id is an error rather
   * than a silent overwrite, so a generator bug cannot destroy data.
   */
  async add(task: Task): Promise<void> {
    // Every lookup normalises the id, so an id stored in another case would
    // be unreachable afterwards. Normalising on the way in keeps the store's
    // one copy of an id canonical, and the same goes for the edge it carries.
    const t = normalizedCopy(task);
    const invalid = t.validate();
    if (invalid !== undefined) {
      throw new Error(`sqlite: add task ${t.id}`, { cause: invalid });
    }

    this.transaction('add', () => {
      this.checkPlacement(t);
      const args = insertArgs(t);
      const q = `INSERT INTO tasks (${columns}) VALUES (${placeholders})`;
      try {
        this.db.run(q, ...args);
      } catch (err) {
        if (isUniqueViolation(err)) {
          // The caller decides what a duplicate means — `tdo import` skips
          // it — so report it as the sentinel rather than as the driver's
          // constraint message.
          throw new Error(`sqlite: ${t.id}`, { cause: ErrExists });
        }
        throw this.notInitialized(
          new Error(`sqlite: add task ${t.id}`, { cause: err }),
        );
      }
      this.writeTags(t);
    });
  }

  /** update replaces every column of the task with this id, tags included. */
  async update(task: Task): Promise<void> {
    const t = normalizedCopy(task);
    const invalid = t.validate();
    if (invalid !== undefined) {
      throw new Error(`sqlite: update task ${t.id}`, { cause: invalid });
    }

    this.transaction('update', () => {
      this.checkPlacement(t);
      this.writeRow(t, 'update');
      this.writeTags(t);
      this.autoComplete(t);
    });
  }

  /**
   * writeRow runs the UPDATE for one whole task and insists that it found a
   * row. insertArgs puts the id first; the UPDATE wants it last.
   */
  private writeRow(t: Task, op: string): void {
    const args = insertArgs(t);
    let changed: number;
    try {
      changed = this.db.run(updateSQL, ...args.slice(1), args[0] as Bind);
    } catch (err) {
      throw this.notInitialized(
        new Error(`sqlite: ${op} task ${t.id}`, { cause: err }),
      );
    }
    this.affected(changed, t.id);
  }

  /**
   * autoComplete applies "complete with last action" (§3.2's
   * completed_by_children) inside the transaction that closed t. The rule
   * itself is the shared one in core's autoComplete; this provider only reads
   * the tree the update has already produced, asks, and writes the answer, so
   * that its behaviour cannot drift from the other providers'.
   */
  private autoComplete(t: Task): void {
    if (!triggersAutoCompletion(t)) {
      return;
    }
    const tree = loadTree(this);
    for (const container of autoComplete(tree, t.id, t.updatedAt)) {
      const args = insertArgs(container);
      let changed: number;
      try {
        changed = this.db.run(updateSQL, ...args.slice(1), args[0] as Bind);
      } catch (err) {
        throw this.notInitialized(
          new Error(
            `sqlite: complete container ${container.id} with its last child`,
            { cause: err },
          ),
        );
      }
      this.affected(changed, container.id);
    }
  }

  /**
   * move reparents a task and sets its position, touching nothing else but
   * updated_at. It is the one operation that exists so a caller does not have
   * to read, edit and write back a whole task to drag it somewhere.
   */
  async move(
    taskID: string,
    parentID: string,
    position: number,
    now: Date,
  ): Promise<void> {
    const id = Normalize(taskID);
    const parent = Normalize(parentID);

    this.transaction('move', () => {
      const current = this.getRow(id, id);
      current.parentID = parent;
      current.position = position;
      this.checkPlacement(current);

      const q = `UPDATE tasks SET parent_id = ?, position = ?, updated_at = ? WHERE id = ?`;
      let changed: number;
      try {
        changed = this.db.run(
          q,
          nullString(parent),
          intBind(position),
          formatTime(now),
          id,
        );
      } catch (err) {
        throw this.notInitialized(
          new Error(`sqlite: move task ${id}`, { cause: err }),
        );
      }
      this.affected(changed, id);
    });
  }

  /**
   * checkPlacement enforces the tree rules of §3.1 for the placement t
   * describes: the parent must exist, its kind must be allowed to contain
   * this one, and the parent must not be t itself or one of its descendants.
   */
  private checkPlacement(t: Task): void {
    if (t.parentID === '') {
      return;
    }
    if (t.parentID === t.id) {
      throw cycleError(t.id, t.parentID);
    }
    let parent: Task;
    try {
      parent = this.getRow(t.parentID, t.parentID);
    } catch (err) {
      if (isNotFound(err)) {
        throw new Error(`sqlite: parent ${t.parentID}`, { cause: ErrNotFound });
      }
      throw err;
    }
    const bad = checkParent(t.kind, parent);
    if (bad !== undefined) {
      throw new Error('sqlite', { cause: bad });
    }
    // Walking up from the new parent is cheaper than walking down from t,
    // and it terminates on the root. If t is on that path, the move would cut
    // t's branch loose from the tree entirely.
    const seen = new Set<string>([parent.id]);
    for (let node = parent; node.parentID !== ''; ) {
      if (node.parentID === t.id) {
        throw cycleError(t.id, t.parentID);
      }
      if (seen.has(node.parentID)) {
        // A cycle already in the data: refuse rather than loop.
        throw cycleError(node.id, node.parentID);
      }
      seen.add(node.parentID);
      node = this.getRow(node.parentID, node.parentID);
    }
  }

  /** get returns the task with exactly this id, tombstoned or not. */
  async get(taskID: string): Promise<Task> {
    const t = this.getRow(Normalize(taskID), taskID);
    this.attachTags(t);
    return t;
  }

  /**
   * getRow reads one task. `ref` is the spelling the caller used, which is
   * what a not-found message should name. Go had this twice, as `Get` and
   * `getTx`; see the port note at the top of the file.
   */
  getRow(id: string, ref: string): Task {
    const q = `SELECT ${columns} FROM tasks WHERE id = ?`;
    let row: Row | undefined;
    try {
      row = this.db.one(q, id);
    } catch (err) {
      throw this.notInitialized(
        new Error(`sqlite: get task ${ref}`, { cause: err }),
      );
    }
    if (row === undefined) {
      throw new Error(`sqlite: ${ref}`, { cause: ErrNotFound });
    }
    return rowToTask(row);
  }

  /**
   * findByPrefix returns the single task whose id starts with prefix. It
   * reads at most two rows, because two is all it takes to know the prefix is
   * ambiguous.
   */
  async findByPrefix(prefix: string): Promise<Task> {
    const p = Normalize(prefix);
    const q = `SELECT ${columns} FROM tasks WHERE id LIKE ? ESCAPE '\\' ORDER BY id LIMIT 2`;
    let rows: Row[];
    try {
      rows = this.db.rows(q, `${escapeLike(p)}%`);
    } catch (err) {
      throw this.notInitialized(
        new Error(`sqlite: find task ${prefix}`, { cause: err }),
      );
    }
    if (rows.length > 1) {
      throw new Error(`sqlite: ${prefix}`, { cause: ErrAmbiguous });
    }
    const first = rows[0];
    if (first === undefined) {
      throw new Error(`sqlite: ${prefix}`, { cause: ErrNotFound });
    }
    const found = rowToTask(first);
    this.attachTags(found);
    return found;
  }

  /**
   * purge removes a task irreversibly. Ordinary removal is an update that
   * sets the tombstone, so that multi-device sync stays possible.
   *
   * A task that still has children is refused: purging it would orphan them,
   * and an orphan is invisible in every listing that walks the tree.
   */
  async purge(taskID: string): Promise<void> {
    const id = Normalize(taskID);

    this.transaction('purge', () => {
      let count: number;
      try {
        const row = this.db.one(
          `SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ?`,
          id,
        );
        count = Number(row?.['n'] ?? 0);
      } catch (err) {
        throw this.notInitialized(
          new Error(`sqlite: purge task ${taskID}`, { cause: err }),
        );
      }
      if (count > 0) {
        throw new Error(
          `sqlite: ${taskID} still contains ${count} item(s); purge them too with --recursive`,
          { cause: ErrNotEmpty },
        );
      }

      let changed: number;
      try {
        changed = this.db.run(`DELETE FROM tasks WHERE id = ?`, id);
      } catch (err) {
        throw this.notInitialized(
          new Error(`sqlite: purge task ${taskID}`, { cause: err }),
        );
      }
      this.affected(changed, taskID);
    });
  }

  /**
   * purgeSubtree removes a task and everything beneath it irreversibly. It
   * deletes depth-first so that no row is ever removed while a child still
   * points at it, which the foreign key would refuse.
   */
  async purgeSubtree(taskID: string): Promise<number> {
    const id = Normalize(taskID);

    return this.transaction('purge', () => {
      const tree = loadTree(this);
      const nodes = tree.subtree(id);
      if (nodes.length === 0) {
        throw new Error(`sqlite: ${taskID}`, { cause: ErrNotFound });
      }
      for (let i = nodes.length - 1; i >= 0; i--) {
        const node = nodes[i] as Task;
        try {
          this.db.run(`DELETE FROM tasks WHERE id = ?`, node.id);
        } catch (err) {
          throw this.notInitialized(
            new Error(`sqlite: purge task ${node.id}`, { cause: err }),
          );
        }
      }
      return nodes.length;
    });
  }

  /**
   * transaction runs fn between BEGIN and COMMIT, rolling back on a throw.
   * Go's `defer tx.Rollback()` is the `catch` below; a rollback that itself
   * fails is dropped for the same reason Go dropped its error — the original
   * failure is the one worth reporting.
   */
  transaction<T>(op: string, fn: () => T): T {
    try {
      this.db.exec('BEGIN IMMEDIATE');
    } catch (err) {
      throw new Error(`sqlite: begin ${op}`, { cause: err });
    }
    let out: T;
    try {
      out = fn();
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Nothing to do with it: fn's failure is the error to report.
      }
      throw err;
    }
    try {
      this.db.exec('COMMIT');
    } catch (err) {
      throw this.notInitialized(
        new Error(`sqlite: commit ${op}`, { cause: err }),
      );
    }
    return out;
  }

  /**
   * notInitialized rewrites a failure whose real cause is a missing table
   * into one wrapping ErrNotInitialized, so that a store with no schema is
   * reported as a configuration problem with the advice to run `tdo init`
   * instead of leaking the driver's "no such table: tasks". Every method that
   * queries passes its error through here; unrelated errors come back
   * unchanged.
   */
  notInitialized(err: unknown): unknown {
    if (!missingTable(err)) {
      return err;
    }
    return new Error(`sqlite: ${this.db.path}`, { cause: ErrNotInitialized });
  }

  /**
   * affected turns "the UPDATE matched nothing" into ErrNotFound. Go also had
   * to handle a driver that could not report the count; `node:sqlite` always
   * can, so only the zero case is left.
   */
  private affected(changed: number, taskID: string): void {
    if (changed === 0) {
      throw new Error(`sqlite: ${taskID}`, { cause: ErrNotFound });
    }
  }

  /**
   * writeTags replaces the tag rows for a task. Replacing rather than diffing
   * keeps the table a function of the task the caller handed over, which is
   * what makes `tdo edit --tag a,b` subtractive as well as additive.
   */
  private writeTags(t: Task): void {
    try {
      this.db.run(`DELETE FROM task_tags WHERE task_id = ?`, t.id);
    } catch (err) {
      throw new Error(`sqlite: replace tags of ${t.id}`, { cause: err });
    }
    const q = `INSERT INTO task_tags (task_id, tag, tag_key) VALUES (?, ?, ?)
	           ON CONFLICT(task_id, tag_key) DO UPDATE SET tag = excluded.tag`;
    // A tag used for the first time gets a row of its own, active, so that
    // `tdo tag ls` and `tdo tag hold` can reach it. DO NOTHING on conflict:
    // a tag that already has a status must not be reset to active by
    // someone tagging a task with it.
    const row = `INSERT INTO tags (tag_key, tag, status, created_at, updated_at)
	           VALUES (?, ?, 'active', ?, ?) ON CONFLICT(tag_key) DO NOTHING`;
    const stamp = formatTime(t.updatedAt);
    for (const raw of t.tags) {
      const tag = raw.trim();
      if (tag === '') {
        continue;
      }
      const key = tag.toLowerCase();
      try {
        this.db.run(q, t.id, tag, key);
        this.db.run(row, key, tag, stamp, stamp);
      } catch (err) {
        throw new Error(`sqlite: tag ${t.id}`, { cause: err });
      }
    }
  }

  /** attachTags fills in the tags of one task. */
  private attachTags(t: Task): void {
    const q = `SELECT tag FROM task_tags WHERE task_id = ? ORDER BY tag_key`;
    let rows: Row[];
    try {
      rows = this.db.rows(q, t.id);
    } catch (err) {
      throw this.notInitialized(
        new Error(`sqlite: read tags of ${t.id}`, { cause: err }),
      );
    }
    t.setTags(rows.map((r) => String(r['tag'] ?? '')));
  }
}

/**
 * columns is every column of the tasks table, in the order insertArgs and
 * rowToTask agree on.
 */
export const columns = `id, kind, title, parent_id, position, status, flagged, sequential,
	completed_by_children, defer_at, due_at, estimated_minutes, note, repeat, series_id,
	review_interval, last_reviewed_at, created_at, updated_at, completed_at, dropped_at,
	deleted_at, fields`;

const placeholders = `?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?`;

const updateSQL = `UPDATE tasks SET kind = ?, title = ?, parent_id = ?, position = ?, status = ?,
	           flagged = ?, sequential = ?, completed_by_children = ?, defer_at = ?, due_at = ?,
	           estimated_minutes = ?, note = ?, repeat = ?, series_id = ?, review_interval = ?,
	           last_reviewed_at = ?, created_at = ?, updated_at = ?, completed_at = ?,
	           dropped_at = ?, deleted_at = ?, fields = ? WHERE id = ?`;

/**
 * escapeLike neutralises the LIKE wildcards. An id prefix cannot contain
 * them, but the caller is not required to have validated one.
 */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * missingTable reports whether err is the driver's complaint about a table
 * that does not exist. The driver offers no error code for it, so the message
 * is all there is to match on.
 */
export function missingTable(err: unknown): boolean {
  return message(err).toLowerCase().includes('no such table');
}

/**
 * isUniqueViolation reports whether err is SQLite's primary-key conflict. The
 * driver exposes no typed error for it, so the message is matched, in one
 * place, and never passed on to the user.
 */
export function isUniqueViolation(err: unknown): boolean {
  const msg = message(err).toLowerCase();
  return (
    msg.includes('unique constraint failed') ||
    msg.includes('constraint failed: unique')
  );
}

/**
 * message renders an error and everything it wraps as one string. Go's
 * `%w` chains produced a single message that contained the driver's text, and
 * the two matchers above were written against that; here the chain has to be
 * walked to see the same thing.
 */
function message(err: unknown): string {
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

/**
 * normalizedCopy returns a copy of t with its id and parent edge in the
 * canonical spelling, so that a caller passing a lower-cased id neither
 * writes an unreachable row nor has its own value rewritten underneath it.
 */
export function normalizedCopy(t: Task): Task {
  const c = t.clone();
  c.id = Normalize(c.id);
  c.parentID = Normalize(c.parentID);
  c.seriesID = Normalize(c.seriesID);
  return c;
}

/**
 * insertArgs renders one task as the bound parameters of the INSERT, in the
 * order `columns` lists. Every value is bound; nothing is spliced into SQL.
 */
export function insertArgs(t: Task): Bind[] {
  return [
    t.id,
    t.kind,
    t.title,
    nullString(t.parentID),
    intBind(t.position),
    t.status,
    boolToInt(t.flagged),
    boolToInt(t.sequential),
    boolToInt(t.completedByChildren),
    optionalTime(t.deferAt),
    optionalTime(t.dueAt),
    intBind(t.estimatedMinutes),
    nullString(t.note),
    marshalJSON(t.repeat, 'repeat'),
    nullString(t.seriesID),
    marshalJSON(t.reviewInterval, 'review_interval'),
    optionalTime(t.lastReviewedAt),
    formatTime(t.createdAt),
    formatTime(t.updatedAt),
    optionalTime(t.completedAt),
    optionalTime(t.droppedAt),
    optionalTime(t.deletedAt),
    marshalFields(t.fields),
  ];
}

/** rowToTask reads one row of the tasks table back into a Task. */
export function rowToTask(row: Row): Task {
  const t = new Task();
  t.id = text(row['id']) ?? '';
  t.kind = text(row['kind']) ?? '';
  t.title = text(row['title']) ?? '';
  t.parentID = text(row['parent_id']) ?? '';
  t.position = Number(row['position'] ?? 0);
  t.status = text(row['status']) ?? '';
  t.flagged = Number(row['flagged'] ?? 0) !== 0;
  t.sequential = Number(row['sequential'] ?? 0) !== 0;
  t.completedByChildren = Number(row['completed_by_children'] ?? 0) !== 0;
  t.estimatedMinutes = Number(row['estimated_minutes'] ?? 0);
  t.note = text(row['note']) ?? '';
  t.seriesID = text(row['series_id']) ?? '';
  t.createdAt = parseTime(text(row['created_at']) ?? '');
  t.updatedAt = parseTime(text(row['updated_at']) ?? '');
  t.deferAt = parseOptionalTime(row['defer_at']);
  t.dueAt = parseOptionalTime(row['due_at']);
  t.lastReviewedAt = parseOptionalTime(row['last_reviewed_at']);
  t.completedAt = parseOptionalTime(row['completed_at']);
  t.droppedAt = parseOptionalTime(row['dropped_at']);
  t.deletedAt = parseOptionalTime(row['deleted_at']);

  const repeat = text(row['repeat']);
  if (repeat !== undefined && repeat !== '') {
    try {
      t.repeat = JSON.parse(repeat) as Repeat;
    } catch (err) {
      throw new Error(`sqlite: decode repeat of ${t.id}`, { cause: err });
    }
  }
  const review = text(row['review_interval']);
  if (review !== undefined && review !== '') {
    try {
      t.reviewInterval = JSON.parse(review) as ReviewInterval;
    } catch (err) {
      throw new Error(`sqlite: decode review_interval of ${t.id}`, {
        cause: err,
      });
    }
  }
  t.fields = unmarshalFields(text(row['fields']) ?? '');
  t.tags = [];
  return t;
}

/**
 * marshalFields renders the user-defined part of a task. An empty map is
 * stored as an empty object rather than NULL, so the column is never null.
 *
 * Go decoded numbers through json.Number so that Fields.Normalize could give
 * each one the Go type the rest of the CLI stores. JavaScript has one number
 * type, so a number written here comes back identical and the round trip
 * `tdo export | tdo import` is lossless for fields this binary knows nothing
 * about without any of that machinery; see the note on Fields.normalize in
 * core.
 */
export function marshalFields(f: Fields): string {
  if (Object.keys(f).length === 0) {
    return '{}';
  }
  const out = JSON.stringify(f);
  if (out === undefined) {
    throw new Error('sqlite: encode fields: the value is not JSON');
  }
  return out;
}

/** marshalJSON renders a small optional object column, NULL when unset. */
function marshalJSON(
  v: Repeat | ReviewInterval | undefined,
  name: string,
): string | null {
  if (v === undefined) {
    return null;
  }
  const out = JSON.stringify(v);
  if (out === undefined) {
    throw new Error(`sqlite: encode ${name}: the value is not JSON`);
  }
  return out;
}

/** unmarshalFields reads the fields column back. The result is never null. */
export function unmarshalFields(raw: string): Fields {
  if (raw.trim() === '') {
    return {};
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (err) {
    throw new Error('sqlite: decode fields', { cause: err });
  }
  if (
    typeof decoded !== 'object' ||
    decoded === null ||
    Array.isArray(decoded)
  ) {
    throw new Error('sqlite: decode fields: the column is not a JSON object');
  }
  const f = decoded as Record<string, JSONValue>;
  Fields.normalize(f);
  return f;
}

function boolToInt(b: boolean): bigint {
  return b ? 1n : 0n;
}

/**
 * intBind renders a whole number as the INTEGER it is.
 *
 * `node:sqlite` binds every JavaScript number as a SQLite REAL, since that is
 * what a number is. In an INTEGER column the affinity converts it back, but a
 * column with TEXT affinity stores the REAL's spelling — so the version
 * marker Go wrote as `2` would be stored as `2.0`, and every reader that
 * expects an integer there is then reading a lie. Binding a BigInt makes the
 * value an INTEGER, which is what Go's `int` was.
 *
 * A value that is not whole is passed through: it is not an integer, and
 * silently truncating one would be worse than storing it as it is.
 */
export function intBind(n: number): bigint | number {
  return Number.isInteger(n) ? BigInt(n) : n;
}

/** nullString stores the empty string as NULL, as the Go provider did. */
export function nullString(s: string): string | null {
  return s === '' ? null : s;
}

function optionalTime(t: Date | undefined): string | null {
  return t === undefined ? null : formatTime(t);
}

function parseOptionalTime(
  v: string | number | bigint | null | Uint8Array | undefined,
): Date | undefined {
  const s = text(v);
  if (s === undefined || s === '') {
    return undefined;
  }
  return parseTime(s);
}

/**
 * text reads a column as the string it is, or undefined for NULL. Go's
 * sql.NullString, in the one direction this package reads.
 */
export function text(
  v: string | number | bigint | null | Uint8Array | undefined,
): string | undefined {
  if (v === null || v === undefined) {
    return undefined;
  }
  if (typeof v === 'string') {
    return v;
  }
  if (v instanceof Uint8Array) {
    return Buffer.from(v).toString('utf8');
  }
  return String(v);
}
