import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';

import { isNotInitialized } from '@todocloud/core/store';
import { historical, historicalVersions } from '@todocloud/core/store/historical';
import { MetaKey, SetVersionSQL, Version } from '@todocloud/core/store/schema';
import {
  checkSchema,
  isSchemaMismatch,
  planMigration,
  VersionError,
} from '@todocloud/core/store/version';

import { open, type Store } from './sqlite.ts';
import { errorText, rejects, tempDir } from './testsupport.ts';

/**
 * fileStore opens an empty store in a file rather than `:memory:`, because
 * the backup path and the file mode are part of what the migration machinery
 * does.
 */
function fileStore(t: TestContext): Store {
  const s = open(join(tempDir(t), 'tasks.db'));
  t.after(() => s.close());
  return s;
}

// ---------------------------------------------------------------------------
// The ladder walk.
//
// For every schema version ever released, a store is built from that
// version's frozen DDL, migrated, and compared with a store `init` created
// today. The two must hold the same tables, the same columns and the same
// indexes — that is the drift this exists to catch, where a store that was
// migrated behaves differently from a store that was initialized and nothing
// fails and nothing is logged.
//
// The shared conformance harness does this for every provider; see
// conformance.test.ts. It is written out here as well because SQLite is the
// reference provider: a ladder that is broken is broken here first, and this
// package has to say so whether or not the shared suite is present.
// ---------------------------------------------------------------------------

/** column is one column as SQLite describes it, by name rather than position. */
interface Column {
  type: string;
  notNull: boolean;
  dflt: string;
  pk: number;
}

/** schemaOf reads a store's whole schema: tables, columns and indexes. */
function schemaOf(s: Store): string {
  const out: string[] = [];
  const objects = s.db.rows(
    `SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
  );
  for (const object of objects) {
    const type = String(object['type']);
    const name = String(object['name']);
    if (type === 'index') {
      const columns = s.db
        .rows(`PRAGMA index_info(${quote(name)})`)
        .map((row) => String(row['name']))
        .join(',');
      out.push(`index ${name}(${columns})`);
      continue;
    }
    if (type !== 'table') {
      out.push(`${type} ${name}`);
      continue;
    }
    const columns = new Map<string, Column>();
    for (const row of s.db.rows(`PRAGMA table_info(${quote(name)})`)) {
      columns.set(String(row['name']), {
        type: String(row['type']).toUpperCase(),
        notNull: Number(row['notnull']) !== 0,
        dflt: row['dflt_value'] === null ? '' : String(row['dflt_value']),
        pk: Number(row['pk']),
      });
    }
    for (const column of [...columns.keys()].sort()) {
      const c = columns.get(column) as Column;
      out.push(
        `table ${name}.${column} ${c.type}${c.notNull ? ' NOT NULL' : ''}${c.dflt === '' ? '' : ` DEFAULT ${c.dflt}`}${c.pk > 0 ? ` PK${c.pk}` : ''}`,
      );
    }
  }
  return out.join('\n');
}

/** quote renders an identifier for a PRAGMA, which takes no parameter. */
function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

test('every released schema is carried forward onto the schema init writes', async (t) => {
  const versions = historicalVersions();
  assert.ok(
    versions.length > 0,
    'there is no released schema to carry forward, which cannot be right',
  );

  for (const from of versions) {
    await t.test(`from version ${from}`, async (t) => {
      const ddl = historical(from);
      assert.ok(ddl !== undefined, `version ${from} has no frozen DDL`);

      const old = fileStore(t);
      for (const stmt of ddl) {
        old.db.exec(stmt);
      }
      old.db.run(SetVersionSQL, MetaKey, BigInt(from));
      assert.equal(await old.schemaVersion(), from);

      await old.migrate();
      assert.equal(
        await old.schemaVersion(),
        Version,
        'migrate must record the version it arrived at',
      );

      // A migration that was interrupted between a step and the version it
      // records runs again, so every step has to be idempotent; running the
      // whole ladder a second time must change nothing.
      old.db.run(SetVersionSQL, MetaKey, BigInt(from));
      await old.migrate();

      const fresh = fileStore(t);
      await fresh.init();

      assert.equal(
        schemaOf(old),
        schemaOf(fresh),
        `a store migrated from version ${from} does not hold the schema init writes today`,
      );
      // The store is usable afterwards, which no schema comparison can show.
      await fresh.ping();
      await old.ping();
    });
  }
});

// The copy a user is told about: it exists, it is private, and it is a real
// database holding the rows as they were.
test('migrate backs the database up before it changes it', async (t) => {
  const s = fileStore(t);
  const path = s.db.path;
  await s.init();
  s.db.exec(`INSERT INTO meta (key, value) VALUES ('canary', 'still here')`);

  let plan = await planMigration(s);
  assert.ok(
    plan.upToDate,
    `a store just created by init must already be at the current version, but the plan says ${plan.from} -> ${plan.to}`,
  );

  // A store that is behind is the case the backup exists for, so wind the
  // recorded version back to make one.
  s.db.run(`UPDATE meta SET value = 0 WHERE key = ?`, MetaKey);
  plan = await planMigration(s);
  assert.ok(
    !plan.confirm,
    'a local store can be backed up, so `tdo migrate` must not have to ask the user to accept losing it',
  );
  assert.notEqual(
    plan.backupPath,
    '',
    'a local store must be copied before a migration changes it, and the command layer must be told where the copy is',
  );
  assert.equal(
    dirname(plan.backupPath),
    dirname(path),
    'the backup must sit beside the database',
  );
  const base = basename(plan.backupPath);
  assert.ok(
    base.includes('backup'),
    `the backup's name must say that it is a backup, and ${JSON.stringify(base)} does not`,
  );
  assert.ok(
    base.includes('v0'),
    `the backup's name must say which schema version it holds, and ${JSON.stringify(base)} does not`,
  );

  assert.ok(existsSync(plan.backupPath), 'the backup is not there');
  // A permission bit is a POSIX notion: on Windows the mode a stat reports
  // has nothing to do with the ACL that decides access, so the assertion has
  // nothing to read there.
  if (process.platform !== 'win32') {
    const perm = statSync(plan.backupPath).mode & 0o777;
    assert.equal(
      perm,
      0o600,
      `a backup of a task list is private data and must be mode 0600, but it is ${perm.toString(8)}`,
    );
  }

  // It must be a database, not a truncated file: the rows have to be
  // readable, which is the whole reason for taking it.
  const copy = new DatabaseSync(plan.backupPath, { readOnly: true });
  try {
    const row = copy
      .prepare(`SELECT value FROM meta WHERE key = 'canary'`)
      .get();
    assert.equal(row?.['value'], 'still here');
  } finally {
    copy.close();
  }
});

// A second migration must not land on top of the copy the first one left:
// that copy may be the only remaining version of the data in its old shape.
test('a second backup does not overwrite the first', async (t) => {
  const s = fileStore(t);
  await s.init();

  const first = await s.backupForMigration(1);
  const second = await s.backupForMigration(1);
  assert.notEqual(
    first,
    second,
    `both backups were written to ${first}; the first one would have been destroyed`,
  );
  for (const p of [first, second]) {
    assert.ok(existsSync(p), `the backup at ${p} is missing`);
  }
});

// Every command checks the version, so the two mismatches must each produce
// their own advice — and never a raw SQL error.
test('checkSchema tells the user which way the mismatch goes', async (t) => {
  const s = fileStore(t);

  await rejects(
    checkSchema(s),
    isNotInitialized,
    'a store with no schema must be reported as uninitialized',
  );
  await s.init();
  await checkSchema(s); // a store this build just initialized must pass

  for (const tc of [
    {
      name: 'a store older than the binary is told to migrate',
      stored: Version - 1,
      advice: 'tdo migrate',
      older: true,
    },
    {
      name: 'a store newer than the binary is told to upgrade tdo',
      stored: Version + 1,
      advice: 'upgrade tdo',
      older: false,
    },
  ]) {
    await t.test(tc.name, async () => {
      s.db.run(
        `UPDATE meta SET value = ? WHERE key = ?`,
        BigInt(tc.stored),
        MetaKey,
      );
      const err = await rejects(
        checkSchema(s),
        isSchemaMismatch,
        'a version mismatch must be reported as one',
      );
      assert.ok(
        err instanceof VersionError,
        `the command layer must be able to read the detail off the error, but ${String(err)} is not a VersionError`,
      );
      assert.equal(err.older(), tc.older);
      const msg = errorText(err);
      assert.ok(
        msg.includes(tc.advice),
        `the message must tell the user what to do; ${JSON.stringify(msg)} does not mention ${JSON.stringify(tc.advice)}`,
      );
      assert.ok(
        !msg.toLowerCase().includes('no such') && !msg.includes('SQL'),
        `no engine error text may reach the user, but the message is ${JSON.stringify(msg)}`,
      );
    });
  }
});
