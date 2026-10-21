import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import type { Store as StoreContract } from '@todocloud/core/store';
import { MetaKey } from '@todocloud/core/store/schema';
import {
  type Ladder,
  ladderDiff,
  NullText,
  runLadder,
  type SQL,
} from '@todocloud/store-testkit';

import { MemoryPath, open, type Store, text } from './sqlite.ts';

// ---------------------------------------------------------------------------
// The self-test of the migration conformance harness.
//
// Everything else in this package tests the provider. This tests the test:
// `@todocloud/store-testkit`'s migration harness builds a store from every
// released schema, migrates it, and asserts the result is the schema `init`
// writes today. That assertion is the only thing standing between the project
// and the bug it fears most — an `init` and a `migrate` that quietly produce
// different schemas, on stores (Turso, Firestore, D1) that live in the user's
// own cloud account and cannot be rolled back.
//
// A conformance check that has never rejected anything is not known to work.
// The shipped ladder passes, which tells us the harness said yes once; it
// tells us nothing about whether the harness is capable of saying no. A
// detector is only known to work when you have watched it fail. So this file
// drives the harness twice over a toy ladder of its own: once with a step
// that lands exactly where `init` lands, which must pass, and once per kind
// of drift `schemadiff.ts` can detect, each of which must be rejected — and
// rejected with a message that names what actually differs, because the
// reader of that failure is a provider author who has to go and fix it.
//
// This is the port of Go's `internal/store/sqlite/harness_test.go`. It lives
// in this package rather than in `store-testkit` for two reasons. The testkit
// ships no `*.test.ts` files by design: its sources are the rules, and a
// `*.test.ts` there would be picked up by the root `npm test` glob, which is
// the arrangement that keeps the conformance suite from ever running with no
// provider behind it. And the drift being hunted is a property of a real
// engine's catalogue — `PRAGMA table_info`, invented index names, where
// `ALTER TABLE` puts a column — so the self-test needs a real store, which is
// exactly what the reference provider has. Go made the same call.
// ---------------------------------------------------------------------------

const harnessV1 = 1;
const harnessV2 = 2;

/**
 * harnessSQL is the raw access the harness needs, over an in-memory store per
 * call — the same thing conformance.test.ts does, and never a path the user
 * might own (CLAUDE.md §1.5). `:memory:` is enough here because nothing in
 * this file looks at the backup path or the file mode.
 */
const harnessSQL: SQL = {
  newStore: (t: TestContext): StoreContract => {
    const s = open(MemoryPath);
    t.after(() => s.close());
    return s;
  },
  exec: async (_t: TestContext, s: StoreContract, ...stmts: string[]) => {
    for (const stmt of stmts) {
      try {
        asSqlite(s).db.exec(stmt);
      } catch (err) {
        assert.fail(`executing ${firstLine(stmt)}: ${String(err)}`);
      }
    }
  },
  query: async (_t: TestContext, s: StoreContract, query: string) => {
    let rows;
    try {
      rows = asSqlite(s).db.rows(query);
    } catch (err) {
      return assert.fail(`querying ${firstLine(query)}: ${String(err)}`);
    }
    return rows.map((row) =>
      Object.values(row).map((cell) => text(cell) ?? NullText),
    );
  },
};

/** asSqlite recovers the provider's type; this file created every store. */
function asSqlite(s: StoreContract): Store {
  return s as Store;
}

function firstLine(s: string): string {
  const i = s.indexOf('\n');
  return i >= 0 ? `${s.slice(0, i)} ...` : s;
}

/**
 * setVersionStatement records a version with the number written into the SQL
 * rather than bound to a placeholder. That is deliberate: `node:sqlite` binds
 * a JS number as REAL, so a bound `2` lands in the TEXT column as `"2.0"`
 * (MIGRATION.md). A literal avoids the question entirely, and it is also what
 * the harness's own `plant` does, so the toy ladder and the harness agree on
 * what a recorded version looks like.
 */
function setVersionStatement(v: number): string {
  return `INSERT INTO meta (key, value) VALUES ('${MetaKey}', ${v})
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
}

// harnessBase is the toy version 1: a table, an index, and the meta table the
// version is recorded in, which every store needs.
const harnessBase: string[] = [
  `CREATE TABLE IF NOT EXISTS widgets (
  id   TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS widgets_name_idx ON widgets(name)`,
  `CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
)`,
];

/**
 * harnessV2Additions is what version 2 adds, as `init` writes it. It is
 * deliberately rich enough to exercise every part of a schema the harness
 * compares: columns with a type, a NOT NULL and a default; a named index; a
 * foreign key; a CHECK constraint; a view; and a trigger.
 */
const harnessV2Additions: string[] = [
  `CREATE TABLE IF NOT EXISTS widget_notes (
  widget_id TEXT PRIMARY KEY NOT NULL REFERENCES widgets(id) ON DELETE CASCADE,
  note      TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 500)
)`,
  `CREATE INDEX IF NOT EXISTS widget_notes_note_idx ON widget_notes(note)`,
  `CREATE VIEW IF NOT EXISTS widget_summary AS
   SELECT w.id AS id, w.name AS name, n.note AS note
   FROM widgets w LEFT JOIN widget_notes n ON n.widget_id = w.id`,
  `CREATE TRIGGER IF NOT EXISTS widget_notes_touch
   AFTER UPDATE ON widget_notes
   BEGIN
     UPDATE widgets SET name = name WHERE id = NEW.widget_id;
   END`,
];

/**
 * harnessLadder is a Ladder that runs one test-only step. `init` and
 * `migrate` do by hand what the provider's own `init` and `migrate` do: run
 * the statements, then record the version — for `migrate`, after the step and
 * never in the same breath as the statements themselves, because that is the
 * window an interrupted migration stops in and the harness replays.
 */
function harnessLadder(step: string[]): Ladder {
  return {
    sql: harnessSQL,
    target: harnessV2,
    historical: new Map<number, string[]>([[harnessV1, harnessBase]]),
    init: async (t, s) => {
      await harnessSQL.exec(
        t,
        s,
        ...harnessBase,
        ...harnessV2Additions,
        setVersionStatement(harnessV2),
      );
    },
    migrate: async (t, s) => {
      const current = await s.schemaVersion();
      if (current >= harnessV2) {
        return undefined;
      }
      await harnessSQL.exec(
        t,
        s,
        ...step,
        setVersionStatement(harnessV2),
      );
      return undefined;
    },
    data: new Map(),
  };
}

/**
 * The positive half: a step that reaches version 2 exactly the way `init`
 * does must pass every assertion the harness makes, including being run a
 * second time after an interrupted migration. Every statement is idempotent,
 * which is what lets the retry succeed.
 */
test('the harness accepts a migration that lands on the schema init writes', async (t) => {
  const l = harnessLadder(harnessV2Additions);
  await runLadder(t, l);

  // runLadder asserts; ladderDiff reports. Check the reporting path agrees,
  // since every negative case below reads its answer from ladderDiff and a
  // ladderDiff that always said "different" would pass all of them.
  const diff = await ladderDiff(t, l, harnessV1);
  assert.equal(
    diff,
    '',
    `a correct ladder must produce no differences, but the harness says: ${diff}`,
  );
});

/**
 * The half that makes the other one worth anything.
 *
 * Each case below is a step that reaches version 2 with a schema `init` would
 * not have written. Every one of them produces a store that works, answers
 * queries and loses no data today — that is precisely why the drift is worth
 * hunting: nothing fails and nothing is logged. The harness must still refuse
 * it, and the message must name the object and the thing about it that is
 * wrong, so the person reading the failure knows what to fix.
 *
 * The cases are enumerated from `schemadiff.ts`: it compares tables, and per
 * table columns, indexes, foreign keys and CHECK constraints, and then views
 * and triggers by name and by body. Each comparison is covered here, in both
 * directions where `diffLists` words them differently — something missing
 * from the migrated store, and something extra that a fresh one does not have.
 */
test('the harness rejects a migration that drifts from init', async (t) => {
  // correct is the right step, which each case spoils in exactly one way.
  const correct = harnessV2Additions;
  const [notesTable, notesIndex, summaryView, touchTrigger] = correct as [
    string,
    string,
    string,
    string,
  ];

  const cases: Array<{
    name: string;
    step: string[];
    /** Every fragment must appear in the message the harness produces. */
    names: string[];
  }> = [
    {
      // A step that forgot a whole table: the oldest migration bug there is.
      name: 'a missing table',
      step: [],
      names: ['the tables differ', 'missing', 'widget_notes'],
    },
    {
      // A scratch table a migration created and never dropped. Harmless
      // today; the next version's step writes to it and new installs do not
      // have it.
      name: 'an extra table a fresh store does not have',
      step: [
        ...correct,
        `CREATE TABLE IF NOT EXISTS widget_scratch (id TEXT PRIMARY KEY NOT NULL)`,
      ],
      names: ['the tables differ', 'widget_scratch', 'does not'],
    },
    {
      name: 'a missing column',
      step: [
        `CREATE TABLE IF NOT EXISTS widget_notes (
  widget_id TEXT PRIMARY KEY NOT NULL REFERENCES widgets(id) ON DELETE CASCADE
)`,
        notesIndex.replace('(note)', '(widget_id)'),
        summaryView.replace('n.note AS note', `'' AS note`),
        touchTrigger,
      ],
      names: ['widget_notes', 'columns', 'missing', 'note'],
    },
    {
      // The drift the Go self-test used: the column is there, but it has lost
      // its NOT NULL and its default, so the same read means one thing on a
      // new install and another on an upgraded one.
      name: 'a column that lost its NOT NULL and its default',
      step: [
        `CREATE TABLE IF NOT EXISTS widget_notes (
  widget_id TEXT PRIMARY KEY NOT NULL REFERENCES widgets(id) ON DELETE CASCADE,
  note      TEXT CHECK (length(note) <= 500)
)`,
        notesIndex,
        summaryView,
        touchTrigger,
      ],
      names: ['widget_notes', 'columns', 'note', 'notnull='],
    },
    {
      // An index nobody created: a query that is fast on a new store and a
      // table scan on an upgraded one.
      name: 'a missing index',
      step: [notesTable, summaryView, touchTrigger],
      names: ['widget_notes', 'indexes', 'missing', 'widget_notes_note_idx'],
    },
    {
      name: 'an extra index a fresh store does not have',
      step: [
        ...correct,
        `CREATE INDEX IF NOT EXISTS widget_notes_widget_idx ON widget_notes(widget_id)`,
      ],
      names: ['widget_notes', 'indexes', 'widget_notes_widget_idx', 'does not'],
    },
    {
      // SQLite cannot add a foreign key to an existing table, so a migration
      // that rebuilds the table is where this one gets lost.
      name: 'a missing foreign key',
      step: [
        `CREATE TABLE IF NOT EXISTS widget_notes (
  widget_id TEXT PRIMARY KEY NOT NULL,
  note      TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 500)
)`,
        notesIndex,
        summaryView,
        touchTrigger,
      ],
      names: ['widget_notes', 'foreign keys', 'missing', 'widgets'],
    },
    {
      // A value one install refuses and another accepts.
      name: 'a missing CHECK constraint',
      step: [
        `CREATE TABLE IF NOT EXISTS widget_notes (
  widget_id TEXT PRIMARY KEY NOT NULL REFERENCES widgets(id) ON DELETE CASCADE,
  note      TEXT NOT NULL DEFAULT ''
)`,
        notesIndex,
        summaryView,
        touchTrigger,
      ],
      names: ['widget_notes', 'CHECK', 'missing', 'length(note)'],
    },
    {
      name: 'a missing trigger',
      step: [notesTable, notesIndex, summaryView],
      names: ['views and triggers', 'missing', 'widget_notes_touch'],
    },
    {
      name: 'a view that exists under the right name with the wrong body',
      step: [
        notesTable,
        notesIndex,
        `CREATE VIEW IF NOT EXISTS widget_summary AS
         SELECT w.id AS id, w.name AS name, n.note AS note
         FROM widgets w JOIN widget_notes n ON n.widget_id = w.id`,
        touchTrigger,
      ],
      names: ['widget_summary', 'differs', 'join'],
    },
  ];

  for (const tc of cases) {
    await t.test(`${tc.name} is reported`, async (t) => {
      const diff = await ladderDiff(t, harnessLadder(tc.step), harnessV1);
      assert.notEqual(
        diff,
        '',
        `the harness accepted a migration with ${tc.name};\n` +
          '  that is exactly the drift it exists to catch, and a harness that cannot catch it\n' +
          '  proves nothing about the ladders it passes',
      );
      for (const want of tc.names) {
        assert.ok(
          diff.includes(want),
          `the failure must name what differs: it does not mention ${JSON.stringify(want)}, it says:\n${diff}`,
        );
      }
    });
  }
});

/**
 * The harness compares columns by name rather than by position, because
 * SQLite appends a column added by `ALTER TABLE` while a fresh `CREATE TABLE`
 * puts it where the DDL does. That is a difference in layout and not in
 * schema — no statement in the tree depends on ordinal position — and the
 * harness must not report it. Otherwise every honest add-a-column migration
 * fails, and a check that cries wolf is a check somebody switches off.
 */
test('the harness does not mind where an added column sits', async (t) => {
  const l = harnessLadder([`ALTER TABLE widgets ADD COLUMN colour TEXT`]);
  // init writes the same column in the middle of the table instead.
  l.init = async (t, s) => {
    await harnessSQL.exec(
      t,
      s,
      `CREATE TABLE IF NOT EXISTS widgets (
  id     TEXT PRIMARY KEY NOT NULL,
  colour TEXT,
  name   TEXT NOT NULL
)`,
      `CREATE INDEX IF NOT EXISTS widgets_name_idx ON widgets(name)`,
      `CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
)`,
      setVersionStatement(harnessV2),
    );
  };

  const diff = await ladderDiff(t, l, harnessV1);
  assert.equal(
    diff,
    '',
    `a column added at the end is the same schema as the same column written in the middle, but the harness says: ${diff}`,
  );
});
