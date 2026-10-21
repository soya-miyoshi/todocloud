// Comparing a live schema against the one init writes today, and saying what
// differs in a way a provider author can act on.

import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';

import type { Store } from '@todocloud/core';

import type { SQL } from './migrate.ts';

/**
 * SchemaSnapshot is everything about a schema that two stores have to agree
 * on: which tables exist, and for each of them its columns with their types
 * and defaults, its indexes, its foreign keys and its CHECK constraints —
 * plus any views and triggers.
 *
 * It is read from the engine's catalogue rather than from the DDL text,
 * because the text legitimately differs. A table that init created with a
 * column and a table a migration added that column to store different CREATE
 * TABLE statements and the same schema; comparing the text would report a
 * difference that is not one, and a harness that cries wolf is a harness that
 * gets skipped.
 */
export interface SchemaSnapshot {
  tables: Map<string, TableSnapshot>;
  /**
   * objects holds views and triggers by name, as normalized SQL. These are
   * only ever created, never altered, so their text is stable.
   */
  objects: Map<string, string>;
}

export interface TableSnapshot {
  /**
   * columns, indexes, fks and checks are each a sorted list of one-line
   * renderings, so that a difference prints as a readable pair of lines.
   */
  columns: string[];
  indexes: string[];
  fks: string[];
  checks: string[];
}

/** cell reads one column of a row, which is absent only on a mangled query. */
function cell(row: readonly string[], i: number): string {
  return row[i] ?? '';
}

/** snapshotSchema reads the engine's catalogue. Go had it as `Ladder.snapshot`. */
export async function snapshotSchema(
  t: TestContext,
  sql: SQL,
  s: Store,
): Promise<SchemaSnapshot> {
  const snap: SchemaSnapshot = {
    tables: new Map(),
    objects: new Map(),
  };

  const rows = await sql.query(
    t,
    s,
    `SELECT type, name, sql FROM sqlite_schema
		WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY type, name`,
  );
  const tables: string[] = [];
  for (const row of rows) {
    const kind = cell(row, 0);
    const name = cell(row, 1);
    const ddl = cell(row, 2);
    switch (kind) {
      case 'table':
        tables.push(name);
        snap.tables.set(name, {
          columns: [],
          indexes: [],
          fks: [],
          checks: checksIn(ddl),
        });
        break;
      case 'view':
      case 'trigger':
        snap.objects.set(`${kind} ${name}`, normalizeSQL(ddl));
        break;
      default:
        // Indexes are read per table below, so that an index is reported
        // against the table it belongs to.
        break;
    }
  }

  for (const name of tables) {
    const tbl = snap.tables.get(name) as TableSnapshot;
    for (const c of await sql.query(
      t,
      s,
      `PRAGMA table_info(${quoteIdent(name)})`,
    )) {
      // c is cid, name, type, notnull, dflt_value, pk. cid is left out on
      // purpose: SQLite's ALTER TABLE ADD COLUMN appends, so a column a
      // migration added sits at a different position than the same column in
      // a fresh CREATE TABLE. That is a difference in layout, not in schema,
      // and no code here depends on ordinal position — every statement names
      // its columns.
      tbl.columns.push(
        `${cell(c, 1)} type=${cell(c, 2)} notnull=${cell(c, 3)} default=${cell(c, 4)} pk=${cell(c, 5)}`,
      );
    }
    for (const fk of await sql.query(
      t,
      s,
      `PRAGMA foreign_key_list(${quoteIdent(name)})`,
    )) {
      // fk is id, seq, table, from, to, on_update, on_delete, match.
      tbl.fks.push(
        `${cell(fk, 3)} -> ${cell(fk, 2)}(${cell(fk, 4)}) on_update=${cell(fk, 5)} on_delete=${cell(fk, 6)} match=${cell(fk, 7)}`,
      );
    }
    for (const idx of await sql.query(
      t,
      s,
      `PRAGMA index_list(${quoteIdent(name)})`,
    )) {
      // idx is seq, name, unique, origin, partial. The name is used only for
      // an index the DDL names: SQLite invents the name of the index behind a
      // UNIQUE or PRIMARY KEY clause, and that invented name depends on the
      // order the constraints were written in rather than on what the schema
      // means.
      const idxName = cell(idx, 1);
      const unique = cell(idx, 2);
      const origin = cell(idx, 3);
      const partial = cell(idx, 4);
      const cols: string[] = [];
      for (const col of await sql.query(
        t,
        s,
        `PRAGMA index_info(${quoteIdent(idxName)})`,
      )) {
        cols.push(cell(col, 2));
      }
      const label = origin === 'c' ? idxName : '(implicit)';
      tbl.indexes.push(
        `${label} on (${cols.join(', ')}) unique=${unique} origin=${origin} partial=${partial}`,
      );
    }
    tbl.columns.sort();
    tbl.indexes.sort();
    tbl.fks.sort();
  }
  return snap;
}

/**
 * diffSchemas fails with the first difference it finds, naming the rule rather
 * than only the values.
 */
export function diffSchemas(
  _t: TestContext,
  rule: string,
  want: SchemaSnapshot,
  got: SchemaSnapshot,
): void {
  const diff = compareSnapshots(want, got);
  if (diff !== '') {
    assert.fail(`${rule}\n  ${diff}`);
  }
}

/**
 * compareSnapshots describes the first difference between two schemas, or
 * returns "" when they are the same schema. It is separate from the assertion
 * so that the harness's own test can check that it finds a difference without
 * failing the test that is checking it.
 */
export function compareSnapshots(
  want: SchemaSnapshot,
  got: SchemaSnapshot,
): string {
  const wantTables = names(want.tables);
  const gotTables = names(got.tables);
  let diff = diffLists(wantTables, gotTables);
  if (diff !== '') {
    return `the tables differ: ${diff}`;
  }
  const empty: TableSnapshot = {
    columns: [],
    indexes: [],
    fks: [],
    checks: [],
  };
  for (const name of wantTables) {
    const w = want.tables.get(name) ?? empty;
    const g = got.tables.get(name) ?? empty;
    const parts: Array<{
      what: string;
      want: string[];
      got: string[];
      consequence: string;
    }> = [
      {
        what: 'columns',
        want: w.columns,
        got: g.columns,
        consequence:
          'a column that means one thing on a new install and another on an upgraded one',
      },
      {
        what: 'indexes',
        want: w.indexes,
        got: g.indexes,
        consequence:
          'a query that is fast on a new store and a table scan on an old one',
      },
      {
        what: 'foreign keys',
        want: w.fks,
        got: g.fks,
        consequence:
          'a referential rule that holds on one install and not on another',
      },
      {
        what: 'CHECK constraints',
        want: w.checks,
        got: g.checks,
        consequence: 'a value that one install refuses and another accepts',
      },
    ];
    for (const part of parts) {
      diff = diffLists(part.want, part.got);
      if (diff !== '') {
        return `table "${name}": the ${part.what} differ: ${diff}\n  left unfixed this becomes ${part.consequence}`;
      }
    }
  }

  diff = diffLists(names(want.objects), names(got.objects));
  if (diff !== '') {
    return `the views and triggers differ: ${diff}`;
  }
  for (const name of names(want.objects)) {
    if (got.objects.get(name) !== want.objects.get(name)) {
      return `${name} differs:\n    init:    ${want.objects.get(name) ?? ''}\n    migrate: ${got.objects.get(name) ?? ''}`;
    }
  }
  return '';
}

/** names returns a map's keys, sorted. Go needed one of these per value type. */
function names(m: ReadonlyMap<string, unknown>): string[] {
  return [...m.keys()].sort();
}

/**
 * diffLists returns a readable description of the first difference between two
 * sorted lists, or "" when they are equal.
 */
export function diffLists(want: string[], got: string[]): string {
  const missing = subtract(want, got);
  const extra = subtract(got, want);
  if (missing.length === 0 && extra.length === 0) {
    return '';
  }
  if (extra.length === 0) {
    return `the migrated store is missing ${missing.join('; ')}`;
  }
  if (missing.length === 0) {
    return `the migrated store has ${extra.join('; ')}, which a freshly initialized one does not`;
  }
  return `init has ${missing.join('; ')} where migrate has ${extra.join('; ')}`;
}

function subtract(a: readonly string[], b: readonly string[]): string[] {
  const have = new Map<string, number>();
  for (const s of b) {
    have.set(s, (have.get(s) ?? 0) + 1);
  }
  const out: string[] = [];
  for (const s of a) {
    const n = have.get(s) ?? 0;
    if (n > 0) {
      have.set(s, n - 1);
      continue;
    }
    out.push(s);
  }
  return out;
}

/**
 * checksIn pulls the CHECK clauses out of a CREATE TABLE statement. The
 * pragmas report columns, indexes and foreign keys but say nothing about a
 * CHECK, and a constraint that a fresh store enforces and a migrated one does
 * not is exactly the kind of difference this harness exists to find.
 *
 * It is a scanner rather than a parser: it finds the keyword and takes the
 * balanced parentheses after it, ignoring anything inside a string literal.
 */
export function checksIn(ddl: string): string[] {
  const out: string[] = [];
  const lower = ddl.toLowerCase();
  for (let i = 0; i + 5 <= lower.length; ) {
    const at = lower.indexOf('check', i);
    if (at < 0) {
      break;
    }
    i = at + 5;
    if (!isWordBoundary(lower, at, at + 5)) {
      continue;
    }
    let open = at + 5;
    while (open < ddl.length && /[ \n\t\r]/.test(ddl[open] as string)) {
      open++;
    }
    if (open >= ddl.length || ddl[open] !== '(') {
      continue;
    }
    let depth = 0;
    let quote = '';
    for (let j = open; j < ddl.length; j++) {
      const c = ddl[j] as string;
      if (quote !== '') {
        if (c === quote) {
          quote = '';
        }
        continue;
      }
      if (c === "'" || c === '"') {
        quote = c;
        continue;
      }
      if (c === '(') {
        depth++;
        continue;
      }
      if (c === ')') {
        depth--;
        if (depth === 0) {
          out.push(normalizeSQL(ddl.slice(open, j + 1)));
          i = j + 1;
          break;
        }
      }
    }
  }
  out.sort();
  return out;
}

function isWordBoundary(s: string, start: number, end: number): boolean {
  const before = start === 0 || !isWordChar(s[start - 1] as string);
  const after = end >= s.length || !isWordChar(s[end] as string);
  return before && after;
}

function isWordChar(c: string): boolean {
  return /[_a-zA-Z0-9]/.test(c);
}

/**
 * normalizeSQL collapses whitespace and case so that two statements that say
 * the same thing compare equal.
 */
export function normalizeSQL(s: string): string {
  return s.toLowerCase().split(/\s+/).filter(Boolean).join(' ');
}

/**
 * quoteIdent renders an identifier for a PRAGMA. The names come from the
 * engine's own catalogue, but doubling an embedded quote costs nothing and
 * keeps the harness from being the one place that splices a name into SQL
 * unguarded.
 */
export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
