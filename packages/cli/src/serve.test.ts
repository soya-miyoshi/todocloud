// `tdo serve`, ported from serve_test.go, plus one end-to-end bind.

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import * as exit from '@todocloud/core/exit';

import { defaultServePort, exposed, serveAddr, serveCommand } from './serve.ts';
import { newHarness } from './testsupport.ts';

// The rule from PLAN.md: a viewer is not a service, so reaching it from the
// network has to be asked for.
test('serveAddr defaults to loopback', () => {
  const cases: { name: string; addr?: string; port: number; want?: string; bad?: boolean }[] = [
    { name: 'the default', port: defaultServePort, want: '127.0.0.1:7373' },
    { name: 'a chosen port', port: 8080, want: '127.0.0.1:8080' },
    { name: 'any free port', port: 0, want: '127.0.0.1:0' },
    { name: 'a host of its own', addr: '0.0.0.0', port: defaultServePort, want: '0.0.0.0:7373' },
    {
      name: 'a host and port',
      addr: '0.0.0.0:9000',
      port: defaultServePort,
      want: '0.0.0.0:9000',
    },
    { name: 'an IPv6 host', addr: '::1', port: 7000, want: '[::1]:7000' },
    { name: 'two answers to one question', addr: '0.0.0.0:9000', port: 8080, bad: true },
    { name: 'a port that does not exist', port: 70000, bad: true },
    { name: 'a negative port', port: -1, bad: true },
  ];
  for (const c of cases) {
    if (c.bad === true) {
      assert.throws(() => serveAddr(c.addr ?? '', c.port), Error, c.name);
      continue;
    }
    assert.equal(serveAddr(c.addr ?? '', c.port), c.want, c.name);
  }
});

// The warning is the only thing standing between a user who typed
// --addr 0.0.0.0 and a list their network can edit, so it errs towards
// warning.
test('exposed warns on anything but loopback', () => {
  const quiet = [
    '',
    '127.0.0.1',
    'localhost',
    '::1',
    '[::1]',
    '127.0.0.1:8080',
    '127.0.0.2',
    '0:0:0:0:0:0:0:1',
  ];
  const loud = ['0.0.0.0', '::', '192.168.1.10', '0.0.0.0:9000', 'example.local'];
  for (const addr of quiet) {
    assert.equal(exposed(addr), false, `exposed(${JSON.stringify(addr)})`);
  }
  for (const addr of loud) {
    assert.equal(exposed(addr), true, `exposed(${JSON.stringify(addr)})`);
  }
});

test('serve takes no arguments', async (t: TestContext) => {
  const h = await newHarness(t, [serveCommand]);
  const got = await h.run('serve', 'junk');
  assert.equal(got.code, exit.Usage, got.stderr);
  assert.match(got.stderr, /serve takes no arguments/);
});

test('serve reports a --port that is not a number', async (t: TestContext) => {
  const h = await newHarness(t, [serveCommand]);
  const got = await h.run('serve', '--port', 'eight');
  assert.equal(got.code, exit.Usage, got.stderr);
  assert.match(got.stderr, /--port expects a number/);
});

// The listener really is opened, on 127.0.0.1 with the port the kernel picks,
// and --json names it before the first request so a script can find it. The
// command runs until it is interrupted, so the test stops it with SIGINT —
// which is also what proves Ctrl-C stops the listener rather than the
// process.
test('serve binds a free loopback port and prints it', async (t: TestContext) => {
  const h = await newHarness(t, [serveCommand]);
  const running = h.run('serve', '--port', '0', '--json');
  // The JSON line is written as soon as the socket is up, so waiting for the
  // listener means waiting for the process to see its own SIGINT handler
  // installed; a short poll is enough and keeps the test off a timer.
  await new Promise((resolve) => setTimeout(resolve, 150));
  process.emit('SIGINT');
  const got = await running;
  assert.equal(got.code, 0, got.stderr);
  const report = h.decode(got);
  assert.match(String(report['addr']), /^127\.0\.0\.1:\d+$/);
  assert.equal(report['url'], `http://${String(report['addr'])}/`);
  assert.ok(String(report['store']).length > 0);
  // The advisory lines are on stderr, so stdout stays one JSON value.
  assert.match(got.stderr, /press Ctrl-C to stop/);
  assert.ok(!got.stderr.includes('reachable from the network'), got.stderr);
});
