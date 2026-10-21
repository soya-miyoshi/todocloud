// `tdo show`: the one command the dispatcher ships with so far.

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import * as exit from '@todocloud/core/exit';

import * as shortref from './shortref.ts';
import { newHarness } from './testsupport.ts';

test('show renders one item', async (t: TestContext) => {
  const h = await newHarness(t);
  const task = await h.add('Pay the invoice');

  const shown = h.taskOf(await h.mustRun('show', task.id, '--json'));
  assert.equal(shown['id'], task.id);
  assert.equal(shown['title'], 'Pay the invoice');

  const human = await h.mustRun('show', task.id);
  assert.match(human.stdout, /Pay the invoice/);
  assert.equal(human.stderr, '');
});

test('show expects exactly one reference', async (t: TestContext) => {
  const h = await newHarness(t);
  const task = await h.add('Pay the invoice');

  for (const args of [['show'], ['show', task.id, task.id]]) {
    const got = await h.run(...args);
    assert.equal(got.code, exit.Usage, args.join(' '));
    assert.match(got.stderr, /show expects exactly one item reference/);
  }
});

// A pure read: show never refreshes the short numbers (§4.2), so the numbers
// a listing installed still mean what the user read off the screen.
test('show does not renumber the listing', async (t: TestContext) => {
  const h = await newHarness(t);
  const first = await h.add('first');
  const second = await h.add('second');
  const key = await h.withStore((st) => Promise.resolve(st.describe()));
  shortref.Save(key, [first.id, second.id]);

  const shown = h.taskOf(await h.mustRun('show', '2', '--json'));
  assert.equal(shown['id'], second.id);
  assert.equal(shortref.Lookup(key, 1), first.id, 'show renumbered the listing');
  assert.equal(shortref.Lookup(key, 2), second.id);
});
