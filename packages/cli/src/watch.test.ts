// `--watch`: the refusals, the pace, and that a frame is the command's own
// body run again. The loop is driven by an injected ticker rather than a
// timer, so these tests take no longer than a listing does; see the note on
// Ticker in app.ts.

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import * as exit from '@todocloud/core/exit';

import { addCommand } from './add.ts';
import type { CommandFactory } from './app.ts';
import { forecastCommand } from './forecast.ts';
import { listCommand, nextCommand } from './list.ts';
import { doneCommand } from './mark.ts';
import { newHarness, watchFor } from './testsupport.ts';
import { WatchLocalInterval } from './watch.ts';

const commands: readonly CommandFactory[] = [
  addCommand,
  listCommand,
  nextCommand,
  doneCommand,
  forecastCommand,
];

/** frames counts the screen clears in what a watching command wrote. */
function frames(stdout: string): number {
  return (stdout.match(/\x1b\[H\x1b\[2J/g) ?? []).length;
}

test('--watch redraws the listing once per frame', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  await h.mustRun('add', 'Write it down', '--json');
  const ticker = watchFor(h, 3);

  const res = await h.mustRun('ls', '--watch');
  assert.equal(frames(res.stdout), 3);
  // Each frame is the whole listing, so the row appears once per frame.
  assert.equal((res.stdout.match(/Write it down/g) ?? []).length, 3);
  // The terminal is taken over and handed back exactly once.
  assert.equal((res.stdout.match(/\x1b\[\?1049h/g) ?? []).length, 1);
  assert.ok(res.stdout.endsWith('\x1b[?25h\x1b[?1049l'));
  assert.deepEqual(ticker.waits, [
    WatchLocalInterval,
    WatchLocalInterval,
    WatchLocalInterval,
  ]);
  assert.match(res.stderr, /watching every 2s — Ctrl-C to stop/);
});

test('--watch sees a change made between frames', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  await h.mustRun('add', 'First', '--json');
  const ticker = watchFor(h, 2);
  // The store is written from outside the command, between its two frames,
  // which is the whole point of redrawing rather than printing once.
  const wait = ticker.wait.bind(ticker);
  ticker.wait = async (ms: number): Promise<boolean> => {
    await h.add('Second');
    return wait(ms);
  };

  const res = await h.mustRun('ls', '--watch');
  const [before = '', after = ''] = res.stdout.split('\x1b[H\x1b[2J').slice(1);
  assert.ok(!before.includes('Second'), before);
  assert.ok(after.includes('Second'), after);
  assert.ok(after.includes('First'));
});

test('a watched frame keeps the row numbers current', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  await h.mustRun('add', 'Only one', '--json');
  watchFor(h, 1);

  await h.mustRun('ls', '--watch');
  // The frame wrote the listing cache, as an unwatched one does: this is
  // what `watch -n5 tdo ls` cannot give, and the reason --watch exists.
  await h.mustRun('done', '1');
  assert.deepEqual(h.tasksOf(await h.mustRun('ls', '--json')), []);
});

test('--watch refuses what it cannot do, before it draws anything', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  await h.mustRun('add', 'Anything', '--json');

  // No terminal on stdout: the escape sequences would land in the file.
  const redirected = await h.run('ls', '--watch');
  assert.equal(redirected.code, exit.Usage);
  assert.match(redirected.stderr, /needs a terminal on stdout/);
  assert.equal(redirected.stdout, '');

  watchFor(h, 1);
  // --json is one object on stdout, not a stream of them.
  const machine = await h.run('ls', '--watch', '--json');
  assert.equal(machine.code, exit.Usage);
  assert.equal(frames(machine.stdout), 0);

  // A pace for something that is not redrawing.
  const alone = await h.run('ls', '--interval', '10s');
  assert.equal(alone.code, exit.Usage);
  assert.match(alone.stderr, /needs --watch/);
});

test('--interval takes a duration in range', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  const ticker = watchFor(h, 1);

  await h.mustRun('ls', '--watch', '--interval', '1m30s');
  assert.deepEqual(ticker.waits, [90_000]);

  for (const bad of ['500ms', '2h', 'soon', '', '0s']) {
    const res = await h.run('ls', '--watch', '--interval', bad);
    assert.equal(res.code, exit.Usage, `--interval ${JSON.stringify(bad)}`);
  }
  assert.match(
    (await h.run('ls', '--watch', '--interval', '500ms')).stderr,
    /between 1s and 1h/,
  );
});

test('forecast and next watch the same way ls does', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  await h.mustRun('add', 'Due tomorrow', '--due', new Date(Date.now() + 86_400_000).toISOString().slice(0, 10), '--json');

  for (const args of [['forecast'], ['forecast', '--week'], ['next']]) {
    watchFor(h, 2);
    const res = await h.mustRun(...args, '--watch');
    assert.equal(frames(res.stdout), 2, args.join(' '));
    assert.equal((res.stdout.match(/Due tomorrow/g) ?? []).length, 2, args.join(' '));
  }
});

test('an empty listing still draws a frame', async (t: TestContext) => {
  const h = await newHarness(t, commands);
  watchFor(h, 2);

  const res = await h.mustRun('ls', '--watch');
  // Nothing on stdout but the screen handling: an empty list is not an
  // error, and its hint belongs on stderr like every other hint.
  assert.equal(frames(res.stdout), 2);
  assert.match(res.stderr, /Nothing to do here/);
});
