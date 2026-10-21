import { test } from 'node:test';
import assert from 'node:assert/strict';

import { NullText, runMigrations } from '@todocloud/store-testkit';
import { MetaKey } from '@todocloud/core/store/schema';
import { checkSchema, planMigration } from '@todocloud/core/store/version';

import { newFakeServer, openStore, testToken } from './fakeserver.test.ts';
import { Batch, open, openExisting, type Store } from './turso.ts';
import type { Value } from './protocol.ts';

// The migration conformance harness, over the pipeline transport.
//
// This is the run that matters most. A Turso database lives in the user's
// own cloud account, there is no transaction over the pipeline and nothing
// to restore from, so a ladder that lands on a different schema than `tdo
// init` writes is a corruption nobody can undo. The fake server executes the
// statements on a real engine, so what is being checked here is the real
// thing: the statements this provider actually sends, in the order it sends
// them.
runMigrations({
  newStore: async (t) => {
    const fake = await newFakeServer(t);
    const store = open(fake.config());
    t.after(() => store.close());
    return store;
  },
  exec: async (t, s, ...stmts: string[]) => {
    const b = new Batch();
    for (const stmt of stmts) {
      b.add(stmt, false);
    }
    try {
      await (s as Store).send(b);
    } catch (err) {
      t.assert.fail(
        `executing ${stmts.length} statement(s) over the pipeline: ${String(err)}`,
      );
    }
  },
  query: async (t, s, query: string) => {
    let res;
    try {
      res = await (s as Store).exec(query, true);
    } catch (err) {
      t.assert.fail(`querying over the pipeline: ${String(err)}`);
      return [];
    }
    return res.rows.map((row: Value[]) =>
      row.map((v) => {
        if (v.isNull()) {
          return NullText;
        }
        const text = v.text();
        if (text !== undefined) {
          return text;
        }
        const n = v.int64();
        if (n !== undefined) {
          return n.toString(10);
        }
        return NullText;
      }),
    );
  },
});

// A remote store cannot be backed up, and `tdo migrate` must say so rather
// than quietly changing a database the user cannot restore.
test('migrating a remote store requires confirmation because there is no backup', async (t) => {
  const { store, fake } = await openStore(t);
  fake.db.prepare('UPDATE meta SET value = 0 WHERE key = ?').run(MetaKey);

  const plan = await planMigration(store);
  assert.equal(
    plan.backupPath,
    '',
    `there is nothing to copy a remote database into, but the plan claims a backup at ${plan.backupPath}`,
  );
  assert.ok(
    plan.confirm,
    'a migration that cannot be backed up must be confirmed by the user; the plan did not ask for it',
  );
  assert.ok(
    plan.warning.includes('backup'),
    `the warning must say plainly that there is no backup, and ${plan.warning} does not`,
  );
  assert.ok(
    plan.warning.includes(store.database),
    `the warning must name the store being changed, and ${plan.warning} does not mention ${store.database}`,
  );
  assert.ok(
    !plan.warning.includes(testToken),
    'the warning must not carry the token',
  );
});

// The version check every command makes must cost this provider nothing:
// openExisting already read the meta row.
test('checkSchema costs no round trip after openExisting', async (t) => {
  const fake = await newFakeServer(t);
  const first = open(fake.config());
  await first.init();
  await first.close();

  const opened = await openExisting(fake.config());
  t.after(() => opened.close());
  const before = fake.seen().length;
  await checkSchema(opened);
  const after = fake.seen().length;
  assert.equal(
    after,
    before,
    `checkSchema made ${after - before} extra request(s); the version is already in hand from the probe openExisting makes, and every command calls this`,
  );
});
