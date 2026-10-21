import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { New } from '@todocloud/core/id';
import {
  ErrAmbiguous,
  ErrNotFound,
  ErrNotInitialized,
  isAmbiguous,
  isNotFound,
  isNotInitialized,
  OrderCreated,
  OrderUpdated,
} from '@todocloud/core/store';
import { Filter } from '@todocloud/core/store/filter';
import { type Fields, StatusActive, StatusDone, Task } from '@todocloud/core/task';

import { SchemaVersion } from './schema.ts';
import { MemoryPath, open, openDSN, openExisting } from './sqlite.ts';
import {
  errorText,
  idA,
  idB,
  idB2,
  idC,
  newTask,
  openStore,
  rejects,
  tempDir,
} from './testsupport.ts';

test('an in-memory store opens, initializes, answers a ping and names itself', async (t) => {
  const s = open(MemoryPath);
  t.after(() => s.close());
  await s.init();
  await s.ping();
  assert.equal(s.describe(), `sqlite: ${MemoryPath}`);
});

test('open creates the parent directories', async (t) => {
  const path = join(tempDir(t), 'nested', 'deeper', 'tasks.db');
  const s = open(path);
  t.after(() => s.close());
  await s.init();
  assert.ok(existsSync(path), 'the database file was not created');
});

test('close is safe to call twice', async (t) => {
  const s = await openStore(t);
  await s.close();
  await s.close();
});

test('init is idempotent', async (t) => {
  const s = await openStore(t);
  await s.add(newTask(idA, 'keep me'));
  await s.init();
  await s.get(idA); // throws if the second init lost it
  assert.equal(await s.schemaVersion(), SchemaVersion);
});

test('before init, the version and the ping both say so', async (t) => {
  const s = open(MemoryPath);
  t.after(() => s.close());

  await rejects(
    s.schemaVersion(),
    isNotInitialized,
    'a store with no schema must report ErrNotInitialized',
  );
  await rejects(
    s.ping(),
    isNotInitialized,
    'a ping against a store with no schema must report ErrNotInitialized',
  );
});

test('migrate on a fresh store creates the current schema', async (t) => {
  const s = open(MemoryPath);
  t.after(() => s.close());

  await s.migrate();
  assert.equal(await s.schemaVersion(), SchemaVersion);
  // Already current: a second run changes nothing.
  await s.migrate();
  await s.add(newTask(idA, 'usable after migrate'));
});

test('migrate refuses a schema written by a newer build', async (t) => {
  const s = await openStore(t);
  s.db.run(
    `UPDATE meta SET value = ? WHERE key = ?`,
    BigInt(SchemaVersion + 1),
    'schema_version',
  );
  await assert.rejects(
    s.migrate(),
    'migrate succeeded on a newer schema, want an error',
  );
});

test('a task survives the round trip, fields and all', async (t) => {
  const completed = new Date('2026-04-01T12:00:00Z');
  const cases: { name: string; fields: Fields }[] = [
    { name: 'no fields', fields: {} },
    {
      name: 'well-known fields',
      fields: { priority: 2, context: 'errands' },
    },
    {
      name: 'unknown fields this binary knows nothing about',
      fields: {
        estimate: 1.5,
        blocked: true,
        empty: '',
        nested: {
          owner: 'sam',
          depth: 3,
          inner: { ratio: 0.25 },
        },
        mixed: [1, 'two', true, 3.5, { k: 'v' }],
      },
    },
  ];

  for (const tc of cases) {
    await t.test(tc.name, async (t) => {
      const s = await openStore(t);

      const want = newTask(idA, 'round trip', tc.fields);
      want.status = StatusDone;
      want.completedAt = completed;
      assert.equal(want.validate(), undefined);
      await s.add(want);

      const got = await s.get(idA);
      assert.equal(got.title, want.title);
      assert.equal(got.done(), want.done());
      assert.deepEqual(got.createdAt, want.createdAt);
      assert.deepEqual(got.updatedAt, want.updatedAt);
      assert.deepEqual(got.completedAt, completed);
      assert.equal(got.deletedAt, undefined);
      assert.deepEqual(got.fields, want.fields);
    });
  }
});

test('add refuses a duplicate id', async (t) => {
  const s = await openStore(t);
  await s.add(newTask(idA, 'first'));
  await assert.rejects(
    s.add(newTask(idA, 'second')),
    'add accepted a duplicate id, want an error',
  );
});

test('get returns a tombstoned task, and reports an unknown one', async (t) => {
  const s = await openStore(t);
  const deleted = new Date('2026-06-07T08:09:10Z');

  const tombstoned = newTask(idA, 'removed');
  tombstoned.deletedAt = deleted;
  await s.add(tombstoned);

  const got = await s.get(idA);
  assert.ok(got.deleted());
  assert.deepEqual(got.deletedAt, deleted);

  await rejects(s.get(idC), isNotFound, 'get of an unknown id');
});

test('findByPrefix', async (t) => {
  const cases: {
    name: string;
    ids: string[];
    prefix: string;
    wantID?: string;
    wantErr?: Error;
  }[] = [
    { name: 'unique hit', ids: [idA, idC], prefix: '01J3A', wantID: idA },
    { name: 'full id', ids: [idA], prefix: idA, wantID: idA },
    { name: 'lower case prefix', ids: [idA], prefix: '01j3a', wantID: idA },
    { name: 'no hit', ids: [idA], prefix: '01J3Z', wantErr: ErrNotFound },
    {
      name: 'ambiguous',
      ids: [idB, idB2],
      prefix: '01J3B',
      wantErr: ErrAmbiguous,
    },
  ];

  for (const tc of cases) {
    await t.test(tc.name, async (t) => {
      const s = await openStore(t);
      for (const taskID of tc.ids) {
        await s.add(newTask(taskID, 't'));
      }
      if (tc.wantErr !== undefined) {
        const pred = tc.wantErr === ErrAmbiguous ? isAmbiguous : isNotFound;
        await rejects(
          s.findByPrefix(tc.prefix),
          pred,
          `findByPrefix(${tc.prefix}) must report ${tc.wantErr.message}`,
        );
        return;
      }
      const got = await s.findByPrefix(tc.prefix);
      assert.equal(got.id, tc.wantID);
    });
  }
});

test('list', async (t) => {
  // pending, completed and tombstoned, in a known creation order.
  const seed = async (t: TestContext) => {
    const s = await openStore(t);
    const base = new Date('2026-01-01T00:00:00Z');

    // Literal ids, in ascending order, so that creation order is
    // deterministic even for tasks added in the same millisecond.
    const order = [idA, idB, idC];
    const names = ['pending', 'completed', 'deleted'];
    for (let i = 0; i < names.length; i++) {
      const name = names[i] as string;
      const tk = newTask(order[i] as string, name);
      // Reverse the update order relative to creation order, so that
      // OrderUpdated and OrderCreated cannot agree by accident.
      tk.updatedAt = new Date(base.getTime() + (3 - i) * 3600_000);
      if (name === 'completed') {
        tk.status = StatusDone;
        tk.completedAt = base;
      } else if (name === 'deleted') {
        tk.deletedAt = base;
      }
      await s.add(tk);
    }
    return s;
  };

  const titles = (tasks: Task[]): string[] => tasks.map((tk) => tk.title);

  const cases: { name: string; filter: Filter; want: string[] }[] = [
    {
      name: 'a status filter of active excludes the completed and the tombstoned',
      filter: new Filter({ statuses: [StatusActive] }),
      want: ['pending'],
    },
    {
      name: 'completed only',
      filter: new Filter({ statuses: [StatusDone] }),
      want: ['completed'],
    },
    {
      name: 'no status filter, tombstone still excluded',
      filter: new Filter(),
      want: ['pending', 'completed'],
    },
    {
      name: 'tombstone included',
      filter: new Filter({ includeDeleted: true }),
      want: ['pending', 'completed', 'deleted'],
    },
    {
      name: 'limit',
      filter: new Filter({ includeDeleted: true, limit: 2 }),
      want: ['pending', 'completed'],
    },
    {
      name: 'order by update time',
      filter: new Filter({ includeDeleted: true, order: OrderUpdated }),
      want: ['deleted', 'completed', 'pending'],
    },
  ];

  for (const tc of cases) {
    await t.test(tc.name, async (t) => {
      const s = await seed(t);
      const got = await s.list(tc.filter);
      assert.deepEqual(titles(got), tc.want);
      for (const tk of got) {
        assert.ok(tk.fields !== undefined, `task ${tk.id} has no fields`);
      }
    });
  }
});

test('creation order is the order of the generated ids', async (t) => {
  const s = await openStore(t);

  const want: string[] = [];
  for (let i = 0; i < 5; i++) {
    const taskID = New();
    want.push(taskID);
    await s.add(newTask(taskID, 't'));
    await new Promise((resolve) => setTimeout(resolve, 2));
  }

  const got = await s.list(new Filter({ order: OrderCreated }));
  assert.deepEqual(
    got.map((tk) => tk.id),
    want,
  );
});

test('update rewrites the row, and refuses an unknown id', async (t) => {
  const s = await openStore(t);

  const original = newTask(idA, 'write the provider', { priority: 1 });
  await s.add(original);

  const edited = original.clone();
  edited.title = 'write the provider tests';
  edited.updatedAt = new Date(original.updatedAt.getTime() + 3600_000);
  edited.setStatus(StatusDone, edited.updatedAt);
  edited.fields['priority'] = 3;
  edited.fields['owner'] = 'sam';
  await s.update(edited);

  const got = await s.get(idA);
  assert.equal(got.title, edited.title);
  assert.ok(got.done());
  assert.deepEqual(got.fields, edited.fields);

  await rejects(
    s.update(newTask(idC, 'never stored')),
    isNotFound,
    'update of an unknown id',
  );
});

test('purge removes the row, and then reports it missing', async (t) => {
  const s = await openStore(t);
  await s.add(newTask(idA, 'temporary'));
  await s.purge(idA);
  await rejects(s.get(idA), isNotFound, 'get after purge');
  await rejects(s.purge(idA), isNotFound, 'purge of an unknown id');
});

test('a store reopened from its file holds what was written', async (t) => {
  const path = join(tempDir(t), 'tasks.db');

  const first = open(path);
  await first.init();
  const fields: Fields = { nested: { list: [1, 2.5, 'three'] } };
  await first.add(newTask(idA, 'survives', fields));
  await first.close();

  const second = open(path);
  t.after(() => second.close());
  await second.ping();
  const got = await second.get(idA);
  assert.deepEqual(got.fields, fields);
});

test('openExisting on a missing file creates nothing', async (t) => {
  const dir = join(tempDir(t), 'stray');
  const path = join(dir, 'tasks.db');

  assert.throws(
    () => openExisting(path),
    (err) => isNotInitialized(err),
    'openExisting on a missing file must report ErrNotInitialized',
  );
  assert.ok(!existsSync(path), 'the database file exists after openExisting');
  assert.ok(!existsSync(dir), 'the parent directory exists after openExisting');
});

test('openExisting on the in-memory path is not initialized', () => {
  assert.throws(
    () => openExisting(MemoryPath),
    (err) => isNotInitialized(err),
    'openExisting(:memory:) must report ErrNotInitialized',
  );
});

test('every operation on a store without a schema reports it, and names no table', async (t) => {
  const path = join(tempDir(t), 'tasks.db');

  // An empty but valid database file: opened for creation, never initialized.
  const created = open(path);
  await created.close();

  const s = openExisting(path);
  t.after(() => s.close());

  const ops: { name: string; run: () => Promise<unknown> }[] = [
    { name: 'get', run: () => s.get(idA) },
    { name: 'findByPrefix', run: () => s.findByPrefix('01J3') },
    { name: 'list', run: () => s.list(new Filter()) },
    { name: 'update', run: () => s.update(newTask(idA, 'nope')) },
    { name: 'purge', run: () => s.purge(idA) },
    { name: 'add', run: () => s.add(newTask(idA, 'nope')) },
    { name: 'schemaVersion', run: () => s.schemaVersion() },
    { name: 'ping', run: () => s.ping() },
  ];
  for (const op of ops) {
    const err = await rejects(
      op.run(),
      isNotInitialized,
      `${op.name} on a store without a schema`,
    );
    assert.ok(
      !errorText(err).includes('no such table'),
      `${op.name} leaks the driver message: ${errorText(err)}`,
    );
  }
});

test('neither open nor openExisting touches a file that is not a database', (t) => {
  const path = join(tempDir(t), 'notes.txt');
  const content = 'this is not a database\n';
  writeFileSync(path, content, { mode: 0o600 });

  for (const tc of [
    { name: 'open', fn: open },
    { name: 'openExisting', fn: openExisting },
  ]) {
    assert.throws(
      () => tc.fn(path),
      `${tc.name} succeeded on a file that is not a database`,
    );
    assert.equal(
      readFileSync(path, 'utf8'),
      content,
      `${tc.name} changed the file`,
    );
  }
});

// This pins the driver behaviour openExisting relies on as its second line of
// defence: the DSN itself must fail rather than create the file. `node:sqlite`
// passes a `file:` name through to SQLite as a URI, which is what makes
// mode=rw mean what it meant in Go.
test('the read-write DSN refuses to create the file', (t) => {
  const path = join(tempDir(t), 'tasks.db');

  assert.throws(
    () => openDSN(path, `file:${path}?mode=rw`),
    `mode=rw created ${path}; openExisting would then rely on its stat guard alone`,
  );
  assert.ok(!existsSync(path), 'mode=rw created the file');
});

// The mode of a file this tool created is asserted in permissions.test.ts;
// here it is only worth knowing that the file exists at all after an init.
test('init leaves a database file behind', async (t) => {
  const path = join(tempDir(t), 'tasks.db');
  const s = open(path);
  t.after(() => s.close());
  await s.init();
  assert.ok(statSync(path).isFile());
});
