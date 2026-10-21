// `tdo export` and `tdo import`, ported from the parts of
// transfer_perspectives_test.go, import_ids_test.go, export_cache_test.go and
// import_adversarial_test.go that cover these two commands.
//
// The tests that drove the file through `tdo add` and `tdo ls` write to the
// store directly instead, so that this file does not depend on which other
// commands have been ported.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';

import * as exit from '@todocloud/core/exit';
import * as id from '@todocloud/core/id';
import { Filter } from '@todocloud/core/store/filter';
import { newTask } from '@todocloud/core/task';

import { perspectiveCommand } from './repeat.ts';
import { showCommand } from './show.ts';
import { exportCommand, forTest, importCommand } from './transfer.ts';
import { type Harness, newHarness } from './testsupport.ts';

function harness(t: TestContext): Promise<Harness> {
  return newHarness(t, [exportCommand, importCommand, perspectiveCommand, showCommand]);
}

/** write puts a file in the harness's temporary directory and names it. */
function write(h: Harness, name: string, body: string): string {
  const file = path.join(h.dir, name);
  fs.writeFileSync(file, body, { mode: 0o600 });
  return file;
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

test('export writes the envelope, whether or not --json was given', async (t: TestContext) => {
  const h = await harness(t);
  const task = await h.add('Pay the invoice');

  for (const args of [['export'], ['export', '--json']]) {
    const obj = h.decode(await h.mustRun(...args));
    assert.equal(obj['version'], 1, args.join(' '));
    assert.equal(obj['count'], 1);
    assert.equal(obj['perspective_count'], 0);
    assert.ok(String(obj['store']).length > 0, 'the envelope says which store it copied');
    assert.ok(String(obj['exported_at']).endsWith('Z'));
    const tasks = obj['tasks'] as Record<string, unknown>[];
    assert.equal(tasks[0]?.['id'], task.id);
  }
});

// A backup is everything, whatever its status: filtering a backup is how a
// restore quietly loses the history. --all adds the tombstones.
test('export leaves tombstones out unless --all asks for them', async (t: TestContext) => {
  const h = await harness(t);
  const live = await h.add('still here');
  const gone = await h.add('tombstoned');
  await h.withStore(async (st) => {
    const t2 = (await st.get(gone.id)).clone();
    t2.deletedAt = new Date();
    await st.update(t2);
  });

  assert.equal(h.decode(await h.mustRun('export'))['count'], 1);
  const all = h.decode(await h.mustRun('export', '--all'));
  assert.equal(all['count'], 2);
  const ids = (all['tasks'] as Record<string, unknown>[]).map((row) => row['id']);
  assert.deepEqual(ids.sort(), [live.id, gone.id].sort());
});

test('export --csv writes the documented columns', async (t: TestContext) => {
  const h = await harness(t);
  const task = await h.add('Pay the invoice');

  const res = await h.mustRun('export', '--csv');
  const records = forTest.readCSV(res.stdout);
  assert.deepEqual(records[0], [...forTest.csvHeader]);
  assert.equal(records.length, 2);
  assert.equal(records[1]?.[0], task.id);
  assert.equal(records[1]?.[2], 'Pay the invoice');
  // The last column is the open map, rendered as JSON so the round trip is
  // lossless.
  assert.equal(records[1]?.[forTest.csvHeader.length - 1], '{}');
});

test('export takes no arguments', async (t: TestContext) => {
  const h = await harness(t);
  const res = await h.run('export', 'junk');
  assert.equal(res.code, exit.Usage, res.stderr);
});

// `tdo export` is machine output — a JSON envelope or CSV, whether or not
// --json was passed — so nobody reads numbers off it. Taking a backup must
// not change what `tdo done 2` means for whoever is reading the terminal, and
// with no listing at all it must not invent numbers either.
test('export does not create numbers out of nothing', async (t: TestContext) => {
  const h = await harness(t);
  await h.add('only task');
  await h.mustRun('export', '--all');

  const got = await h.run('show', '1');
  assert.equal(got.code, exit.NotFound, `export populated the cache: ${got.stderr}`);
  assert.match(got.stderr, /tdo ls/);
});

// The other half of the same rule: a listing a human read already assigned
// the numbers, and several exports in both forms must leave them exactly as
// they were. This one drives the real `tdo ls`, because the cache it installs
// is what is under test, so it takes the whole registry rather than this
// file's own table.
test('export does not touch the number cache', async (t: TestContext) => {
  const h = await newHarness(t);
  await h.mustRun('add', 'first');
  await h.mustRun('add', 'second');

  // A human listing assigns the numbers.
  await h.mustRun('ls');
  const before = h.taskOf(await h.mustRun('show', '1', '--json'));

  // Several exports, in both forms and with a different row set.
  await h.mustRun('export');
  await h.mustRun('export', '--all');
  await h.mustRun('export', '--csv');
  await h.mustRun('export', '--json');

  const after = h.taskOf(await h.mustRun('show', '1', '--json'));
  assert.equal(
    after['id'],
    before['id'],
    `export renumbered the listing: task 1 went from ${String(before['id'])} to ${String(after['id'])}`,
  );
});

// ---------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------

/** A hand-written envelope, the shape a program would generate. */
function envelope(tasks: string): string {
  return `{"tasks":[${tasks}]}`;
}

/** taskJSON is one task as an import file carries it. */
function taskJSON(fields: Record<string, unknown>): string {
  return JSON.stringify({
    kind: 'task',
    status: 'active',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...fields,
  });
}

// An import file is something a user can hand-edit and a program can
// generate, so it is untrusted input. Ids must still be ULIDs: reference
// resolution matches by prefix and listings rely on ids sorting into creation
// order.
test('import rejects an id that is not a ULID', async (t: TestContext) => {
  const h = await harness(t);
  const file = write(
    h,
    'tasks.json',
    envelope(taskJSON({ id: '../../etc/passwd', title: 'forged' })),
  );

  const got = await h.run('import', file);
  assert.equal(got.code, exit.Usage, got.stderr);
  assert.match(got.stderr, /--new-ids/);

  // Nothing may have been stored.
  const stored = await h.withStore((st) => st.list(new Filter({ includeDeleted: true })));
  assert.equal(stored.length, 0, 'a task was stored despite the rejection');
});

// --new-ids is how data from another tool gets in: the ids are replaced
// rather than trusted.
test('import --new-ids assigns real ULIDs and keeps the open fields', async (t: TestContext) => {
  const h = await harness(t);
  const file = write(
    h,
    'tasks.json',
    envelope(
      [
        taskJSON({ id: '1', title: 'from another tool', client: 'acme' }),
        taskJSON({ id: '2', title: 'and another' }),
      ].join(','),
    ),
  );

  const got = await h.mustRun('import', file, '--new-ids', '--json');
  assert.equal(h.decode(got)['imported'], 2);

  const stored = await h.withStore((st) => st.list(new Filter({ includeDeleted: true })));
  assert.equal(stored.length, 2);
  for (const t2 of stored) {
    assert.ok(id.Valid(t2.id), `stored id ${t2.id} is not a ULID`);
  }
  // The user-defined field must survive re-identification.
  assert.ok(
    stored.some((t2) => t2.fields['client'] === 'acme'),
    'the user-defined field was lost',
  );
});

// A file `tdo export` wrote must keep working untouched, ids included:
// importing into the same store is a no-op, which proves the ids were kept
// rather than regenerated.
test('import keeps exported ids, so a re-import is a no-op', async (t: TestContext) => {
  const h = await harness(t);
  await h.add('Pay the invoice');
  const exported = await h.mustRun('export', '--all');
  const file = write(h, 'export.json', exported.stdout);

  const got = h.decode(await h.mustRun('import', file, '--json'));
  assert.equal(got['imported'], 0, 'the exported id was not kept');
  assert.equal(got['skipped'], 1);
});

test('import round-trips a CSV export, tags and open fields included', async (t: TestContext) => {
  const h = await harness(t);
  await h.withStore(async (st) => {
    const t2 = newTask(id.New(), 'task', 'Buy milk, and bread', new Date());
    t2.status = 'active';
    t2.setTags(['home', 'errand']);
    t2.fields['owner'] = 'ana';
    t2.note = 'a note\nwith a newline';
    await st.add(t2);
  });
  const csv = (await h.mustRun('export', '--csv')).stdout;

  // A second store, so the import has to rebuild the row rather than skip it.
  const other = await harness(t);
  const file = write(other, 'tasks.csv', csv);
  assert.equal(h.decode(await other.mustRun('import', file, '--json'))['imported'], 1);

  const stored = await other.withStore((st) => st.list(new Filter({})));
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.title, 'Buy milk, and bread');
  assert.deepEqual(stored[0]?.tags.slice().sort(), ['errand', 'home']);
  assert.equal(stored[0]?.fields['owner'], 'ana');
  assert.equal(stored[0]?.note, 'a note\nwith a newline');
});

test('import accepts a bare array and a byte-order mark', async (t: TestContext) => {
  const h = await harness(t);
  const file = write(
    h,
    'bare.json',
    '﻿  [' + taskJSON({ id: id.New(), title: 'from a bare array' }) + ']',
  );
  assert.equal(h.decode(await h.mustRun('import', file, '--json'))['imported'], 1);
});

test('import rejects a file it cannot read or make sense of', async (t: TestContext) => {
  const h = await harness(t);
  const cases: [string, string][] = [
    ['empty.json', ''],
    ['whitespace.json', '   \n\t'],
    ['noTasks.json', '{"count":0}'],
    ['brokenJSON.json', '{"tasks":[}'],
    ['notAnArray.json', '{"tasks":{}}'],
    ['csvNoHeader.csv', 'id,title\n'.replace('id,title\n', 'kind,status\nx,y\n')],
  ];
  for (const [name, body] of cases) {
    const file = write(h, name, body);
    const res = await h.run('import', file);
    assert.equal(res.code, exit.Usage, `${name}: exit ${res.code}\n${res.stderr}`);
    assert.notEqual(res.stderr.trim(), '', `${name} said nothing`);
  }
  // A file that is not there at all is the user's mistake at the command
  // line, not a provider failure.
  const missing = await h.run('import', path.join(h.dir, 'nope.json'));
  assert.equal(missing.code, exit.Usage, missing.stderr);
  assert.equal((await h.run('import')).code, exit.Usage);
  assert.equal((await h.run('import', 'a', 'b')).code, exit.Usage);
});

// A JSON null in the tasks array must be reported by position, not crash
// halfway through and leave the store holding part of the file.
test('import rejects a null task without storing anything', async (t: TestContext) => {
  const h = await harness(t);
  const file = write(
    h,
    'tasks.json',
    envelope([taskJSON({ id: id.New(), title: 'first' }), 'null'].join(',')),
  );

  const res = await h.run('import', file);
  assert.equal(res.code, exit.Usage, res.stderr);
  assert.match(res.stderr, /task 2 is null/);
  const stored = await h.withStore((st) => st.list(new Filter({ includeDeleted: true })));
  assert.equal(stored.length, 0, 'the first task was stored before the file was rejected');
});

// Base32 is case-insensitive, so a lower-cased id is a real id written
// differently; storing it verbatim would make it unreachable.
test('import normalises a lower-cased id and then skips it', async (t: TestContext) => {
  const h = await harness(t);
  const task = await h.add('Pay the invoice');
  const file = write(
    h,
    'tasks.json',
    envelope(taskJSON({ id: task.id.toLowerCase(), title: 'Pay the invoice' })),
  );

  const got = h.decode(await h.mustRun('import', file, '--json'));
  assert.equal(got['imported'], 0);
  assert.equal(got['skipped'], 1);
});

test('import skips a duplicate id inside one file', async (t: TestContext) => {
  const h = await harness(t);
  const same = id.New();
  const file = write(
    h,
    'tasks.json',
    envelope(
      [taskJSON({ id: same, title: 'first' }), taskJSON({ id: same, title: 'again' })].join(','),
    ),
  );

  const got = h.decode(await h.mustRun('import', file, '--json'));
  assert.equal(got['imported'], 1);
  assert.equal(got['skipped'], 1);
});

// A child cannot be stored before its parent, because the store checks the
// containment rules of §3.1 as it writes.
test('import stores a parent before its child, whatever the file order', async (t: TestContext) => {
  const h = await harness(t);
  const parent = id.New();
  const child = id.New();
  const file = write(
    h,
    'tasks.json',
    envelope(
      [
        taskJSON({ id: child, title: 'the child', parent_id: parent }),
        taskJSON({ id: parent, kind: 'project', title: 'the project' }),
      ].join(','),
    ),
  );

  assert.equal(h.decode(await h.mustRun('import', file, '--json'))['imported'], 2);
  const stored = await h.withStore((st) => st.list(new Filter({})));
  assert.equal(stored.find((t2) => t2.id === child)?.parentID, parent);
});

// A parent cycle in a hand-written file is refused by the store, and the
// ordering pass must not loop before it gets there.
test('import does not loop on a parent cycle', async (t: TestContext) => {
  const h = await harness(t);
  const a = id.New();
  const b = id.New();
  const file = write(
    h,
    'tasks.json',
    envelope(
      [
        taskJSON({ id: a, kind: 'project', title: 'a', parent_id: b }),
        taskJSON({ id: b, kind: 'project', title: 'b', parent_id: a }),
      ].join(','),
    ),
  );

  const res = await h.run('import', file);
  assert.notEqual(res.code, 0, 'a cycle must be refused');
  assert.notEqual(res.stderr.trim(), '');
});

// ---------------------------------------------------------------------------
// The saved queries an envelope carries alongside the tasks.
// ---------------------------------------------------------------------------

test('export carries the saved perspectives', async (t: TestContext) => {
  const h = await harness(t);
  await h.mustRun('perspective', 'save', 'hot', '--', '--flagged');

  const obj = h.decode(await h.mustRun('export'));
  assert.equal(obj['perspective_count'], 1);
  const ps = obj['perspectives'] as Record<string, unknown>[];
  assert.equal(ps[0]?.['name'], 'hot');
  assert.deepEqual((ps[0]?.['filter'] as Record<string, unknown>)['flagged'], true);
});

test('an export with no perspectives says so rather than omitting the key', async (t: TestContext) => {
  const h = await harness(t);
  const obj = h.decode(await h.mustRun('export'));
  assert.deepEqual(obj['perspectives'], []);
  assert.equal(obj['perspective_count'], 0);
});

// CSV is a task table: a saved query has no row in it, and the note goes to
// stderr because stdout is the CSV.
test('a CSV export says that perspectives are not in it', async (t: TestContext) => {
  const h = await harness(t);
  await h.mustRun('perspective', 'save', 'hot', '--', '--flagged');

  const res = await h.mustRun('export', '--csv');
  assert.match(res.stderr, /not in a CSV export/);
  assert.ok(!res.stdout.includes('hot'), res.stdout);
});

test('import restores the exported perspectives', async (t: TestContext) => {
  const h = await harness(t);
  await h.mustRun('perspective', 'save', 'hot', '--', '--flagged');
  const exported = (await h.mustRun('export')).stdout;

  const other = await harness(t);
  const file = write(other, 'export.json', exported);
  const got = h.decode(await other.mustRun('import', file, '--json'));
  assert.equal(got['perspectives_imported'], 1);
  assert.equal(got['perspectives_skipped'], 0);

  const stored = await other.withStore((st) => st.perspective('hot'));
  assert.equal(stored.filter.flagged, true);
});

// An import adds, it never overwrites: silently replacing a saved query the
// user is still using would be the worse failure, and the count says it
// happened.
test('import skips a perspective whose name is taken', async (t: TestContext) => {
  const h = await harness(t);
  await h.mustRun('perspective', 'save', 'hot', '--', '--flagged');
  const file = write(h, 'export.json', (await h.mustRun('export')).stdout);

  const got = h.decode(await h.mustRun('import', file, '--json'));
  assert.equal(got['perspectives_imported'], 0);
  assert.equal(got['perspectives_skipped'], 1);
});

test('a bad perspective is rejected before anything is written', async (t: TestContext) => {
  const h = await harness(t);
  const file = write(
    h,
    'tasks.json',
    `{"tasks":[${taskJSON({ id: id.New(), title: 'first' })}],` +
      `"perspectives":[{"name":"  ","filter":{}}]}`,
  );

  const res = await h.run('import', file);
  assert.equal(res.code, exit.Usage, res.stderr);
  assert.match(res.stderr, /perspective 1 has no name/);
  const stored = await h.withStore((st) => st.list(new Filter({ includeDeleted: true })));
  assert.equal(stored.length, 0, 'a task was written before the file was rejected');
});

test('one file cannot hold the same perspective name twice', async (t: TestContext) => {
  const h = await harness(t);
  const file = write(
    h,
    'tasks.json',
    `{"tasks":[],"perspectives":[{"name":"hot","filter":{}},{"name":"HOT","filter":{}}]}`,
  );

  const res = await h.run('import', file);
  assert.equal(res.code, exit.Usage, res.stderr);
  assert.match(res.stderr, /is in the file twice/);
});

// A key dropped on the way in produces a *wider* query than the one that was
// saved, so an unknown one is refused rather than ignored.
test('an imported perspective with an unknown filter key is refused', async (t: TestContext) => {
  const h = await harness(t);
  const file = write(
    h,
    'tasks.json',
    `{"tasks":[],"perspectives":[{"name":"hot","filter":{"from_a_newer_tdo":true}}]}`,
  );

  const res = await h.run('import', file);
  assert.equal(res.code, exit.Usage, res.stderr);
  assert.match(res.stderr, /unknown field/);
});

// ---------------------------------------------------------------------------
// The CSV reader, driven directly.
// ---------------------------------------------------------------------------

test('the csv reader keeps a newline and a comma inside a quoted field', () => {
  const records = forTest.readCSV('a,b\r\n"one\ntwo","x,y"\r\n');
  assert.deepEqual(records, [
    ['a', 'b'],
    ['one\ntwo', 'x,y'],
  ]);
});

test('the csv reader reads a doubled quote as one quote', () => {
  assert.deepEqual(forTest.readCSV('"he said ""hi"""\n'), [['he said "hi"']]);
});

test('the csv reader refuses a quoted field that is never closed', () => {
  assert.throws(() => forTest.readCSV('"unterminated\n'), /never closed/);
});

test('decodeImport refuses an empty file by name', () => {
  assert.throws(() => forTest.decodeImport('  '), /the file is empty/);
});
