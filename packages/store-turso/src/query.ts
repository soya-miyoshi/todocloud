// Reading: listings, the tree, tags and perspectives.
//
// Go had these as methods on Store in the same package; see the note at the
// top of schema.ts on why they are functions over a Store here.

import * as id from '@todocloud/core/id';
import {
  ErrNotFound,
  mergeTags,
  sortTasks,
  tagKey,
  validTagStatus,
  type Availability,
  type Perspective,
  type Tag,
  type TagRow,
  type TagUse,
} from '@todocloud/core/store';
import { Tree } from '@todocloud/core/store/availability';
import { Filter, filterFromJSON } from '@todocloud/core/store/filter';
import {
  StatusActive,
  Task,
  formatTime,
  parseTime,
  type Status,
} from '@todocloud/core/task';

import { eventRowsSQL, linkRowsSQL, scanEvents, scanLinks } from './events.ts';
import type { Arg, ExecuteResult, Value } from './protocol.ts';
import {
  Batch,
  attachTags,
  columns,
  integer,
  messageOf,
  scanTask,
  text,
  type Store,
} from './turso.ts';

/**
 * list returns the tasks matching f, sorted as f requests.
 *
 * It is the sqlite provider's shape, over the wire: the query narrows the
 * rows — the tag filter in particular is a join and not a scan, which is the
 * whole reason tags are their own table — and the shared matcher in core then
 * decides. Deciding twice costs one pass over a handful of rows and buys the
 * guarantee the conformance suite is about: whatever this provider pushes
 * down, the answer is the one the definition gives.
 *
 * The candidate rows, their tags and, when the filter needs it, the whole
 * tree are three statements in one pipeline, so a listing is one round trip
 * however much of the tree it has to consider.
 */
export async function list(s: Store, f: Filter): Promise<Task[]> {
  const invalid = f.validate();
  if (invalid !== undefined) {
    throw new Error(`turso: list tasks: ${invalid.message}`, { cause: invalid });
  }
  const { where, args } = pushDown(f);

  let q = `SELECT ${columns} FROM tasks`;
  if (where.length > 0) {
    q += ` WHERE (` + where.join(`) AND (`) + `)`;
  }
  q += ` ORDER BY id`;

  const b = new Batch();
  b.add(q, true, ...args);
  const tagsAt = b.len();
  b.add(allTagsSQL, true);
  let treeAt = -1;
  if (f.needsTree()) {
    // Availability, a subtree scope and tree order are questions about
    // the whole tree, and the ancestors of a matching row need not match
    // themselves, so they cannot be answered from the rows selected
    // above.
    treeAt = b.len();
    b.add(`SELECT ${columns} FROM tasks`, true);
    // The rules that read more than the rows: what each tag's status is and
    // which events exist. The tags themselves are the pipeline's second
    // result, which covers every task and not only the candidates.
    b.add(tagRowsSQL, true);
    b.add(eventRowsSQL, true);
    b.add(linkRowsSQL, true);
  }

  let res: ExecuteResult[];
  try {
    res = await s.send(b);
  } catch (err) {
    throw s.wrap(err, 'list tasks');
  }
  let candidates: Task[];
  let tree: Tree | undefined;
  try {
    candidates = scanTasks(res[0] as ExecuteResult);
    attachTags(candidates, res[tagsAt] as ExecuteResult);
    if (treeAt >= 0) {
      const built = treeWithNodes(res[treeAt] as ExecuteResult);
      tree = built.tree;
      attachTags(built.nodes, res[tagsAt] as ExecuteResult);
      tree.setTagStatuses(scanTagRows(res[treeAt + 1] as ExecuteResult));
      tree.setEvents(
        scanEvents(res[treeAt + 2] as ExecuteResult),
        scanLinks(res[treeAt + 3] as ExecuteResult),
      );
    }
  } catch (err) {
    throw new Error(`turso: list tasks: ${messageOf(err)}`, { cause: err });
  }

  const out: Task[] = [];
  for (const t of candidates) {
    if (f.matches(t, tree)) {
      out.push(t);
    }
  }
  const pathOf = tree === undefined ? undefined : (t: Task) => tree.sortKey(t);
  sortTasks(out, f.order, pathOf);
  // The limit is applied last, on the listing the filter would have
  // returned, so that `--limit 2` is the first two of it and not two of
  // whatever the server happened to send.
  if (f.limit > 0 && out.length > f.limit) {
    return out.slice(0, f.limit);
  }
  return out;
}

/**
 * pushDown builds the WHERE clause for the parts of a filter that are a
 * property of the row alone. Everything it leaves out is decided by
 * Filter.matches afterwards, so an omission here is a slow query and never a
 * wrong one.
 *
 * Nothing a user types reaches the SQL text. Every value is bound as a typed
 * protocol argument, and the only parts of the clause that vary are the ones
 * chosen from the closed set written out below.
 */
export function pushDown(f: Filter): { where: string[]; args: Arg[] } {
  const where: string[] = [];
  const args: Arg[] = [];
  if (f.onlyDeleted) {
    where.push(`deleted_at IS NOT NULL`);
  } else if (!f.includeDeleted) {
    where.push(`deleted_at IS NULL`);
  }
  if (f.kinds.length > 0) {
    const clause = inClause(f.kinds.length);
    for (const k of f.kinds) {
      args.push(k as string);
    }
    where.push(`kind ` + clause);
  }
  if (f.statuses.length > 0) {
    const clause = inClause(f.statuses.length);
    for (const st of f.statuses) {
      args.push(st as string);
    }
    where.push(`status ` + clause);
  }
  if (f.flagged !== undefined) {
    where.push(`flagged = ?`);
    args.push(f.flagged ? 1 : 0);
  }
  if (f.scope.inbox) {
    where.push(`kind = 'task' AND parent_id IS NULL`);
  }
  if (f.scope.children) {
    if (f.scope.parentID === '') {
      where.push(`parent_id IS NULL`);
    } else {
      where.push(`parent_id = ?`);
      args.push(id.Normalize(f.scope.parentID));
    }
  }
  if (f.hasDue !== undefined) {
    where.push(f.hasDue ? `due_at IS NOT NULL` : `due_at IS NULL`);
  }
  // Timestamps are stored in the fixed-width RFC 3339 form, so comparing
  // them as text is chronological.
  for (const w of [
    { at: f.deferBefore, clause: `defer_at IS NOT NULL AND defer_at < ?` },
    { at: f.deferAfter, clause: `defer_at IS NOT NULL AND defer_at > ?` },
    { at: f.dueBefore, clause: `due_at IS NOT NULL AND due_at < ?` },
    { at: f.dueAfter, clause: `due_at IS NOT NULL AND due_at > ?` },
  ]) {
    if (w.at !== undefined) {
      where.push(w.clause);
      args.push(formatTime(w.at));
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
      const clause = inClause(keys.length);
      const sub =
        `SELECT COUNT(DISTINCT tag_key) FROM task_tags WHERE task_id = tasks.id AND tag_key ` +
        clause;
      if (f.tagsAny) {
        where.push(`(` + sub + `) > 0`);
      } else {
        // The count is the number of placeholders this clause just wrote, not
        // anything a user typed: it is produced here and never read back in.
        where.push(`(` + sub + `) = ` + String(keys.length));
      }
      args.push(...keys);
    }
  }
  return { where, args };
}

/**
 * inClause renders an IN list of n placeholders. The values are always
 * bound as typed protocol arguments, never interpolated: nothing a user types
 * reaches the SQL text.
 */
export function inClause(n: number): string {
  return 'IN (' + new Array(n).fill('?').join(',') + ')';
}

/** scanTasks decodes a whole result of task rows. */
export function scanTasks(res: ExecuteResult): Task[] {
  const out: Task[] = [];
  for (const row of res.rows) {
    out.push(scanTask(row));
  }
  return out;
}

/**
 * treeFrom indexes a result of task rows. Tags are left off: no rule in §3.1
 * or §3.3 depends on them, and this is read on every listing that asks about
 * availability.
 */
export function treeFrom(res: ExecuteResult): Tree {
  return treeWithNodes(res).tree;
}

/**
 * treeWithNodes returns the tree and the rows it was built from, so a caller
 * that has to fill the tags in does not have to walk the tree to find them.
 */
export function treeWithNodes(res: ExecuteResult): {
  tree: Tree;
  nodes: Task[];
} {
  const all = scanTasks(res);
  return { tree: new Tree(all), nodes: all };
}

/**
 * loadTree reads every row into an in-memory tree. It is the read half of
 * every write: with no transaction to hold, the placement rules are decided
 * against this snapshot before a single statement goes up.
 */
export async function loadTree(s: Store): Promise<Tree> {
  // The rows, the tags each task carries and the status of each tag, in
  // one pipeline: the two tag rules of §3.3 need all three, and a tree
  // read in three round trips would be three snapshots.
  const b = new Batch();
  b.add(`SELECT ${columns} FROM tasks`, true);
  b.add(allTagsSQL, true);
  b.add(tagRowsSQL, true);
  b.add(eventRowsSQL, true);
  b.add(linkRowsSQL, true);
  let res: ExecuteResult[];
  try {
    res = await s.send(b);
  } catch (err) {
    throw s.wrap(err, 'read the tree');
  }
  let tree: Tree;
  try {
    const built = treeWithNodes(res[0] as ExecuteResult);
    tree = built.tree;
    attachTags(built.nodes, res[1] as ExecuteResult);
  } catch (err) {
    throw new Error(`turso: read the tree: ${messageOf(err)}`, { cause: err });
  }
  tree.setTagStatuses(scanTagRows(res[2] as ExecuteResult));
  try {
    tree.setEvents(
      scanEvents(res[3] as ExecuteResult),
      scanLinks(res[4] as ExecuteResult),
    );
  } catch (err) {
    throw new Error(`turso: read the tree: ${messageOf(err)}`, { cause: err });
  }
  return tree;
}

/** allTagsSQL and tagRowsSQL are the two tag reads every tree needs. */
export const allTagsSQL = `SELECT task_id, tag FROM task_tags ORDER BY task_id, tag_key`;
export const tagRowsSQL = `SELECT tag_key, tag, status, COALESCE(note, '') FROM tags ORDER BY tag_key`;

/** scanTagRows reads the tag table out of a result. */
export function scanTagRows(res: ExecuteResult): Tag[] {
  const out: Tag[] = [];
  for (const row of res.rows) {
    if (row.length !== 4) {
      throw new Error(
        `turso: read tags: a row came back with ${row.length} column(s), want 4`,
      );
    }
    try {
      out.push({
        name: text(row[1] as Value, 'tag'),
        status: text(row[2] as Value, 'status') as Status,
        note: text(row[3] as Value, 'note'),
        // A tag read for the tree carries no count: the rules of §3.3 ask
        // only about its status.
        count: 0,
      });
    } catch (err) {
      throw new Error(`turso: read tags: ${messageOf(err)}`, { cause: err });
    }
  }
  return out;
}

/**
 * children returns the direct children of parentID in tree order,
 * tombstoned ones included. An empty parentID returns the top level.
 */
export function children(s: Store, parentID: string): Promise<Task[]> {
  return list(
    s,
    new Filter({
      scope: { children: true, parentID: id.Normalize(parentID) },
      includeDeleted: true,
    }),
  );
}

/**
 * subtree returns id and everything beneath it, in pre-order. The rows and
 * their tags travel in one pipeline.
 */
export async function subtree(s: Store, taskID: string): Promise<Task[]> {
  const normalized = id.Normalize(taskID);

  const b = new Batch();
  b.add(`SELECT ${columns} FROM tasks`, true);
  b.add(allTagsSQL, true);
  let res: ExecuteResult[];
  try {
    res = await s.send(b);
  } catch (err) {
    throw s.wrap(err, 'read subtree ' + taskID);
  }
  let tree: Tree;
  try {
    tree = treeFrom(res[0] as ExecuteResult);
  } catch (err) {
    throw new Error(`turso: read subtree ${taskID}: ${messageOf(err)}`, {
      cause: err,
    });
  }
  const nodes = tree.subtree(normalized);
  if (nodes.length === 0) {
    throw new Error(`turso: ${taskID}: ${ErrNotFound.message}`, {
      cause: ErrNotFound,
    });
  }
  try {
    attachTags(nodes, res[1] as ExecuteResult);
  } catch (err) {
    throw new Error(`turso: read subtree ${taskID}: ${messageOf(err)}`, {
      cause: err,
    });
  }
  return nodes;
}

/**
 * availability computes §3.3 for each id over the whole tree. The rules are
 * the shared ones: this provider reads the rows and asks, so that its answer
 * cannot drift from the definition.
 */
export async function availability(
  s: Store,
  now: Date,
  ...ids: string[]
): Promise<Map<string, Availability>> {
  if (ids.length === 0) {
    return new Map();
  }
  const tree = await loadTree(s);
  let at = now;
  if (at === undefined || Number.isNaN(at.getTime())) {
    at = new Date();
  }
  const normalized = ids.map((raw) => id.Normalize(raw));
  return tree.availabilityOf(at, ...normalized);
}

/**
 * tags returns every tag in use on a live task with its count, sorted by
 * name. Tombstoned tasks are left out: a tag whose only task is in the bin is
 * not a tag the user still files things under.
 */
export async function tags(s: Store): Promise<Tag[]> {
  const q = `SELECT tt.tag_key, MIN(tt.tag), COUNT(*) FROM task_tags tt
	           JOIN tasks t ON t.id = tt.task_id
	           WHERE t.deleted_at IS NULL
	           GROUP BY tt.tag_key ORDER BY tt.tag_key`;
  const b = new Batch();
  b.add(q, true);
  b.add(tagRowsSQL, true);
  let res: ExecuteResult[];
  try {
    res = await s.send(b);
  } catch (err) {
    throw s.wrap(err, 'list tags');
  }
  const uses: TagUse[] = [];
  for (const row of (res[0] as ExecuteResult).rows) {
    if (row.length !== 3) {
      throw new Error(
        `turso: list tags: a row came back with ${row.length} column(s), want 3`,
      );
    }
    try {
      uses.push({
        key: text(row[0] as Value, 'tag_key'),
        name: text(row[1] as Value, 'tag'),
        count: Number(integer(row[2] as Value, 'count')),
      });
    } catch (err) {
      throw new Error(`turso: list tags: ${messageOf(err)}`, { cause: err });
    }
  }
  const stored = scanTagRows(res[1] as ExecuteResult);
  const rows: TagRow[] = stored.map((tag) => ({
    key: tagKey(tag.name),
    name: tag.name,
    status: tag.status,
    note: tag.note ?? '',
  }));
  return mergeTags(uses, rows);
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
    throw new Error('turso: set tag status: a tag must have a name');
  }
  if (!validTagStatus(status)) {
    throw new Error(
      `turso: set tag status: ${JSON.stringify(status)} is not a tag status`,
    );
  }
  const stamp = formatTime(now);
  const q = `INSERT INTO tags (tag_key, tag, status, created_at, updated_at)
	           VALUES (?, ?, ?, ?, ?)
	           ON CONFLICT(tag_key) DO UPDATE SET status = excluded.status,
	                                              updated_at = excluded.updated_at`;
  try {
    await s.exec(q, false, key, name.trim(), status as string, stamp, stamp);
  } catch (err) {
    throw s.wrap(err, 'set the status of tag ' + name);
  }
}

/**
 * renameTag moves every task from one tag to another and takes the status
 * with it when the destination has none of its own. There is no transaction
 * over the wire, so the tag is read first and the whole rewrite travels as
 * one pipeline.
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
      'turso: rename tag: both the old and the new name must be given',
    );
  }
  const { known, status } = await tagStatus(s, fromKey);
  if (!known) {
    throw new Error(
      `turso: tag ${JSON.stringify(from)}: ${ErrNotFound.message}`,
      { cause: ErrNotFound },
    );
  }
  const spelling = to.trim();
  const stamp = formatTime(now);

  const b = new Batch();
  if (fromKey === toKey) {
    // Only the spelling changes. Both tables keep a copy of it, so both
    // are rewritten.
    b.add(
      `UPDATE tags SET tag = ?, updated_at = ? WHERE tag_key = ?`,
      false,
      spelling,
      stamp,
      toKey,
    );
    b.add(
      `UPDATE task_tags SET tag = ? WHERE tag_key = ?`,
      false,
      spelling,
      toKey,
    );
  } else {
    // A task that already carries the destination tag must not end up
    // with two rows for it, so the collisions go first.
    b.add(
      `DELETE FROM task_tags WHERE tag_key = ?
	           AND task_id IN (SELECT task_id FROM task_tags WHERE tag_key = ?)`,
      false,
      fromKey,
      toKey,
    );
    b.add(
      `UPDATE task_tags SET tag = ?, tag_key = ? WHERE tag_key = ?`,
      false,
      spelling,
      toKey,
      fromKey,
    );
    // The destination keeps its own status when it has one: renaming
    // into a context that is on hold must not quietly wake it up.
    b.add(
      `INSERT INTO tags (tag_key, tag, status, created_at, updated_at)
	           VALUES (?, ?, ?, ?, ?)
	           ON CONFLICT(tag_key) DO UPDATE SET tag = excluded.tag, updated_at = excluded.updated_at`,
      false,
      toKey,
      spelling,
      status as string,
      stamp,
      stamp,
    );
    b.add(`DELETE FROM tags WHERE tag_key = ?`, false, fromKey);
  }
  try {
    await s.send(b);
  } catch (err) {
    throw s.wrap(err, 'rename tag ' + from);
  }
}

/**
 * removeTag takes a tag off every task and forgets its status, returning how
 * many tasks were changed.
 */
export async function removeTag(s: Store, name: string): Promise<number> {
  const key = tagKey(name);
  if (key === '') {
    throw new Error('turso: remove tag: a tag must have a name');
  }
  const { known } = await tagStatus(s, key);
  if (!known) {
    throw new Error(
      `turso: tag ${JSON.stringify(name)}: ${ErrNotFound.message}`,
      { cause: ErrNotFound },
    );
  }
  const b = new Batch();
  b.add(`DELETE FROM task_tags WHERE tag_key = ?`, false, key);
  b.add(`DELETE FROM tags WHERE tag_key = ?`, false, key);
  let res: ExecuteResult[];
  try {
    res = await s.send(b);
  } catch (err) {
    throw s.wrap(err, 'remove tag ' + name);
  }
  return (res[0] as ExecuteResult).affectedRowCount;
}

/**
 * tagStatus reports whether a tag is known — carried by a task or holding a
 * row of its own — and the status it holds, defaulting to active.
 */
async function tagStatus(
  s: Store,
  key: string,
): Promise<{ known: boolean; status: Status }> {
  const b = new Batch();
  b.add(`SELECT status FROM tags WHERE tag_key = ?`, true, key);
  b.add(`SELECT COUNT(*) FROM task_tags WHERE tag_key = ?`, true, key);
  let res: ExecuteResult[];
  try {
    res = await s.send(b);
  } catch (err) {
    throw s.wrap(err, 'read tag ' + key);
  }
  const statusRows = (res[0] as ExecuteResult).rows;
  const first = statusRows[0];
  if (first !== undefined) {
    if (first.length !== 1) {
      throw new Error(
        `turso: read tag ${JSON.stringify(key)}: a row came back with ${first.length} column(s), want 1`,
      );
    }
    let raw: string;
    try {
      raw = text(first[0] as Value, 'status');
    } catch (err) {
      throw new Error(
        `turso: read tag ${JSON.stringify(key)}: ${messageOf(err)}`,
        { cause: err },
      );
    }
    let status = raw as Status;
    if (!validTagStatus(status)) {
      status = StatusActive;
    }
    return { known: true, status };
  }
  const countRow = (res[1] as ExecuteResult).rows[0];
  if (countRow === undefined || countRow.length !== 1) {
    throw new Error(
      `turso: read tag ${JSON.stringify(key)}: the count came back empty`,
    );
  }
  let used: bigint;
  try {
    used = integer(countRow[0] as Value, 'count');
  } catch (err) {
    throw new Error(
      `turso: read tag ${JSON.stringify(key)}: ${messageOf(err)}`,
      { cause: err },
    );
  }
  return { known: used > 0n, status: StatusActive };
}

/**
 * savePerspective stores a perspective, replacing one of the same name.
 * Names are compared case-insensitively, since they are typed.
 */
export async function savePerspective(
  s: Store,
  p: Perspective,
): Promise<void> {
  const name = p.name.trim();
  if (name === '') {
    throw new Error('turso: a perspective needs a name');
  }
  const invalid = p.filter.validate();
  if (invalid !== undefined) {
    throw new Error(`turso: save perspective ${name}: ${invalid.message}`, {
      cause: invalid,
    });
  }
  const filter = JSON.stringify(p.filter);
  let created = p.createdAt;
  if (Number.isNaN(created.getTime())) {
    created = p.updatedAt;
  }
  const q = `INSERT INTO perspectives (name_key, name, filter, created_at, updated_at)
	           VALUES (?, ?, ?, ?, ?)
	           ON CONFLICT(name_key) DO UPDATE SET
	             name = excluded.name, filter = excluded.filter, updated_at = excluded.updated_at`;
  try {
    await s.exec(
      q,
      false,
      name.toLowerCase(),
      name,
      filter,
      formatTime(created),
      formatTime(p.updatedAt),
    );
  } catch (err) {
    throw s.wrap(err, 'save perspective ' + name);
  }
}

/** perspective returns one by name, or throws ErrNotFound. */
export async function perspective(
  s: Store,
  name: string,
): Promise<Perspective> {
  const q = `SELECT name, filter, created_at, updated_at FROM perspectives WHERE name_key = ?`;
  let res: ExecuteResult;
  try {
    res = await s.exec(q, true, name.trim().toLowerCase());
  } catch (err) {
    throw s.wrap(err, 'read perspective ' + name);
  }
  const row = res.rows[0];
  if (row === undefined) {
    throw new Error(
      `turso: perspective ${name}: ${ErrNotFound.message}`,
      { cause: ErrNotFound },
    );
  }
  try {
    return scanPerspective(row);
  } catch (err) {
    throw new Error(`turso: read perspective ${name}: ${messageOf(err)}`, {
      cause: err,
    });
  }
}

/** perspectives returns all of them, sorted by name. */
export async function perspectives(s: Store): Promise<Perspective[]> {
  const q = `SELECT name, filter, created_at, updated_at FROM perspectives ORDER BY name_key`;
  let res: ExecuteResult;
  try {
    res = await s.exec(q, true);
  } catch (err) {
    throw s.wrap(err, 'list perspectives');
  }
  const out: Perspective[] = [];
  for (const row of res.rows) {
    try {
      out.push(scanPerspective(row));
    } catch (err) {
      throw new Error(`turso: list perspectives: ${messageOf(err)}`, {
        cause: err,
      });
    }
  }
  return out;
}

/**
 * deletePerspective removes one by name, or throws ErrNotFound. A perspective
 * is a query, so there is no tombstone to keep.
 */
export async function deletePerspective(
  s: Store,
  name: string,
): Promise<void> {
  let res: ExecuteResult;
  try {
    res = await s.exec(
      `DELETE FROM perspectives WHERE name_key = ?`,
      false,
      name.trim().toLowerCase(),
    );
  } catch (err) {
    throw s.wrap(err, 'delete perspective ' + name);
  }
  if (res.affectedRowCount === 0) {
    throw new Error(
      `turso: perspective ${name}: ${ErrNotFound.message}`,
      { cause: ErrNotFound },
    );
  }
}

function scanPerspective(row: Value[]): Perspective {
  if (row.length !== 4) {
    throw new Error(`a row came back with ${row.length} column(s), want 4`);
  }
  const name = text(row[0] as Value, 'name');
  const filter = text(row[1] as Value, 'filter');
  let parsed: Filter;
  try {
    parsed = filterFromJSON(JSON.parse(filter) as unknown);
  } catch (err) {
    throw new Error(`decode perspective ${name}: ${messageOf(err)}`, {
      cause: err,
    });
  }
  return {
    name,
    filter: parsed,
    createdAt: parseTime(text(row[2] as Value, 'created_at')),
    updatedAt: parseTime(text(row[3] as Value, 'updated_at')),
  };
}
