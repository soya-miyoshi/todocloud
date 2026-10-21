// The listing half of the provider: filters, the tree, tags and
// perspectives. Go kept these in `query.go` on the same type; see the port
// note at the top of `sqlite.ts` for why they are functions over the store
// here.

import { Normalize } from '@todocloud/core/id';
import {
  type Availability,
  ErrNotFound,
  mergeTags,
  type Perspective,
  sortTasks,
  type Tag,
  type TagRow,
  type TagUse,
  tagKey,
  validTagStatus,
} from '@todocloud/core/store';
import { Tree } from '@todocloud/core/store/availability';
import { Filter, filterFromJSON } from '@todocloud/core/store/filter';
import {
  formatTime,
  isZeroTime,
  parseTime,
  type Status,
  StatusActive,
  Task,
} from '@todocloud/core/task';

import {
  type Bind,
  columns,
  type Row,
  rowToTask,
  type Store,
  text,
} from './sqlite.ts';

/**
 * list returns the tasks matching f, sorted as f requests.
 *
 * The query narrows the rows — the tag filter in particular is a join and not
 * a scan, which is the whole reason tags are their own table — and the shared
 * matcher in core then decides. Deciding twice costs one pass over a handful
 * of rows and buys the guarantee the conformance suite is about: whatever
 * this provider pushes down, the answer is the one the definition gives.
 */
export async function list(s: Store, f: Filter): Promise<Task[]> {
  const invalid = f.validate();
  if (invalid !== undefined) {
    throw new Error('sqlite: list tasks', { cause: invalid });
  }
  const { where, args } = pushDown(f);
  const candidates = query(s, where, args);

  // Availability, a subtree scope and tree order are questions about the
  // whole tree, and the ancestors of a matching row need not match
  // themselves, so they cannot be answered from the rows selected above.
  let tree: Tree | undefined;
  if (f.needsTree()) {
    tree = loadTree(s);
  }

  const out: Task[] = [];
  for (const t of candidates) {
    if (f.matches(t, tree)) {
      out.push(t);
    }
  }
  const pathOf =
    tree === undefined ? undefined : (t: Task) => (tree as Tree).sortKey(t);
  sortTasks(out, f.order, pathOf);
  if (f.limit > 0 && out.length > f.limit) {
    out.length = f.limit;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The push-down allow-list.
//
// Everything a user types reaches SQLite as a bound parameter, and the SQL
// text itself is assembled only from the fragments below. The column and
// operator set is therefore closed: `pushDown` cannot name a column a caller
// chose, because there is no path from caller text to SQL text at all.
//
// `predicate` enforces that mechanically rather than by review. Every clause
// has to be one of the shapes in `clauseShapes`, and its placeholder count
// has to equal the number of values bound with it — which is what catches the
// mistake that matters, a value spliced into a clause instead of bound beside
// it. A clause that fails either check throws rather than reaching the
// engine, so a future edit that interpolates a value fails the first test
// that runs it rather than shipping an injection.
// ---------------------------------------------------------------------------

/** inList renders an IN list of n placeholders. The values are always bound. */
function inList(n: number): string {
  return `IN (${Array.from({ length: n }, () => '?').join(',')})`;
}

/**
 * clauseShapes is every clause `pushDown` is allowed to produce. The three
 * patterns are the IN families, whose placeholder count varies with the
 * number of values; everything else is a literal.
 */
const clauseShapes: readonly RegExp[] = [
  /^deleted_at IS (?:NOT )?NULL$/,
  /^kind IN \(\?(?:,\?)*\)$/,
  /^status IN \(\?(?:,\?)*\)$/,
  /^flagged = \?$/,
  /^kind = 'task' AND parent_id IS NULL$/,
  /^parent_id IS NULL$/,
  /^parent_id = \?$/,
  /^due_at IS (?:NOT )?NULL$/,
  /^defer_at IS NOT NULL AND defer_at [<>] \?$/,
  /^due_at IS NOT NULL AND due_at [<>] \?$/,
  /^\(SELECT COUNT\(DISTINCT tag_key\) FROM task_tags WHERE task_id = tasks\.id AND tag_key IN \(\?(?:,\?)*\)\) (?:> 0|= \d+)$/,
];

/** Clauses collects the WHERE fragments and the values bound to them. */
class Clauses {
  readonly where: string[] = [];
  readonly args: Bind[] = [];

  /** add appends one clause of the allow-list, with its bound values. */
  add(clause: string, ...args: Bind[]): void {
    if (!clauseShapes.some((shape) => shape.test(clause))) {
      throw new Error(
        `store-sqlite: ${JSON.stringify(clause)} is not one of the push-down clauses; a filter may not name a column or an operator of its own`,
      );
    }
    const placeholders = clause.split('?').length - 1;
    if (placeholders !== args.length) {
      throw new Error(
        `store-sqlite: ${JSON.stringify(clause)} has ${placeholders} placeholder(s) and ${args.length} value(s); every value must be bound`,
      );
    }
    this.where.push(clause);
    this.args.push(...args);
  }
}

/**
 * pushDown builds the WHERE clause for the parts of a filter that are a
 * property of the row alone. Everything it leaves out is decided by
 * Filter.matches afterwards, so an omission here is a slow query and never a
 * wrong one.
 */
export function pushDown(f: Filter): { where: string[]; args: Bind[] } {
  const c = new Clauses();
  if (f.onlyDeleted) {
    c.add(`deleted_at IS NOT NULL`);
  } else if (!f.includeDeleted) {
    c.add(`deleted_at IS NULL`);
  }
  if (f.kinds.length > 0) {
    c.add(`kind ${inList(f.kinds.length)}`, ...f.kinds);
  }
  if (f.statuses.length > 0) {
    c.add(`status ${inList(f.statuses.length)}`, ...f.statuses);
  }
  if (f.flagged !== undefined) {
    c.add(`flagged = ?`, f.flagged ? 1n : 0n);
  }
  if (f.scope.inbox) {
    c.add(`kind = 'task' AND parent_id IS NULL`);
  }
  if (f.scope.children) {
    if (f.scope.parentID === '') {
      c.add(`parent_id IS NULL`);
    } else {
      c.add(`parent_id = ?`, Normalize(f.scope.parentID));
    }
  }
  if (f.hasDue !== undefined) {
    c.add(f.hasDue ? `due_at IS NOT NULL` : `due_at IS NULL`);
  }
  // Timestamps are stored in the fixed-width RFC 3339 form, so comparing
  // them as text is chronological.
  for (const [at, clause] of [
    [f.deferBefore, `defer_at IS NOT NULL AND defer_at < ?`],
    [f.deferAfter, `defer_at IS NOT NULL AND defer_at > ?`],
    [f.dueBefore, `due_at IS NOT NULL AND due_at < ?`],
    [f.dueAfter, `due_at IS NOT NULL AND due_at > ?`],
  ] as [Date | undefined, string][]) {
    if (at !== undefined) {
      c.add(clause, formatTime(at));
    }
  }
  if (f.tags.length > 0) {
    const keys: string[] = [];
    for (const raw of f.tags) {
      const tag = raw.trim();
      if (tag === '') {
        continue;
      }
      keys.push(tag.toLowerCase());
    }
    if (keys.length > 0) {
      const sub = `(SELECT COUNT(DISTINCT tag_key) FROM task_tags WHERE task_id = tasks.id AND tag_key ${inList(keys.length)})`;
      // The count is the number of keys, an integer this function computed;
      // the keys themselves are bound.
      c.add(f.tagsAny ? `${sub} > 0` : `${sub} = ${keys.length}`, ...keys);
    }
  }
  return { where: c.where, args: c.args };
}

/** query runs a tasks SELECT and attaches the tags of every row it returns. */
function query(s: Store, where: string[], args: Bind[]): Task[] {
  let q = `SELECT ${columns} FROM tasks`;
  if (where.length > 0) {
    q += ` WHERE (${where.join(`) AND (`)})`;
  }
  q += ` ORDER BY id`;

  let rows: Row[];
  try {
    rows = s.db.rows(q, ...args);
  } catch (err) {
    throw s.notInitialized(new Error('sqlite: list tasks', { cause: err }));
  }
  let out: Task[];
  try {
    out = rows.map(rowToTask);
  } catch (err) {
    throw new Error('sqlite: list tasks', { cause: err });
  }
  attachAllTags(s, out);
  return out;
}

const allTagsSQL = `SELECT task_id, tag FROM task_tags ORDER BY task_id, tag_key`;

/**
 * attachAllTags fills in the tags of a whole listing with one query, rather
 * than one per row.
 */
function attachAllTags(s: Store, tasks: Task[]): void {
  if (tasks.length === 0) {
    return;
  }
  let rows: Row[];
  try {
    rows = s.db.rows(allTagsSQL);
  } catch (err) {
    throw s.notInitialized(new Error('sqlite: read tags', { cause: err }));
  }
  const byTask = new Map<string, string[]>();
  for (const row of rows) {
    const taskID = text(row['task_id']) ?? '';
    const tag = text(row['tag']) ?? '';
    const have = byTask.get(taskID);
    if (have === undefined) {
      byTask.set(taskID, [tag]);
    } else {
      have.push(tag);
    }
  }
  for (const t of tasks) {
    t.setTags(byTask.get(t.id) ?? []);
  }
}

/**
 * loadTree reads every row into an in-memory tree, with the tags each task
 * carries and the status of each tag: the two tag rules of §3.3 need both.
 * That is two queries beyond the rows themselves, on every listing that asks
 * about availability — the cost of a tag that can hold its tasks back.
 *
 * It is synchronous because the writes in `sqlite.ts` call it from inside a
 * transaction, where there is nothing to await.
 */
export function loadTree(s: Store): Tree {
  let rows: Row[];
  try {
    rows = s.db.rows(`SELECT ${columns} FROM tasks`);
  } catch (err) {
    throw s.notInitialized(new Error('sqlite: read tree', { cause: err }));
  }
  let nodes: Task[];
  try {
    nodes = rows.map(rowToTask);
  } catch (err) {
    throw new Error('sqlite: read tree', { cause: err });
  }
  const tree = new Tree(nodes);
  attachAllTags(s, nodes);
  tree.setTagStatuses(tagRows(s));
  return tree;
}

const tagRowsSQL = `SELECT tag_key, tag, status, COALESCE(note, '') AS note FROM tags ORDER BY tag_key`;

/** tagRows reads the tag table as the tree and `tags` both want it. */
function tagRows(s: Store): Tag[] {
  let rows: Row[];
  try {
    rows = s.db.rows(tagRowsSQL);
  } catch (err) {
    throw s.notInitialized(new Error('sqlite: read tags', { cause: err }));
  }
  return rows.map((row) => ({
    name: text(row['tag']) ?? '',
    status: (text(row['status']) ?? '') as Status,
    // The count belongs to the task table, not to this one; `tags` fills it
    // in through mergeTags.
    count: 0,
    note: text(row['note']) ?? '',
  }));
}

/**
 * children returns the direct children of parentID in tree order. An empty
 * parentID returns the top level.
 */
export async function children(s: Store, parentID: string): Promise<Task[]> {
  return list(
    s,
    new Filter({
      scope: { children: true, parentID: Normalize(parentID) },
      includeDeleted: true,
    }),
  );
}

/** subtree returns id and everything beneath it, in pre-order. */
export async function subtree(s: Store, taskID: string): Promise<Task[]> {
  const tree = loadTree(s);
  const nodes = tree.subtree(Normalize(taskID));
  if (nodes.length === 0) {
    throw new Error(`sqlite: ${taskID}`, { cause: ErrNotFound });
  }
  attachAllTags(s, nodes);
  return nodes;
}

/** availability computes §3.3 for each id over the whole tree. */
export async function availability(
  s: Store,
  now: Date,
  ...ids: string[]
): Promise<Map<string, Availability>> {
  if (ids.length === 0) {
    return new Map();
  }
  const tree = loadTree(s);
  const at = isZeroTime(now) ? new Date() : now;
  return tree.availabilityOf(at, ...ids.map((raw) => Normalize(raw)));
}

/**
 * tags returns every tag with its status and its count, sorted by name.
 * Tombstoned tasks are left out of the count: a tag whose only task is in the
 * bin is not a tag the user still files things under. A tag with a row of its
 * own is still listed at count zero, because a context put on hold must not
 * vanish when its last task is finished.
 */
export async function tags(s: Store): Promise<Tag[]> {
  const q = `SELECT tt.tag_key AS tag_key, MIN(tt.tag) AS tag, COUNT(*) AS uses FROM task_tags tt
	           JOIN tasks t ON t.id = tt.task_id
	           WHERE t.deleted_at IS NULL
	           GROUP BY tt.tag_key ORDER BY tt.tag_key`;
  let rows: Row[];
  try {
    rows = s.db.rows(q);
  } catch (err) {
    throw s.notInitialized(new Error('sqlite: list tags', { cause: err }));
  }
  const uses: TagUse[] = rows.map((row) => ({
    key: text(row['tag_key']) ?? '',
    name: text(row['tag']) ?? '',
    count: Number(row['uses'] ?? 0),
  }));
  const stored: TagRow[] = tagRows(s).map((tag) => ({
    key: tagKey(tag.name),
    name: tag.name,
    status: tag.status,
    note: tag.note ?? '',
  }));
  return mergeTags(uses, stored);
}

/**
 * setTagStatus records a tag's status, creating the row when the tag has none
 * yet. The tag need not be in use: putting a context on hold before filing
 * anything under it is ordinary.
 */
export async function setTagStatus(
  s: Store,
  name: string,
  status: Status,
  now: Date,
): Promise<void> {
  const key = tagKey(name);
  if (key === '') {
    throw new Error('sqlite: set tag status: a tag must have a name');
  }
  if (!validTagStatus(status)) {
    throw new Error(
      `sqlite: set tag status: ${JSON.stringify(status)} is not a tag status`,
    );
  }
  const stamp = formatTime(now);
  const q = `INSERT INTO tags (tag_key, tag, status, created_at, updated_at)
	           VALUES (?, ?, ?, ?, ?)
	           ON CONFLICT(tag_key) DO UPDATE SET status = excluded.status,
	                                              updated_at = excluded.updated_at`;
  try {
    s.db.run(q, key, name.trim(), status, stamp, stamp);
  } catch (err) {
    throw s.notInitialized(
      new Error(`sqlite: set the status of tag ${JSON.stringify(name)}`, {
        cause: err,
      }),
    );
  }
}

/**
 * renameTag moves every task from one tag to another and takes the status
 * with it when the destination has none of its own.
 */
export async function renameTag(
  s: Store,
  from: string,
  to: string,
  now: Date,
): Promise<void> {
  const fromKey = tagKey(from);
  const toKey = tagKey(to);
  if (fromKey === '' || toKey === '') {
    throw new Error(
      'sqlite: rename tag: both the old and the new name must be given',
    );
  }
  const spelling = to.trim();
  const stamp = formatTime(now);

  s.transaction('rename tag', () => {
    const { known, status } = tagStatus(s, fromKey);
    if (!known) {
      throw new Error(`sqlite: tag ${JSON.stringify(from)}`, {
        cause: ErrNotFound,
      });
    }
    const fail = (err: unknown): Error =>
      new Error(`sqlite: rename tag ${JSON.stringify(from)}`, { cause: err });

    if (fromKey === toKey) {
      // Only the spelling changes. Both tables keep a copy of it, so both
      // are rewritten.
      try {
        s.db.run(
          `UPDATE tags SET tag = ?, updated_at = ? WHERE tag_key = ?`,
          spelling,
          stamp,
          toKey,
        );
        s.db.run(
          `UPDATE task_tags SET tag = ? WHERE tag_key = ?`,
          spelling,
          toKey,
        );
      } catch (err) {
        throw fail(err);
      }
      return;
    }

    try {
      // A task that already carries the destination tag must not end up with
      // two rows for it, so the collisions go first.
      s.db.run(
        `DELETE FROM task_tags WHERE tag_key = ?
	           AND task_id IN (SELECT task_id FROM task_tags WHERE tag_key = ?)`,
        fromKey,
        toKey,
      );
      s.db.run(
        `UPDATE task_tags SET tag = ?, tag_key = ? WHERE tag_key = ?`,
        spelling,
        toKey,
        fromKey,
      );
      // The destination keeps its own status when it has one: renaming into a
      // context that is on hold must not quietly wake it up.
      s.db.run(
        `INSERT INTO tags (tag_key, tag, status, created_at, updated_at)
	           VALUES (?, ?, ?, ?, ?)
	           ON CONFLICT(tag_key) DO UPDATE SET tag = excluded.tag, updated_at = excluded.updated_at`,
        toKey,
        spelling,
        status,
        stamp,
        stamp,
      );
      s.db.run(`DELETE FROM tags WHERE tag_key = ?`, fromKey);
    } catch (err) {
      throw fail(err);
    }
  });
}

/**
 * removeTag takes a tag off every task and forgets its status, returning how
 * many tasks were changed.
 */
export async function removeTag(s: Store, name: string): Promise<number> {
  const key = tagKey(name);
  if (key === '') {
    throw new Error('sqlite: remove tag: a tag must have a name');
  }
  return s.transaction('remove tag', () => {
    const { known } = tagStatus(s, key);
    if (!known) {
      throw new Error(`sqlite: tag ${JSON.stringify(name)}`, {
        cause: ErrNotFound,
      });
    }
    try {
      const changed = s.db.run(
        `DELETE FROM task_tags WHERE tag_key = ?`,
        key,
      );
      s.db.run(`DELETE FROM tags WHERE tag_key = ?`, key);
      return changed;
    } catch (err) {
      throw new Error(`sqlite: remove tag ${JSON.stringify(name)}`, {
        cause: err,
      });
    }
  });
}

/**
 * tagStatus reports whether a tag is known — carried by a task or holding a
 * row of its own — and the status it holds, defaulting to active.
 */
function tagStatus(
  s: Store,
  key: string,
): { known: boolean; status: Status } {
  let row: Row | undefined;
  try {
    row = s.db.one(`SELECT status FROM tags WHERE tag_key = ?`, key);
  } catch (err) {
    throw new Error(
      `sqlite: read the status of tag ${JSON.stringify(key)}`,
      { cause: err },
    );
  }
  if (row !== undefined) {
    let status = (text(row['status']) ?? '') as Status;
    if (!validTagStatus(status)) {
      status = StatusActive;
    }
    return { known: true, status };
  }
  let used: number;
  try {
    const count = s.db.one(
      `SELECT COUNT(*) AS n FROM task_tags WHERE tag_key = ?`,
      key,
    );
    used = Number(count?.['n'] ?? 0);
  } catch (err) {
    throw new Error(`sqlite: read tag ${JSON.stringify(key)}`, { cause: err });
  }
  return { known: used > 0, status: StatusActive };
}

/** savePerspective stores a perspective, replacing one of the same name. */
export async function savePerspective(
  s: Store,
  p: Perspective,
): Promise<void> {
  const name = p.name.trim();
  if (name === '') {
    throw new Error('sqlite: a perspective needs a name');
  }
  const invalid = p.filter.validate();
  if (invalid !== undefined) {
    throw new Error(`sqlite: save perspective ${name}`, { cause: invalid });
  }
  const filter = JSON.stringify(p.filter);
  if (filter === undefined) {
    throw new Error(`sqlite: encode perspective ${name}: it is not JSON`);
  }
  const created = isZeroTime(p.createdAt) ? p.updatedAt : p.createdAt;
  const q = `INSERT INTO perspectives (name_key, name, filter, created_at, updated_at)
	           VALUES (?, ?, ?, ?, ?)
	           ON CONFLICT(name_key) DO UPDATE SET
	             name = excluded.name, filter = excluded.filter, updated_at = excluded.updated_at`;
  try {
    s.db.run(
      q,
      name.toLowerCase(),
      name,
      filter,
      formatTime(created),
      formatTime(p.updatedAt),
    );
  } catch (err) {
    throw s.notInitialized(
      new Error(`sqlite: save perspective ${name}`, { cause: err }),
    );
  }
}

const perspectiveColumns = `SELECT name, filter, created_at, updated_at FROM perspectives`;

/** perspective returns one by name, or throws ErrNotFound. */
export async function perspective(
  s: Store,
  name: string,
): Promise<Perspective> {
  let row: Row | undefined;
  try {
    row = s.db.one(
      `${perspectiveColumns} WHERE name_key = ?`,
      name.trim().toLowerCase(),
    );
  } catch (err) {
    throw s.notInitialized(
      new Error(`sqlite: read perspective ${name}`, { cause: err }),
    );
  }
  if (row === undefined) {
    throw new Error(`sqlite: perspective ${name}`, { cause: ErrNotFound });
  }
  return rowToPerspective(row);
}

/** perspectives returns all of them, sorted by name. */
export async function perspectives(s: Store): Promise<Perspective[]> {
  let rows: Row[];
  try {
    rows = s.db.rows(`${perspectiveColumns} ORDER BY name_key`);
  } catch (err) {
    throw s.notInitialized(
      new Error('sqlite: list perspectives', { cause: err }),
    );
  }
  try {
    return rows.map(rowToPerspective);
  } catch (err) {
    throw new Error('sqlite: list perspectives', { cause: err });
  }
}

/**
 * deletePerspective removes one by name. A perspective is a query, so there
 * is no tombstone to keep.
 */
export async function deletePerspective(
  s: Store,
  name: string,
): Promise<void> {
  let changed: number;
  try {
    changed = s.db.run(
      `DELETE FROM perspectives WHERE name_key = ?`,
      name.trim().toLowerCase(),
    );
  } catch (err) {
    throw s.notInitialized(
      new Error(`sqlite: delete perspective ${name}`, { cause: err }),
    );
  }
  if (changed === 0) {
    throw new Error(`sqlite: perspective ${name}`, { cause: ErrNotFound });
  }
}

function rowToPerspective(row: Row): Perspective {
  const name = text(row['name']) ?? '';
  const raw = text(row['filter']) ?? '';
  let filter: Filter;
  try {
    filter = filterFromJSON(JSON.parse(raw));
  } catch (err) {
    throw new Error(`sqlite: decode perspective ${name}`, { cause: err });
  }
  return {
    name,
    filter,
    createdAt: parseTime(text(row['created_at']) ?? ''),
    updatedAt: parseTime(text(row['updated_at']) ?? ''),
  };
}
