// Ported from internal/output/output_test.go: the Printer half. The Table,
// Detail and fieldText cases of that file live in task.test.ts, beside the
// code they cover.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Printer } from './output.ts';

/** buffer collects what a Printer writes, standing in for a bytes.Buffer. */
class buffer {
  text = '';
  write(s: string): void {
    this.text += s;
  }
  get length(): number {
    return this.text.length;
  }
}

function newPrinter(): [Printer, buffer, buffer] {
  const out = new buffer();
  const err = new buffer();
  return [new Printer({ out, err }), out, err];
}

test('emit writes one JSON line', () => {
  const [p, out, errb] = newPrinter();
  p.emit({ count: 2 });
  assert.equal(out.text, '{"count":2}\n');
  assert.equal(errb.length, 0, `stderr should stay empty: ${JSON.stringify(errb.text)}`);
});

test('warnings and hints go to stderr', () => {
  const [p, out, errb] = newPrinter();
  p.warnf('config file is group-readable');
  p.hintf('No matching tasks.');
  p.debugf('not printed without --debug');
  assert.equal(out.length, 0, `nothing may reach stdout: ${JSON.stringify(out.text)}`);
  assert.ok(errb.text.includes('config file is group-readable'), errb.text);
  assert.ok(errb.text.includes('No matching tasks.'), errb.text);
  assert.ok(!errb.text.includes('not printed'), `--debug output leaked: ${errb.text}`);

  p.debug = true;
  p.debugf('now printed');
  assert.ok(errb.text.includes('now printed'), errb.text);
});

test('the fail envelope goes to stdout only under --json', () => {
  let [p, out, errb] = newPrinter();
  p.fail('not_found', new Error('task not found'));
  assert.equal(out.length, 0, `without --json nothing may reach stdout: ${out.text}`);
  assert.ok(errb.text.startsWith('tdo: task not found'), errb.text);

  [p, out, errb] = newPrinter();
  p.json = true;
  p.fail('not_found', new Error('task not found'));
  assert.equal(errb.length, 0, `under --json the message belongs on stdout: ${errb.text}`);
  // The envelope's own bytes are part of the contract, so this pins them
  // rather than parsing them back: the key order is the Go struct's.
  assert.equal(out.text, '{"error":{"code":"not_found","message":"task not found"}}\n');
  const envelope = JSON.parse(out.text) as { error: { code: string; message: string } };
  assert.equal(envelope.error.code, 'not_found');
  assert.equal(envelope.error.message, 'task not found');
});

// Go printed a `%w` chain as one line, and the port carries a sentinel as
// `cause`, so the advice half of the message was being dropped. These pin it
// back. docs/agents.md promises the `tdo init` advice specifically.
test('fail prints the cause chain, not just the outermost message', () => {
  const [p, , errb] = newPrinter();
  const sentinel = new Error('store is not initialized; run `tdo init`');

  p.fail('config', new Error('sqlite: /tmp/example/tasks.db', { cause: sentinel }));

  assert.equal(
    errb.text,
    'tdo: sqlite: /tmp/example/tasks.db: store is not initialized; run `tdo init`\n',
  );
});

test('fail does not print a cause its wrapper already quoted', () => {
  // Some wrappers in this tree follow Go's other habit and interpolate the
  // cause's text into their own message. Joining both would say it twice.
  const [p, , errb] = newPrinter();
  const inner = new Error('every: unreadable interval "7x"');

  p.fail('usage', new Error('01ARZ3ND: every: unreadable interval "7x"', { cause: inner }));

  assert.equal(errb.text, 'tdo: 01ARZ3ND: every: unreadable interval "7x"\n');
});

test('fail carries the whole chain into the --json envelope too', () => {
  const out = new buffer();
  const errb = new buffer();
  const p = new Printer({ out, err: errb, json: true });
  const sentinel = new Error('store is not initialized; run `tdo init`');

  p.fail('config', new Error('sqlite: /tmp/example/tasks.db', { cause: sentinel }));

  assert.deepEqual(JSON.parse(out.text), {
    error: {
      code: 'config',
      message: 'sqlite: /tmp/example/tasks.db: store is not initialized; run `tdo init`',
    },
  });
  assert.equal(errb.length, 0);
});

test('fail terminates on a cause cycle', () => {
  const [p, , errb] = newPrinter();
  const a = new Error('outer');
  const b = new Error('inner');
  a.cause = b;
  b.cause = a;

  p.fail('error', a);

  assert.equal(errb.text, 'tdo: outer: inner\n');
});
