// This file is the archive: for every version ever released, the statements
// a build of that version created a store with.
//
// Each entry is a frozen, literal copy, never a reference to the live DDL in
// schema.ts. That is the whole value of it. The conformance harness builds a
// store from each historical entry, runs the ladder over it, and compares
// the result with a store that init created today. If someone changes the
// live DDL without appending a Step, the two stop matching and the harness
// says so — which is the drift that otherwise shows up a year later as a
// column that exists on new installs and not on old ones.
//
// So: when Version is bumped, copy the previous version's DDL into this
// file verbatim before editing the live DDL, and append the Step.

import { Version } from './schema.ts';

/**
 * historicalV1 is the schema of version 1, the first released schema.
 * Frozen on the day version 1 shipped. Do not edit it, ever.
 */
const historicalV1: readonly string[] = [
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
  `CREATE TABLE IF NOT EXISTS task_tags (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tag     TEXT NOT NULL,
  tag_key TEXT NOT NULL,
  PRIMARY KEY (task_id, tag_key)
)`,
  `CREATE INDEX IF NOT EXISTS task_tags_key_idx ON task_tags(tag_key)`,
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
 * historicalV2 is the schema of version 2, which promoted tags to rows that
 * carry a status. Frozen on the day version 2 shipped. Do not edit it, ever.
 */
const historicalV2: readonly string[] = [
  ...historicalV1,
  `CREATE TABLE IF NOT EXISTS tags (
  tag_key    TEXT PRIMARY KEY NOT NULL,
  tag        TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active',
  note       TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS tags_status_idx ON tags(status)`,
];

/**
 * historicalV3 is the schema of version 3, which added events and the links
 * from the tasks that wait for them. Frozen on the day version 3 shipped. Do
 * not edit it, ever.
 */
const historicalV3: readonly string[] = [
  ...historicalV2,
  `CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY NOT NULL,
  title       TEXT NOT NULL,
  project_id  TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  note        TEXT,
  expected_at TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',
  occurred_at TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS events_status_idx ON events(status)`,
  `CREATE INDEX IF NOT EXISTS events_project_idx ON events(project_id)`,
  `CREATE TABLE IF NOT EXISTS task_events (
  task_id  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, event_id)
)`,
  `CREATE INDEX IF NOT EXISTS task_events_event_idx ON task_events(event_id)`,
];

/** historicalDDL maps a released version to the schema it created. */
const historicalDDL: ReadonlyMap<number, readonly string[]> = new Map([
  [1, historicalV1],
  [2, historicalV2],
  [3, historicalV3],
]);

/**
 * historical returns the DDL that created a store at version v, or undefined
 * when that version was never released. Go returned `([]string, bool)`; the
 * two are one value here, as elsewhere in the port.
 */
export function historical(v: number): string[] | undefined {
  const stmts = historicalDDL.get(v);
  if (stmts === undefined) {
    return undefined;
  }
  return [...stmts];
}

/**
 * historicalVersions returns every released version up to and including
 * Version, in ascending order. It is what the conformance harness iterates.
 *
 * The current version is included on purpose. Migrating a store that is
 * already current is a no-op, so the run reduces to comparing the frozen DDL
 * of this version with what init writes today — which is the check that
 * catches the live DDL being edited in place instead of through a Step, and
 * is the only check there is to make while the ladder is still empty.
 */
export function historicalVersions(): number[] {
  const out: number[] = [];
  for (let v = 1; v <= Version; v++) {
    if (historicalDDL.has(v)) {
      out.push(v);
    }
  }
  return out;
}
