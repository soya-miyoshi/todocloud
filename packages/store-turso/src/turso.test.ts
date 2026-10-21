import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';

import { Config as ExitConfig, classify } from '@todocloud/core/exit';
import * as id from '@todocloud/core/id';
import {
  OrderUpdated,
  isAmbiguous,
  isExists,
  isNotFound,
  isNotInitialized,
  type Store as CoreStore,
} from '@todocloud/core/store';
import { Filter } from '@todocloud/core/store/filter';
import {
  KeyPriority,
  StatusActive,
  StatusDone,
  Task,
  type Fields,
} from '@todocloud/core/task';

import { assertNoDriverLeak } from './injection.test.ts';
import {
  idA,
  idB,
  idB2,
  idC,
  newFakeServer,
  newTestTask,
  openStore,
  testNow,
  testToken,
  tokenForTest,
} from './fakeserver.test.ts';
import {
  SchemaVersion,
  errClosed,
  open,
  openExisting,
  type Store,
} from './turso.ts';

test('describe names the database and no credential', async (t) => {
  const s = open({ url: 'libsql://tasks-acme.turso.io', token: tokenForTest() });
  t.after(() => s.close());

  const got = s.describe();
  assert.equal(got, 'turso database "tasks"');
  // describe is printed by `tdo config` and pasted into bug reports, so it
  // must not carry the token under any spelling.
  assert.ok(!got.includes(testToken) && !got.includes('Bearer'), got);
});

// A host whose name cannot be read confidently still gets a description: the
// host itself, which is public information.
test('describe falls back to the host', async (t) => {
  const s = open({ url: 'https://localhost:8080', token: tokenForTest() });
  t.after(() => s.close());
  assert.equal(s.describe(), 'turso database "localhost:8080"');
});

test('close twice', async (t) => {
  const { store } = await openStore(t);
  await store.close();
  await store.close();
});

// init puts the whole schema up in one round trip after one read: a remote
// store pays a latency for every request, so the batching the pipeline exists
// for is part of the contract, not an optimisation detail.
//
// The read is the version guard. init is idempotent and so meets stores that
// already have a schema, including one a newer tdo wrote, and writing this
// build's version over a higher one would leave the marker describing a
// schema that is not there. That is worth a round trip on the one command a
// store sees once in its life.
test('init is one round trip and is idempotent', async (t) => {
  const { store: s, fake } = await openStore(t);
  assert.equal(
    fake.seen().length,
    2,
    'init must make 2 requests: the version guard, then the whole schema',
  );
  await s.add(newTestTask(idA, 'keep me'));
  await s.init();
  await s.get(idA); // the task must have survived the second init
  assert.equal(await s.schemaVersion(), SchemaVersion);
});

test('schemaVersion before init is not-initialized', async (t) => {
  const fake = await newFakeServer(t);
  const s = open(fake.config());
  t.after(() => s.close());

  // The remote engine answers "no such table: meta". The user must never
  // see that: it is a configuration problem with a known remedy.
  const err = await s.schemaVersion().then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.ok(isNotInitialized(err), `schemaVersion() error = ${String(err)}`);
  assertNoDriverLeak(err);
  const pingErr = await s.ping().then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.ok(isNotInitialized(pingErr), String(pingErr));
  assert.equal(classify(pingErr).code, ExitConfig);
});

test('migrate from a fresh database', async (t) => {
  const fake = await newFakeServer(t);
  const s = open(fake.config());
  t.after(() => s.close());

  await s.migrate();
  assert.equal(await s.schemaVersion(), SchemaVersion);
  // Already current: a second run changes nothing and asks for no upgrade.
  await s.migrate();
  await s.add(newTestTask(idA, 'usable after migrate'));
});

// A store written by a newer binary is refused rather than guessed at, and
// the refusal is a configuration problem so the process exits 3.
test('migrate refuses a future version', async (t) => {
  const { store: s, fake } = await openStore(t);
  // A bigint, not a number: node:sqlite binds a JS number as REAL, and a
  // version stored as "3.0" would be read back as no version at all —
  // which is a property of the test fixture, not of the provider.
  fake.db
    .prepare('UPDATE meta SET value = ? WHERE key = ?')
    .run(BigInt(SchemaVersion + 1), 'schema_version');
  const err = await s.migrate().then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.ok(err !== undefined, 'migrate() succeeded against a newer schema');
  assert.equal(classify(err).code, ExitConfig, (err as Error).message);
});

test('add and get round trip', async (t) => {
  const completed = new Date('2026-04-01T12:00:00Z');
  const cases: { name: string; fields: Fields }[] = [
    { name: 'no fields', fields: {} },
    {
      name: 'the fields the CLI knows a meaning for',
      fields: { [KeyPriority]: 2, context: 'errands' },
    },
    {
      name: 'unknown fields this build knows nothing about',
      fields: {
        estimate: 1.5,
        blocked: true,
        empty: '',
        nested: { owner: 'sam', depth: 3, inner: { ratio: 0.25 } },
        mixed: [1, 'two', true, 3.5, { k: 'v' }],
      },
    },
    {
      // Go sent integers as decimal strings precisely so that an int64 edge
      // survived. A JavaScript number cannot hold one, so the edge that
      // matters here is the safe-integer boundary — the largest whole number
      // the language itself keeps exactly.
      name: 'integers across the safe-integer range',
      fields: {
        max: Number.MAX_SAFE_INTEGER,
        min: Number.MIN_SAFE_INTEGER,
        zero: 0,
        nested: { deep: [Number.MAX_SAFE_INTEGER, -1] },
      },
    },
  ];

  for (const tc of cases) {
    await t.test(tc.name, async (st) => {
      const { store: s } = await openStore(st);

      const want = newTestTask(idA, 'round trip', tc.fields);
      want.setStatus(StatusDone, completed);
      want.updatedAt = want.createdAt;
      assert.equal(want.validate(), undefined);
      await s.add(want);

      const got = await s.get(idA);
      assert.equal(got.title, want.title);
      assert.equal(got.status, want.status);
      assert.equal(got.createdAt.getTime(), want.createdAt.getTime());
      assert.equal(got.updatedAt.getTime(), want.updatedAt.getTime());
      assert.equal(got.completedAt?.getTime(), completed.getTime());
      assert.equal(got.deletedAt, undefined);
      assert.deepEqual(got.fields, want.fields);
    });
  }
});

test('add rejects a duplicate id', async (t) => {
  const { store: s } = await openStore(t);
  await s.add(newTestTask(idA, 'first'));
  const err = await s.add(newTestTask(idA, 'second')).then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.ok(isExists(err), `add() of a duplicate = ${String(err)}`);
  assertNoDriverLeak(err);
});

test('get returns a tombstoned task, and not-found for an unknown one', async (t) => {
  const { store: s } = await openStore(t);
  const deleted = new Date('2026-06-07T08:09:10Z');

  const tombstoned = newTestTask(idA, 'removed');
  tombstoned.deletedAt = deleted;
  await s.add(tombstoned);

  const got = await s.get(idA);
  assert.ok(got.deleted());
  assert.equal(got.deletedAt?.getTime(), deleted.getTime());

  const err = await s.get(idC).then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.ok(isNotFound(err), String(err));
});

test('findByPrefix', async (t) => {
  const cases: {
    name: string;
    ids: string[];
    prefix: string;
    wantID?: string;
    want?: 'not_found' | 'ambiguous';
  }[] = [
    { name: 'unique hit', ids: [idA, idC], prefix: '01J3A', wantID: idA },
    { name: 'full id', ids: [idA], prefix: idA, wantID: idA },
    { name: 'lower case prefix', ids: [idA], prefix: '01j3a', wantID: idA },
    { name: 'no hit', ids: [idA], prefix: '01J3Z', want: 'not_found' },
    { name: 'ambiguous', ids: [idB, idB2], prefix: '01J3B', want: 'ambiguous' },
  ];

  for (const tc of cases) {
    await t.test(tc.name, async (st) => {
      const { store: s } = await openStore(st);
      for (const taskID of tc.ids) {
        await s.add(newTestTask(taskID, 't'));
      }
      const result = await s.findByPrefix(tc.prefix).then(
        (got) => got,
        (e: unknown) => e,
      );
      if (tc.want === 'not_found') {
        assert.ok(isNotFound(result), String(result));
        return;
      }
      if (tc.want === 'ambiguous') {
        assert.ok(isAmbiguous(result), String(result));
        return;
      }
      assert.equal((result as Task).id, tc.wantID);
    });
  }
});

test('list', async (t) => {
  const base = new Date('2026-01-01T00:00:00Z');
  const seed = async (st: TestContext): Promise<Store> => {
    const { store: s } = await openStore(st);
    // Literal ids, in ascending order, so that creation order is
    // deterministic even for tasks added in the same millisecond.
    const order = [idA, idB, idC];
    const names = ['active', 'completed', 'deleted'];
    for (let i = 0; i < names.length; i++) {
      const name = names[i] as string;
      const tk = newTestTask(order[i] as string, name);
      if (name === 'completed') {
        tk.setStatus(StatusDone, base);
      }
      if (name === 'deleted') {
        tk.deletedAt = new Date(base.getTime());
      }
      // Reverse the update order relative to creation order, so that
      // OrderUpdated and OrderCreated cannot agree by accident.
      tk.updatedAt = new Date(base.getTime() + (3 - i) * 3_600_000);
      await s.add(tk);
    }
    return s;
  };

  const cases: { name: string; filter: Filter; want: string[] }[] = [
    {
      name: 'a status filter keeps only that status',
      filter: new Filter({ statuses: [StatusActive] }),
      want: ['active'],
    },
    {
      name: 'completed only',
      filter: new Filter({ statuses: [StatusDone] }),
      want: ['completed'],
    },
    {
      name: 'no status filter, tombstone still excluded',
      filter: new Filter(),
      want: ['active', 'completed'],
    },
    {
      name: 'tombstone included',
      filter: new Filter({ includeDeleted: true }),
      want: ['active', 'completed', 'deleted'],
    },
    {
      name: 'only the tombstones',
      filter: new Filter({ onlyDeleted: true }),
      want: ['deleted'],
    },
    {
      name: 'limit',
      filter: new Filter({ includeDeleted: true, limit: 2 }),
      want: ['active', 'completed'],
    },
    {
      name: 'order by update time',
      filter: new Filter({ includeDeleted: true, order: OrderUpdated }),
      want: ['deleted', 'completed', 'active'],
    },
  ];

  for (const tc of cases) {
    await t.test(tc.name, async (st) => {
      const s = await seed(st);
      const got = await s.list(tc.filter);
      assert.deepEqual(
        got.map((task) => task.title),
        tc.want,
      );
      for (const tk of got) {
        assert.notEqual(tk.fields, undefined, `task ${tk.id} has no fields`);
        assert.notEqual(tk.tags, undefined, `task ${tk.id} has no tags`);
      }
    });
  }
});

// A remote store pays a latency for every request, so the number of round
// trips a command costs is part of the contract rather than an optimisation
// detail. A listing reads its candidates, their tags and the tree it needs
// for availability and tree order in one pipeline.
test('a listing is one round trip', async (t) => {
  const { store: s, fake } = await openStore(t);
  await s.add(newTestTask(idA, 'a task'));
  const before = fake.seen().length;
  await s.list(new Filter({ availability: 'available' }));
  assert.equal(fake.seen().length - before, 1, 'list made more than one request');
});

// A write is two: one that reads the tree the placement rules are decided
// against, and one that carries every statement of the change. There is no
// transaction over the wire, so the decision has to be made before anything
// is sent — but it must not cost more than one request either.
test('a write is two round trips', async (t) => {
  const { store: s, fake } = await openStore(t);
  const stored = newTestTask(idA, 'a task');
  stored.setTags(['home', 'errand']);

  let before = fake.seen().length;
  await s.add(stored);
  assert.equal(fake.seen().length - before, 2, 'add made more than two requests');

  stored.title = 'edited';
  before = fake.seen().length;
  await s.update(stored);
  assert.equal(
    fake.seen().length - before,
    2,
    'update made more than two requests',
  );

  const got = await s.get(idA);
  assert.deepEqual(got.tags, ['errand', 'home']);
});

test('creation order is the order of generated ids', async (t) => {
  const { store: s } = await openStore(t);

  const want: string[] = [];
  for (let i = 0; i < 5; i++) {
    const taskID = id.New();
    want.push(taskID);
    await s.add(newTestTask(taskID, 't'));
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }

  const got = await s.list(new Filter());
  assert.deepEqual(
    got.map((tk) => tk.id),
    want,
  );
});

test('update', async (t) => {
  const { store: s } = await openStore(t);

  const original = newTestTask(idA, 'write the provider', { [KeyPriority]: 1 });
  await s.add(original);

  const edited = original.clone();
  edited.title = 'write the provider tests';
  edited.updatedAt = new Date(original.updatedAt.getTime() + 3_600_000);
  edited.setStatus(StatusDone, edited.updatedAt);
  edited.fields[KeyPriority] = 3;
  edited.fields['owner'] = 'sam';
  await s.update(edited);

  const got = await s.get(idA);
  assert.equal(got.title, edited.title);
  assert.equal(got.status, StatusDone);
  assert.deepEqual(got.fields, edited.fields);

  const err = await s.update(newTestTask(idC, 'never stored')).then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.ok(isNotFound(err), String(err));
});

test('purge', async (t) => {
  const { store: s } = await openStore(t);
  await s.add(newTestTask(idA, 'temporary'));
  await s.purge(idA);
  assert.ok(
    isNotFound(
      await s.get(idA).then(
        () => undefined,
        (e: unknown) => e,
      ),
    ),
  );
  assert.ok(
    isNotFound(
      await s.purge(idA).then(
        () => undefined,
        (e: unknown) => e,
      ),
    ),
  );
});

// Only `tdo init` may create a store. openExisting against a database that
// holds no schema must fail, and must leave nothing behind: a read-only
// command that quietly created a second, empty task list would look exactly
// like the real one.
test('openExisting without a schema creates nothing', async (t) => {
  const fake = await newFakeServer(t);

  const err = await openExisting(fake.config()).then(
    async (s) => {
      await s.close();
      return undefined;
    },
    (e: unknown) => e,
  );
  assert.ok(
    isNotInitialized(err),
    `openExisting() error = ${String(err)}, want not-initialized`,
  );
  assertNoDriverLeak(err);

  // Nothing was created: the engine still has no tables, and every
  // statement that reached it was a read.
  const row = fake.db
    .prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'`)
    .get() as { n: number };
  assert.equal(row.n, 0, 'openExisting created a table; it must create nothing');
  for (const req of fake.seen()) {
    assert.ok(
      !req.body.toUpperCase().includes('CREATE '),
      `openExisting sent a CREATE statement: ${req.body}`,
    );
  }
});

test('openExisting on an initialized database', async (t) => {
  const { fake } = await openStore(t);

  const s = await openExisting(fake.config());
  t.after(() => s.close());
  await s.add(newTestTask(idA, 'usable'));
});

// Every task method reports an uninitialized database as such, rather than
// passing the engine's "no such table: tasks" on to the user.
test('every method reports an uninitialized database', async (t) => {
  const fake = await newFakeServer(t);
  const s = open(fake.config());
  t.after(() => s.close());

  const ops: [string, () => Promise<unknown>][] = [
    ['get', () => s.get(idA)],
    ['findByPrefix', () => s.findByPrefix('01J3')],
    ['list', () => s.list(new Filter())],
    ['update', () => s.update(newTestTask(idA, 'nope'))],
    ['purge', () => s.purge(idA)],
    ['purgeSubtree', () => s.purgeSubtree(idA)],
    ['add', () => s.add(newTestTask(idA, 'nope'))],
    ['move', () => s.move(idA, '', 0, testNow)],
    ['children', () => s.children('')],
    ['subtree', () => s.subtree(idA)],
    ['availability', () => s.availability(testNow, idA)],
    ['tags', () => s.tags()],
    ['setTagStatus', () => s.setTagStatus('home', 'on_hold', testNow)],
    ['renameTag', () => s.renameTag('home', 'house', testNow)],
    ['removeTag', () => s.removeTag('home')],
    ['perspectives', () => s.perspectives()],
    ['perspective', () => s.perspective('next')],
    [
      'savePerspective',
      () =>
        s.savePerspective({
          name: 'next',
          filter: new Filter(),
          createdAt: testNow,
          updatedAt: testNow,
        }),
    ],
    ['deletePerspective', () => s.deletePerspective('next')],
  ];
  for (const [name, run] of ops) {
    const err = await run().then(
      () => undefined,
      (e: unknown) => e,
    );
    assert.ok(
      isNotInitialized(err),
      `${name}() error = ${String(err)}, want not-initialized`,
    );
    assertNoDriverLeak(err);
  }
});

/** wraps reports whether err, or anything it wraps, is the sentinel want. */
function wraps(err: unknown, want: Error): boolean {
  let cur: unknown = err;
  const seen = new Set<unknown>();
  while (cur !== null && cur !== undefined && !seen.has(cur)) {
    if (cur === want) {
      return true;
    }
    seen.add(cur);
    cur = typeof cur === 'object' && 'cause' in cur ? cur.cause : undefined;
  }
  return false;
}

// A method called after close reports it instead of dereferencing nothing.
// The sentinel is carried as the cause, the way every sentinel in this tree
// is, so a caller asks with the chain and not with equality.
test('methods after close report the closed store', async (t) => {
  const { store: s } = await openStore(t);
  await s.close();
  for (const run of [() => s.get(idA), () => s.init()]) {
    const err = await run().then(
      () => undefined,
      (e: unknown) => e,
    );
    assert.ok(wraps(err, errClosed), String(err));
  }
});

// The provider satisfies the interface the command layer holds, and nothing
// provider-specific has to cross it.
test('a Store is a core Store', async (t) => {
  const { store } = await openStore(t);
  const asInterface: CoreStore = store;
  assert.equal(typeof asInterface.describe(), 'string');
});

// The fake server is a test fixture, so it carries its own tests: a stub that
// drifts from the engine would make every assertion built on it meaningless.

test('the fake server executes statements on a real engine', async (t) => {
  const { store, fake } = await openStore(t);
  await store.add(newTestTask(idA, 'a task'));

  // The row is really in SQLite, not in a map the fake kept.
  const rows = fake.db.prepare('SELECT id, title FROM tasks').all();
  assert.equal(rows.length, 1);
  assert.equal((rows[0] as { id: string }).id, idA);
  assert.equal((rows[0] as { title: string }).title, 'a task');
});

test('the fake server answers the pipeline endpoint and nothing else', async (t) => {
  const fake = await newFakeServer(t);
  const resp = await fetch(fake.url + '/v1/organizations');
  assert.equal(resp.status, 404);
  await resp.text();
});
