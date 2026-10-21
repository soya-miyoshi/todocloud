// Module schema is the one place the stored schema is written down.
//
// Both shipped providers speak the SQLite dialect, so the DDL, the version
// number and the migration ladder belong to neither of them. They live here
// and each provider executes them through its own transport: the sqlite
// provider inside a transaction, the turso provider as pipelines of
// statements over HTTP. A step added here reaches both providers at once,
// which is the point — a ladder duplicated per provider is a ladder that can
// be added to one and forgotten in the other, and the store that forgets is
// the one in somebody's cloud account that cannot be rolled back.
//
// Nothing here imports a provider, a transport or the exit codes, so the
// module is a pure description: statements, a version, and the order they
// go in. In Go this was a package of its own, `internal/store/schema`; here
// it is a file in the same directory, because the import rule it enforced is
// enforced by having no imports at all.
//
// Port note: Go's `steps` was a package-level variable and its test swapped
// in a ladder of its own to check `validate`. A module binding cannot be
// reassigned from a test, so `validate` and `pending` take the ladder as an
// optional argument defaulting to the shipped one. Nothing but the test
// passes it.

/**
 * Version is the schema version this build writes and expects. A store
 * recorded below it is upgraded by migrate; one above it belongs to a newer
 * binary and is refused rather than guessed at.
 *
 * Bumping it without appending the matching Step throws when this module is
 * first loaded, which any test in the tree will catch.
 */
export const Version = 2;

/**
 * MetaKey is the key the version lives under in the meta table. Every
 * provider uses the same name, so `tdo migrate` reads the same thing
 * everywhere and `tdo export | tdo import` moves between two stores that
 * agree on what version means.
 */
export const MetaKey = 'schema_version';

/**
 * SetVersionSQL records the version, inserting or updating in one statement
 * so that neither init nor migrate needs a read first. Its arguments are
 * MetaKey and the version, in that order.
 */
export const SetVersionSQL = `INSERT INTO meta (key, value) VALUES (?, ?)
	           ON CONFLICT(key) DO UPDATE SET value = excluded.value`;

/**
 * initialDDL is the schema a fresh store is created with: the current schema,
 * in full. It is deliberately not assembled from the ladder below — a fresh
 * store should not have to replay a decade of history — and that is exactly
 * why the conformance suite replays the history, to prove that doing so lands
 * on this.
 *
 * One statement per element, because the libSQL pipeline protocol executes
 * one statement per request and will not take a script.
 *
 * The required fields of PLAN.md §3.2 are columns, tags are a real join
 * table because `tdo ls --tag home` must be a join and not a scan, and every
 * user-defined value lives in the fields JSON object, which is what lets a
 * user add an attribute of their own without a migration.
 *
 * Nothing is deleted by default, so the parent foreign key is RESTRICT
 * rather than CASCADE: a purge that would orphan a subtree is refused in
 * TypeScript, and the constraint is the second line of defence if it ever is
 * not. A remote connection may well have foreign keys switched off, so no
 * provider relies on the constraint or on a cascade.
 */
const initialDDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS tasks (
  id                    TEXT PRIMARY KEY NOT NULL,
  kind                  TEXT NOT NULL,
  title                 TEXT NOT NULL,
  parent_id             TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
  position              INTEGER NOT NULL DEFAULT 0,
  status                TEXT NOT NULL DEFAULT 'active',
  flagged               INTEGER NOT NULL DEFAULT 0,
  sequential            INTEGER NOT NULL DEFAULT 0,
  completed_by_children INTEGER NOT NULL DEFAULT 0,
  defer_at              TEXT,
  due_at                TEXT,
  estimated_minutes     INTEGER NOT NULL DEFAULT 0,
  note                  TEXT,
  repeat                TEXT,
  series_id             TEXT,
  review_interval       TEXT,
  last_reviewed_at      TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  completed_at          TEXT,
  dropped_at            TEXT,
  deleted_at            TEXT,
  fields                TEXT NOT NULL DEFAULT '{}'
)`,
  `CREATE INDEX IF NOT EXISTS tasks_parent_idx ON tasks(parent_id, position, id)`,
  `CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status, deleted_at)`,
  `CREATE INDEX IF NOT EXISTS tasks_updated_idx ON tasks(updated_at)`,
  `CREATE INDEX IF NOT EXISTS tasks_due_idx ON tasks(due_at)`,
  `CREATE INDEX IF NOT EXISTS tasks_series_idx ON tasks(series_id)`,
  // tag_key is the tag folded to lower case. Tags are compared
  // case-insensitively everywhere, so it is the key of the pair; tag keeps
  // the spelling the user typed, which is what gets printed back.
  `CREATE TABLE IF NOT EXISTS task_tags (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tag     TEXT NOT NULL,
  tag_key TEXT NOT NULL,
  PRIMARY KEY (task_id, tag_key)
)`,
  `CREATE INDEX IF NOT EXISTS task_tags_key_idx ON task_tags(tag_key)`,
  // A tag is a row of its own, not just a string in task_tags, because it
  // carries a status: a tag on hold or dropped holds back everything
  // filed under it (§3.3). tag_key is the join key and matches
  // task_tags.tag_key; tag keeps the spelling the user typed. A tag used
  // by a task with no row here is active, so a store that lost this table
  // still lists and filters tags.
  `CREATE TABLE IF NOT EXISTS tags (
  tag_key    TEXT PRIMARY KEY NOT NULL,
  tag        TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active',
  note       TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS tags_status_idx ON tags(status)`,
  // A perspective is a saved query: a name and the filter, as JSON. It
  // stores no results and pins no ids, so it cannot go stale.
  `CREATE TABLE IF NOT EXISTS perspectives (
  name_key   TEXT PRIMARY KEY NOT NULL,
  name       TEXT NOT NULL,
  filter     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
)`,
];

/**
 * initial returns the statements that create a store at Version, in order.
 * The array is a copy, so a provider may not edit the schema by accident.
 */
export function initial(): string[] {
  return [...initialDDL];
}

/**
 * Step is one rung of the upgrade ladder: the statements that move a store
 * from to-1 to to, in order.
 *
 * Two rules hold for every step, and both exist because the turso provider
 * has no transaction to hide behind:
 *
 *   - A step must be idempotent. The version is recorded after the step, in
 *     a separate round trip, so a migration interrupted between the two
 *     leaves a store whose statements have run but whose version has not
 *     moved. The next `tdo migrate` runs the step again and must succeed.
 *     In practice that means CREATE ... IF NOT EXISTS, UPDATE ... WHERE the
 *     row still needs it, and a backfill written so that running it twice
 *     changes nothing the second time. SQLite has no ALTER TABLE ADD COLUMN
 *     IF NOT EXISTS, so a step that adds a column rebuilds the table, with
 *     the new table created under a temporary name, IF NOT EXISTS.
 *   - A step is forward-only. There is no down. A mistake is corrected by a
 *     further step, because the user's data has already moved.
 *
 * One case deserves its own note, because getting it wrong locks a user out
 * of their own tasks: **promoting a user-defined field to a column.** Until
 * it is promoted, `energy` lives in the open fields JSON and a user may
 * already have set it with `--set energy=high`. The moment it becomes a
 * required field its name is reserved, and from then on Task.toJSON skips
 * the stored copy while Task.validate refuses the task outright — so the
 * value disappears from output and the row can never be written again. A
 * step that adds such a column must therefore also move the data out of the
 * JSON, in the same step, idempotently:
 *
 * ```sql
 * UPDATE tasks SET energy = json_extract(fields, '$.energy'),
 *                  fields = json_remove(fields, '$.energy')
 *  WHERE json_extract(fields, '$.energy') IS NOT NULL;
 * ```
 *
 * Running that twice is a no-op, because the WHERE clause stops matching
 * once the key is gone.
 */
export interface Step {
  /**
   * to is the version this step produces. Steps are contiguous and the last
   * one produces Version.
   */
  to: number;
  /** name is what `tdo migrate` prints and what an error names. */
  name: string;
  /**
   * statements run in order. Each one must succeed before the version is
   * recorded.
   */
  statements: string[];
}

/**
 * ladder is the ladder. Version 1 is the initial schema and has no step: a
 * store at 0 has no schema at all and is created by init rather than
 * migrated. New versions append here, and only here.
 */
const ladder: readonly Step[] = [
  {
    to: 2,
    name: 'promote tags to rows that carry a status',
    statements: [
      `CREATE TABLE IF NOT EXISTS tags (
  tag_key    TEXT PRIMARY KEY NOT NULL,
  tag        TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active',
  note       TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
      `CREATE INDEX IF NOT EXISTS tags_status_idx ON tags(status)`,
      // Every tag already in use becomes an active row. OR IGNORE
      // rather than a plain INSERT, and a timestamp from the engine
      // rather than from the client, so that running the step twice
      // changes nothing the second time.
      `INSERT OR IGNORE INTO tags (tag_key, tag, status, created_at, updated_at)
	           SELECT tag_key, MIN(tag), 'active',
	                  strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
	                  strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
	             FROM task_tags GROUP BY tag_key`,
    ],
  },
];

/** steps returns the whole ladder, in order. */
export function steps(): Step[] {
  return [...ladder];
}

/**
 * pending returns the steps a store at version `from` still owes, in order. A
 * store already at Version owes none.
 *
 * `over` is the ladder to read, and exists only for the test that pins what
 * pending means independently of the shipped ladder.
 */
export function pending(from: number, over: readonly Step[] = ladder): Step[] {
  const out: Step[] = [];
  for (const s of over) {
    if (s.to > from) {
      out.push(s);
    }
  }
  return out;
}

/**
 * validate refuses a ladder that cannot be right. It is the mechanism behind
 * "a step cannot be added to one provider and forgotten in the other": there
 * is one ladder, and a Version that does not match it stops the process
 * before any store is touched. Go panicked from `init`; the module throws
 * below instead, which has the same effect at the same moment.
 *
 * It returns the error rather than throwing, because it answers a question —
 * and because the test asks it about ladders that are wrong on purpose.
 */
export function validate(over: readonly Step[] = ladder): Error | undefined {
  let want = 2; // version 1 is the initial schema, so the ladder starts at 2
  for (const s of over) {
    if (s.to !== want) {
      return new Error(
        `the ladder jumps to version ${s.to} where ${want} was expected; steps must be contiguous and in order`,
      );
    }
    if (s.name === '') {
      return new Error(`the step to version ${s.to} has no name`);
    }
    if (s.statements.length === 0) {
      return new Error(`the step to version ${s.to} has no statements`);
    }
    want++;
  }
  const reached = want - 1;
  if (reached !== Version) {
    return new Error(
      `the ladder reaches version ${reached} but Version is ${Version}; bumping the version means appending the step that gets there`,
    );
  }
  return undefined;
}

const ladderError = validate();
if (ladderError !== undefined) {
  throw new Error(`store/schema: ${ladderError.message}`);
}
