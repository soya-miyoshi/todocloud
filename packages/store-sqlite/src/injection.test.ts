import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isAmbiguous, isExists, isNotFound } from '@todocloud/core/store';
import { Filter } from '@todocloud/core/store/filter';
import { type Fields, type JSONValue } from '@todocloud/core/task';

import { pushDown } from './query.ts';
import {
  errorText,
  idA,
  idB,
  idB2,
  idC,
  newTask,
  openStore,
  rejects,
} from './testsupport.ts';

// Everything this layer writes comes from a user file or a command line, and
// all of it goes through placeholders. These tests drive the values that would
// break a store that built SQL by concatenation, and the LIKE metacharacters
// that the one hand-written pattern in this package has to escape.

/** assertNoDriverLeak fails when an error quotes SQL or the driver at the user. */
function assertNoDriverLeak(err: unknown): void {
  if (err === undefined || err === null) {
    return;
  }
  const msg = errorText(err);
  for (const leak of [
    'SQL logic error',
    'syntax error',
    'SQLITE_',
    'ERR_SQLITE_',
    'near "',
  ]) {
    assert.ok(!msg.includes(leak), `the error leaks the driver: ${msg}`);
  }
}

/** hostileFieldValues are the field values that must be stored verbatim. */
function hostileFieldValues(): Fields {
  return {
    'key "with" a quote': 'value',
    'key\\with\\backslash': 'value\\with\\backslash',
    'key\nwith\na\nline': 'value\nwith\na\nline',
    'key%with_wildcards': '100%_done',
    "'; DROP TABLE tasks": "'; DROP TABLE tasks; --",
    'nul\u0000key': 'nul\u0000value',
    'tab\tkey': 'tab\tvalue',
    [('k' as string).repeat(1000)]: 'a thousand-character key',
  };
}

test('field keys and values are stored verbatim', async (t) => {
  const s = await openStore(t);

  const fields = hostileFieldValues();
  await s.add(
    newTask(idA, `title '; DROP TABLE tasks; --`, { ...fields }),
  );

  const got = await s.get(idA);
  assert.equal(got.title, `title '; DROP TABLE tasks; --`);
  assert.deepEqual(got.fields, fields, 'fields did not round trip');

  // The table is still there and still holds exactly the one task.
  const all = await s.list(new Filter({ includeDeleted: true }));
  assert.equal(all.length, 1, `the store holds ${all.length} task(s), want 1`);
});

test('large and deeply nested field values', async (t) => {
  const s = await openStore(t);

  // A megabyte in one value.
  const big = 'A'.repeat(1 << 20);
  // Sixty-four levels of nesting.
  let nested: JSONValue = 'bottom';
  for (let i = 0; i < 64; i++) {
    nested = { level: nested };
  }
  const fields: Fields = { big, nested, list: [1, 2, 3] };

  await s.add(newTask(idA, 'large fields', { ...fields }));
  const got = await s.get(idA);
  assert.equal(
    (got.fields['big'] as string).length,
    big.length,
    'the large value did not come back at its full length',
  );
  let depth = 0;
  for (
    let cur: JSONValue | undefined = got.fields['nested'];
    typeof cur === 'object' && cur !== null && !Array.isArray(cur);
    depth++
  ) {
    cur = cur['level'];
  }
  assert.equal(depth, 64, 'the nested value did not come back 64 levels deep');
});

// findByPrefix builds the only LIKE pattern in the package. A prefix holding
// %, _ or \ must match literally, so a prefix that is all wildcards matches
// nothing rather than everything.
test('findByPrefix escapes the LIKE metacharacters', async (t) => {
  const s = await openStore(t);

  for (const taskID of [idA, idB, idC]) {
    await s.add(newTask(taskID, `task ${taskID}`));
  }

  for (const prefix of [
    '%',
    '_',
    '\\',
    '%%',
    '01J3%',
    '01J3_',
    '01J3\\',
    '0%A',
    '_1J3',
  ]) {
    const err = await rejects(
      s.findByPrefix(prefix),
      isNotFound,
      `findByPrefix(${JSON.stringify(prefix)}) must match nothing: the wildcard has to be escaped`,
    );
    assertNoDriverLeak(err);
  }

  // An ordinary prefix still works, and an ambiguous one is still ambiguous.
  assert.equal((await s.findByPrefix('01J3A')).id, idA);
  await s.add(newTask(idB2, 'another'));
  await rejects(
    s.findByPrefix('01J3B'),
    isAmbiguous,
    'findByPrefix("01J3B") must be ambiguous',
  );
});

// An escaped prefix must not match an id that only a wildcard reading of it
// would reach. These ids exist purely so that a broken escape has something to
// match.
test('findByPrefix does not match through a wildcard', async (t) => {
  const s = await openStore(t);
  for (const taskID of [idA, idB, idC]) {
    await s.add(newTask(taskID, 'task'));
  }
  // "01J3%BCDEFGHJKMNPQRSTVWXYZ" is idB's shape with a literal % where the
  // discriminating character is: as a LIKE pattern it would match every id,
  // as a literal prefix it matches none.
  for (const prefix of [
    '01J3%BCDEFGHJKMNPQRSTVWXYZ',
    '01J3_BCDEFGHJKMNPQRSTVWXYZ',
    '01J3%',
    '%1J3ABCDEFGHJKMNPQRSTVWXYZ',
  ]) {
    await rejects(
      s.findByPrefix(prefix),
      isNotFound,
      `findByPrefix(${JSON.stringify(prefix)}) must match nothing`,
    );
  }
});

// get, update and purge take an id straight from the caller. A quote, a
// wildcard or a NUL in it is a value, never SQL: the row is simply not there.
test('get, update and purge with a hostile id', async (t) => {
  const s = await openStore(t);
  await s.add(newTask(idA, 'the real task'));

  for (const taskID of [
    `' OR '1'='1`,
    `'; DROP TABLE tasks; --`,
    `" OR 1=1 --`,
    '%',
    'nul\u0000id',
    'Z'.repeat(4096),
  ]) {
    const label = JSON.stringify(taskID).slice(0, 40);
    assertNoDriverLeak(
      await rejects(s.get(taskID), isNotFound, `get(${label})`),
    );
    assertNoDriverLeak(
      await rejects(
        s.update(newTask(taskID, 'forged')),
        isNotFound,
        `update(${label})`,
      ),
    );
    assertNoDriverLeak(
      await rejects(s.purge(taskID), isNotFound, `purge(${label})`),
    );
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
// ErrExists rather than as the driver's constraint message.
test('add normalizes the id the same way lookups do', async (t) => {
  const s = await openStore(t);
  const lower = idA.toLowerCase();

  await s.add(newTask(lower, 'stored under a lower-cased id'));

  // Found by the id as written, by its canonical form, and by a prefix.
  for (const ref of [lower, idA]) {
    const got = await s.get(ref);
    assert.equal(
      got.id,
      idA,
      `get(${ref}) must return the canonical spelling of the id`,
    );
  }
  assert.equal((await s.findByPrefix(idA.slice(0, 8))).id, idA);

  // A duplicate is the sentinel, and the driver's message never reaches it:
  // `tdo import` turns this into a skip.
  const err = await rejects(
    s.add(newTask(lower, 'again')),
    isExists,
    'add of a duplicate id must report ErrExists',
  );
  assert.ok(
    !errorText(err).toUpperCase().includes('UNIQUE CONSTRAINT'),
    `the driver's constraint message reached the caller: ${errorText(err)}`,
  );

  // update addresses it by either spelling too. A row stored canonically
  // that could not be updated by the spelling it was added under would be
  // readable and uncompletable at the same time.
  await s.update(newTask(lower, 'edited through the lower-cased id'));
  assert.equal(
    (await s.get(idA)).title,
    'edited through the lower-cased id',
  );

  // purge addresses it by either spelling.
  await s.purge(lower);
});

// The clause allow-list is the mechanism behind all of the above for the one
// part of the SQL that is assembled rather than written out: the filter
// push-down. These two tests pin it directly, because a future edit that
// interpolates a value would otherwise only be caught by whichever filter
// test happened to exercise that clause.
test('every push-down clause binds its values and names no caller text', async (t) => {
  const s = await openStore(t);
  await s.add(newTask(idA, 'one'));

  const f = new Filter({
    kinds: ['task', 'project'],
    statuses: ['active', 'on_hold'],
    flagged: true,
    scope: { children: true, parentID: idA },
    tags: ["home'; DROP TABLE tasks; --", 'work'],
    deferBefore: new Date('2026-01-01T00:00:00Z'),
    deferAfter: new Date('2025-01-01T00:00:00Z'),
    dueBefore: new Date('2026-01-01T00:00:00Z'),
    dueAfter: new Date('2025-01-01T00:00:00Z'),
    hasDue: true,
    includeDeleted: true,
  });
  const { where, args } = pushDown(f);

  // Nothing a caller typed is in the SQL, and every clause's placeholders are
  // accounted for by the values bound beside it.
  const sql = where.join(' AND ');
  for (const typed of ['DROP TABLE', idA, 'home', 'work', '2026-01-01']) {
    assert.ok(
      !sql.includes(typed),
      `${JSON.stringify(typed)} reached the SQL text: ${sql}`,
    );
  }
  assert.equal(
    sql.split('?').length - 1,
    args.length,
    'the number of placeholders must equal the number of bound values',
  );

  // And the filter still runs: a push-down that cannot be executed is not a
  // safe push-down, it is a broken one.
  assert.deepEqual(await s.list(f), []);
});

test('a clause that is not in the allow-list is refused rather than executed', () => {
  // The allow-list is private, so it is reached the way a future mistake
  // would reach it: through a filter value that would have to become SQL. A
  // kind is a defined string type, so a newer binary — or a hand-edited
  // perspective — can carry anything in it, and the kinds clause must still
  // be the IN list with that value bound.
  const f = new Filter({ kinds: ["task') OR 1=1 --"] });
  const { where, args } = pushDown(f);
  assert.deepEqual(where, ['deleted_at IS NULL', 'kind IN (?)']);
  assert.deepEqual(args, ["task') OR 1=1 --"]);
});
