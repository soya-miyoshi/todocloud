// The child-process runner `tdo login` and `tdo doctor` use for the provider
// CLIs. The test that matters is the deadline: providercli aborts a signal
// from a timer, and the runner once used `spawnSync`, which blocks the event
// loop, so the timer never ran and a hung `turso` hung `tdo login` for good.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as providercli from '@todocloud/core/providercli';

import { spawnRunner } from './login.ts';

const node = process.execPath;

test('a child that outlives the deadline is cut off', async () => {
  const started = Date.now();
  const out = await spawnRunner(AbortSignal.timeout(200), node, [
    '-e',
    'setTimeout(() => {}, 60_000)',
  ]);
  assert.ok(out.err !== undefined, 'an aborted child must report an error');
  assert.ok(Date.now() - started < 10_000, 'the abort must not wait for the child');
});

test('a child that exits 0 returns its output', async () => {
  const out = await spawnRunner(new AbortController().signal, node, [
    '-e',
    'process.stdout.write("out"); process.stderr.write("err")',
  ]);
  assert.equal(out.err, undefined);
  assert.equal(out.stdout, 'out');
  assert.equal(out.stderr, 'err');
});

test('a non-zero exit is an ExitError with the status and stderr', async () => {
  const out = await spawnRunner(new AbortController().signal, node, [
    '-e',
    'process.stderr.write("nope"); process.exit(3)',
  ]);
  assert.ok(out.err instanceof providercli.ExitError);
  assert.equal(out.err.exitCode, 3);
  assert.equal(out.stderr, 'nope');
});

test('a binary that cannot be started is an error, not a hang', async () => {
  const out = await spawnRunner(new AbortController().signal, '/nonexistent/tdo-test-bin', []);
  assert.ok(out.err !== undefined);
  assert.ok(!(out.err instanceof providercli.ExitError));
});

test('the child gets no stdin', async () => {
  // A child reading stdin must see EOF at once rather than wait on a prompt.
  const out = await spawnRunner(AbortSignal.timeout(5_000), node, [
    '-e',
    'process.stdin.on("end", () => process.stdout.write("eof")); process.stdin.resume()',
  ]);
  assert.equal(out.err, undefined);
  assert.equal(out.stdout, 'eof');
});
