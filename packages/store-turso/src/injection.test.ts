import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isAmbiguous, isNotFound } from '@todocloud/core/store';
import { Filter } from '@todocloud/core/store/filter';
import { Fields, type Fields as FieldMap } from '@todocloud/core/task';

import {
  idA,
  idB,
  idB2,
  idC,
  newTestTask,
  openStore,
  testToken,
} from './fakeserver.test.ts';

// Everything this layer writes comes from a user file or a command line, and
// all of it is bound as a typed protocol argument rather than pasted into
// SQL. These tests drive the values that would break a store that built SQL
// by concatenation, and the LIKE metacharacters that the one hand-written
// pattern in this package has to escape. They are the sqlite provider's
// tests, applied to the remote provider, because the behaviour is supposed to
// be indistinguishable.

/**
 * assertNoDriverLeak fails when an error quotes SQL or the remote engine at
 * the user.
 */
export function assertNoDriverLeak(err: unknown): void {
  if (err === undefined || err === null) {
    return;
  }
  const msg = err instanceof Error ? err.message : String(err);
  for (const leak of [
    'SQL logic error',
    'syntax error',
    'SQLITE_',
    'node:sqlite',
    'near "',
    'no such table',
    'UNIQUE constraint',
  ]) {
    assert.ok(!msg.includes(leak), `the error leaks the engine: ${msg}`);
  }
  // The token must not reach an error message under any circumstances.
  assert.ok(!msg.includes(testToken), `the error leaks the credential: ${msg}`);
}

/** hostileFieldValues are the field values that must be stored verbatim. */
function hostileFieldValues(): FieldMap {
  return {
    'key "with" a quote': 'value',
    'key\\with\\backslash': 'value\\with\\backslash',
    'key\nwith\na\nline': 'value\nwith\na\nline',
    'key%with_wildcards': '100%_done',
    "'; DROP TABLE tasks": "'; DROP TABLE tasks; --",
    'nul\u0000key': 'nul\u0000value',
    'tab\tkey': 'tab\tvalue',
    'unicode †key': 'emoji 🙂 value',
    ['k'.repeat(1000)]: 'a thousand-character key',
  };
}

test('field keys and values are stored verbatim', async (t) => {
  const { store: s } = await openStore(t);

  const fields = hostileFieldValues();
  await s.add(
    newTestTask(idA, `title '; DROP TABLE tasks; --`, Fields.clone(fields)),
  );

  const got = await s.get(idA);
  assert.equal(got.title, `title '; DROP TABLE tasks; --`);
  assert.deepEqual(got.fields, fields, 'fields did not round trip');

  // The table is still there and still holds exactly the one task.
  const all = await s.list(new Filter());
  assert.equal(all.length, 1, `the store holds ${all.length} task(s), want 1`);
});

test('large and deeply nested field values', async (t) => {
  const { store: s } = await openStore(t);

  // A megabyte in one value.
  const big = 'A'.repeat(1 << 20);
  // Sixty-four levels of nesting.
  let nested: unknown = 'bottom';
  for (let i = 0; i < 64; i++) {
    nested = { level: nested };
  }
  const fields: FieldMap = {
    big,
    nested: nested as FieldMap,
    list: [1, 2, 3],
    // A whole number at the edge of what JavaScript keeps exactly, inside a
    // list, to prove the integer rule holds at depth as well as at the top
    // level. Go used the int64 edges; a number is a double here, so the
    // safe-integer boundary is the edge that exists.
    edges: [Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 0],
  };

  await s.add(newTestTask(idA, 'large fields', Fields.clone(fields)));
  const got = await s.get(idA);
  assert.equal(Fields.string(got.fields, 'big')?.length, big.length);
  let depth = 0;
  let cur: unknown = got.fields['nested'];
  while (typeof cur === 'object' && cur !== null && !Array.isArray(cur)) {
    cur = (cur as Record<string, unknown>)['level'];
    depth++;
  }
  assert.equal(depth, 64, `the nested value came back ${depth} level(s) deep`);
  assert.deepEqual(got.fields['edges'], [
    Number.MAX_SAFE_INTEGER,
    Number.MIN_SAFE_INTEGER,
    0,
  ]);
});

// findByPrefix builds the only LIKE pattern in the package. A prefix holding
// %, _ or \ must match literally, so a prefix that is all wildcards matches
// nothing rather than everything.
test('findByPrefix escapes LIKE metacharacters', async (t) => {
  const { store: s } = await openStore(t);

  for (const taskID of [idA, idB, idC]) {
    await s.add(newTestTask(taskID, 'task ' + taskID));
  }

  for (const prefix of ['%', '_', '\\', '%%', '01J3%', '01J3_', '01J3\\', '0%A', '_1J3']) {
    const result = await s.findByPrefix(prefix).then(
      (got) => got,
      (e: unknown) => e,
    );
    assert.ok(
      isNotFound(result),
      `findByPrefix(${prefix}) = ${String(result)}; the wildcard was not escaped`,
    );
    assertNoDriverLeak(result);
  }

  // An ordinary prefix still works, and an ambiguous one is still ambiguous.
  assert.equal((await s.findByPrefix('01J3A')).id, idA);
  await s.add(newTestTask(idB2, 'another'));
  assert.ok(
    isAmbiguous(
      await s.findByPrefix('01J3B').then(
        () => undefined,
        (e: unknown) => e,
      ),
    ),
  );
});

// An escaped prefix must not match an id that only a wildcard reading of it
// would reach. These ids exist purely so that a broken escape has something
// to match.
test('findByPrefix does not match through a wildcard', async (t) => {
  const { store: s } = await openStore(t);
  for (const taskID of [idA, idB, idC]) {
    await s.add(newTestTask(taskID, 'task'));
  }
  for (const prefix of [
    '01J3%BCDEFGHJKMNPQRSTVWXYZ',
    '01J3_BCDEFGHJKMNPQRSTVWXYZ',
    '01J3%',
    '%1J3ABCDEFGHJKMNPQRSTVWXYZ',
  ]) {
    const result = await s.findByPrefix(prefix).then(
      (got) => got,
      (e: unknown) => e,
    );
    assert.ok(isNotFound(result), `findByPrefix(${prefix}) = ${String(result)}`);
  }
});

// get, update and purge take an id straight from the caller. A quote or a
// wildcard in it is a value, never SQL: the row is simply not there.
test('get, update and purge with a hostile id', async (t) => {
  const { store: s } = await openStore(t);
  await s.add(newTestTask(idA, 'the real task'));

  for (const taskID of [
    `' OR '1'='1`,
    `'; DROP TABLE tasks; --`,
    `" OR 1=1 --`,
    '%',
    'nul\u0000id',
    'Z'.repeat(4096),
  ]) {
    for (const [name, run] of [
      ['get', () => s.get(taskID)],
      ['update', () => s.update(newTestTask(taskID, 'forged'))],
      ['purge', () => s.purge(taskID)],
    ] as [string, () => Promise<unknown>][]) {
      const err = await run().then(
        () => undefined,
        (e: unknown) => e,
      );
      assert.ok(
        isNotFound(err),
        `${name}(${JSON.stringify(taskID)}) = ${String(err)}, want not-found`,
      );
      assertNoDriverLeak(err);
    }
  }

  // The real task is untouched by all of that.
  const got = await s.get(idA);
  assert.equal(got.title, 'the real task');
  const all = await s.list(new Filter({ includeDeleted: true }));
  assert.equal(all.length, 1, `the store holds ${all.length} task(s), want 1`);
});

// Base32 is case-insensitive, so a ULID written in lower case is the same id
// written differently. add normalizes it the way every lookup does, which is
// what keeps a row addressable by its own id, and a duplicate is reported as
// ErrExists rather than as the engine's constraint message.
test('add normalizes the id the same way lookups do', async (t) => {
  const { store: s } = await openStore(t);
  const lower = idA.toLowerCase();

  await s.add(newTestTask(lower, 'stored under a lower-cased id'));

  // Found by the id as written, by its canonical form, and by a prefix.
  for (const ref of [lower, idA]) {
    const got = await s.get(ref);
    assert.equal(got.id, idA, `get(${ref}) returned a non-canonical id`);
  }
  assert.equal((await s.findByPrefix(idA.slice(0, 8))).id, idA);

  // A duplicate is the sentinel, and the engine's message never reaches it:
  // `tdo import` turns this into a skip.
  const err = await s.add(newTestTask(lower, 'again')).then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.ok(
    (err as Error | undefined) !== undefined &&
      /already exists/.test((err as Error).message),
    `add of a duplicate id = ${String(err)}`,
  );
  assert.ok(
    !(err as Error).message.toUpperCase().includes('UNIQUE CONSTRAINT'),
    `the engine's constraint message reached the caller: ${String(err)}`,
  );

  // update addresses it by either spelling too. A row stored canonically
  // that could not be updated by the spelling it was added under would be
  // readable and uncompletable at the same time.
  await s.update(newTestTask(lower, 'edited through the lower-cased id'));
  assert.equal(
    (await s.get(idA)).title,
    'edited through the lower-cased id',
  );

  // purge addresses it by either spelling.
  await s.purge(lower);
});
