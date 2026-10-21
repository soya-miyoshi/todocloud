// `tdo edit`: the port of TestEditUnsetAndTagDeduplication and the edit
// cases around it.

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import * as exit from '@todocloud/core/exit';

import { addCommand } from './add.ts';
import type { CommandFactory } from './app.ts';
import { editCommand } from './edit.ts';
import { listCommand } from './list.ts';
import { showCommand } from './show.ts';
import { assertCleanFailure, newHarness } from './testsupport.ts';

const commands: readonly CommandFactory[] = [addCommand, editCommand, listCommand, showCommand];

test('edit replaces what it is given and leaves the rest alone', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const added = h.taskOf(
    await h.mustRun('add', 'Editable', '--note', 'first', '--set', 'client=acme', '--set', 'owner=ana', '--json'),
  );
  const taskID = added['id'] as string;

  const edited = h.taskOf(
    await h.mustRun(
      'edit',
      taskID,
      '--title',
      'Edited',
      '--tag',
      'ops,Ops,finance',
      '--tag',
      'ops',
      '--unset',
      'owner',
      '--json',
    ),
  );
  assert.equal(edited['title'], 'Edited');
  assert.equal(edited['owner'], undefined, '--unset should remove the field');
  assert.equal(edited['note'], 'first', 'an untouched note must survive an edit');
  // The tags are deduplicated case-insensitively and sorted.
  assert.deepEqual(edited['tags'], ['finance', 'ops']);
  assert.equal(edited['client'], 'acme', 'an untouched user-defined field must survive an edit');
});

test('edit expects exactly one reference', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const task = await h.add('Editable');
  for (const args of [['edit', '--title', 'x'], ['edit', task.id, task.id, '--title', 'x']]) {
    const got = await h.run(...args);
    assert.equal(got.code, exit.Usage, args.join(' '));
    assert.match(got.stderr, /edit expects exactly one item reference/);
  }
});

// The difference between `--note ""`, which clears the note, and no --note at
// all, which leaves it alone, is what Context.isSet is for.
test('an empty string clears a field and an absent flag leaves it alone', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const added = h.taskOf(await h.mustRun('add', 'Noted', '--note', 'something', '--json'));
  const taskID = added['id'] as string;

  assert.equal(h.taskOf(await h.mustRun('edit', taskID, '--title', 'Renamed', '--json'))['note'], 'something');
  assert.equal(h.taskOf(await h.mustRun('edit', taskID, '--note', '', '--json'))['note'], null);
});

// Go declared --notes as an alias of --note; the port keeps both spellings.
test('--notes is accepted as the second spelling of --note', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const task = await h.add('Editable');
  assert.equal(h.taskOf(await h.mustRun('edit', task.id, '--notes', 'by the back door', '--json'))['note'],
    'by the back door');
});

test('--untag removes one tag of several', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const added = h.taskOf(await h.mustRun('add', 'Tagged', '--tag', 'home,errand,ops', '--json'));
  const taskID = added['id'] as string;

  // --untag folds case, as every tag comparison does.
  const edited = h.taskOf(await h.mustRun('edit', taskID, '--untag', 'Errand', '--json'));
  assert.deepEqual(edited['tags'], ['home', 'ops']);
});

test('--tag replaces the whole set', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const added = h.taskOf(await h.mustRun('add', 'Tagged', '--tag', 'home,errand', '--json'));
  const edited = h.taskOf(await h.mustRun('edit', added['id'] as string, '--tag', 'ops', '--json'));
  assert.deepEqual(edited['tags'], ['ops']);
});

test('edit writes the estimate and the priority', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const task = await h.add('Estimable');
  const edited = h.taskOf(
    await h.mustRun('edit', task.id, '--estimate', '1h30m', '--priority', '3', '--set', 'client=acme', '--json'),
  );
  assert.equal(edited['estimated_minutes'], 90);
  assert.equal(edited['priority'], 3);
  assert.equal(edited['client'], 'acme');
});

// A field that shadowed a required one would be invisible in the flattened
// JSON of §3.2, so a reserved name is refused in both directions.
test('a reserved field can be neither set nor unset', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const task = await h.add('Editable');
  for (const args of [
    ['edit', task.id, '--unset', 'id'],
    ['edit', task.id, '--unset', 'status'],
    ['edit', task.id, '--unset', ''],
    ['edit', task.id, '--set', 'id=nope'],
  ]) {
    const got = await h.run(...args);
    assert.equal(got.code, exit.Usage, args.join(' '));
    assertCleanFailure(t, got.stderr);
  }
});

// The shared layer edits a copy, so a refused change leaves the stored item
// exactly as it was.
test('a refused edit changes nothing', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const added = h.taskOf(await h.mustRun('add', 'Intact', '--set', 'client=acme', '--json'));
  const taskID = added['id'] as string;

  const got = await h.run('edit', taskID, '--title', 'Changed', '--set', 'id=nope');
  assert.equal(got.code, exit.Usage);
  const after = h.taskOf(await h.mustRun('show', taskID, '--json'));
  assert.equal(after['title'], 'Intact');
  assert.equal(after['client'], 'acme');
});

test('an empty title is refused', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const task = await h.add('Editable');
  const got = await h.run('edit', task.id, '--title', '   ');
  assert.equal(got.code, exit.Usage);
  assertCleanFailure(t, got.stderr);
});

test('a bad estimate is a usage error', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const task = await h.add('Editable');
  for (const value of ['a while', '-5m', '']) {
    const got = await h.run('edit', task.id, '--estimate', value);
    assert.equal(got.code, exit.Usage, `--estimate ${JSON.stringify(value)}`);
  }
});

test('edit resolves a short number from the last listing', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const first = await h.add('first');
  await h.add('second');
  await h.mustRun('ls');
  assert.equal(h.taskOf(await h.mustRun('edit', '1', '--title', 'Renamed', '--json'))['id'], first.id);
});
