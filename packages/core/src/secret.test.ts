import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { inspect } from 'node:util';

import { REDACTED, Secret } from './secret.ts';

// An obviously fake placeholder, never a realistic-looking token.
const token = 'TOKEN_GOES_HERE_0123456789';

test('a secret never renders its value', () => {
  const s = new Secret(token);

  // Every path a credential could plausibly escape through.
  const rendered: string[] = [
    s.toString(),
    s.hint(),
    String(s),
    `${s}`,
    '' + s,
    s + '',
    ['prefix', s, 'suffix'].join(' '),
    JSON.stringify(s),
    JSON.stringify({ token: s }),
    JSON.stringify([s]),
    JSON.stringify(new Map([['token', s]]).get('token')),
    inspect(s),
    inspect({ token: s }),
    inspect([s]),
    inspect(new Map([['token', s]])),
    inspect({ token: s }, { depth: null, showHidden: true }),
    inspect({ nested: { deep: { token: s } } }, { depth: null }),
    // Object.entries, Object.keys and a spread see no own property at all,
    // because #value is a private field rather than one.
    JSON.stringify(Object.entries(s)),
    JSON.stringify(Object.keys(s)),
    JSON.stringify(Object.getOwnPropertyNames(s)),
    JSON.stringify({ ...s }),
    JSON.stringify(structuredClone({ ...s })),
    // What console.log would write, via the same formatter it uses.
    inspect(s, { colors: false }),
    // Coercions that bypass toString.
    `${String(Number(s))}`,
    JSON.stringify(Object.assign({}, s)),
  ];

  for (const got of rendered) {
    assert.ok(
      !got.includes(token),
      `secret value leaked into ${JSON.stringify(got)}`,
    );
  }
});

// What `console.log` actually writes, observed from outside the process.
//
// This used to capture output by replacing `process.stdout.write`, which
// works on Node and silently does not on Bun: Bun's `console.log` writes to
// the file descriptor without going through that stream object, so the
// capture came back empty and the assertion that the marker was printed
// failed — a harness problem, not a redaction one. Patching a stream also
// only ever proved what the patched stream received, not what a user sees.
//
// So the test spawns a child that prints a Secret and reads its stdout. That
// is the real thing on every runtime: the child is run with
// `process.execPath`, so `node --test` tests Node's formatter and `bun test`
// tests Bun's, and no runtime detection is needed anywhere. Both runtimes
// execute TypeScript directly (Node by stripping types since 22.18/24), so
// the child can import this module under test by path.
test('console.log does not disclose a secret', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todocloud-secret-'));
  try {
    const child = path.join(dir, 'print.ts');
    // Every shape a secret plausibly reaches console.log in: bare, as a
    // format argument, nested in an object, in an array, deeply nested, as a
    // Map value — plus console.error and console.dir, which
    // format the same way and are as easy to reach for in a debug line.
    const body = [
        `import { Secret } from ${JSON.stringify(new URL('./secret.ts', import.meta.url).href)};`,
        `const s = new Secret(${JSON.stringify(token)});`,
        'console.log(s);',
        "console.log('token=%s', s);",
        "console.log('token=%o', s);",
        "console.log('token=%j', s);",
        'console.log({ token: s });',
        'console.log([s, { token: s }]);',
        'console.log({ nested: { deep: { token: s } } });',
        'console.log(new Map([["token", s]]));',
        'console.log(JSON.stringify({ token: s }));',
        'console.log(`${s}`);',
        'console.error(s);',
        'console.dir({ token: s }, { depth: null });',
    ];
    fs.writeFileSync(child, body.join('\n'), 'utf8');
    // The import and the construction are not prints.
    const prints = body.length - 2;
    const run = spawnSync(process.execPath, [child], {
      encoding: 'utf8',
      // No inherited configuration, and nothing of the user's reachable: this
      // child only formats a value.
      env: { PATH: process.env['PATH'] ?? '' },
    });
    assert.equal(run.error, undefined, `spawning ${process.execPath} failed`);
    assert.equal(run.status, 0, `child exited ${String(run.status)}: ${run.stderr}`);
    const all = run.stdout + run.stderr;
    assert.ok(all !== '', 'captured no output from the child; the test would prove nothing');
    assert.ok(!all.includes(token), 'secret value leaked into console.log output');
    assert.ok(all.includes(REDACTED), 'console.log did not print the marker');
    // One marker per print, not just one somewhere in the output. An output
    // path that formatted the secret as something else — `{}`, `Secret {}`,
    // `undefined` — would not be a disclosure, but it would mean this test
    // had quietly stopped watching that path. Counting occurrences rather
    // than checking each line keeps this true whichever runtime's formatter
    // decides to wrap a value across lines.
    const printed = all.split(REDACTED).length - 1;
    assert.ok(
      printed >= prints,
      `${String(printed)} redaction markers for ${String(prints)} prints; a console path stopped redacting`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('structuredClone cannot carry the value across', () => {
  const s = new Secret(token);
  // A class instance clones to a plain object holding its own enumerable
  // properties. A private field is not one, so the clone holds nothing.
  const clone: unknown = structuredClone(s);
  assert.deepEqual(clone, {});
  assert.ok(!JSON.stringify(clone).includes(token));
  // And the clone is no longer a Secret, so it cannot reveal either.
  assert.ok(!(clone instanceof Secret));
});

test('the value is not reachable off the object', () => {
  const s = new Secret(token);
  assert.deepEqual(Object.keys(s), []);
  assert.deepEqual(Object.getOwnPropertyNames(s), []);
  assert.deepEqual(Object.getOwnPropertySymbols(s), []);
  assert.deepEqual(Object.entries(s), []);
  assert.deepEqual(Object.values(s), []);
  // Immutable: a caller cannot graft a value on either.
  assert.ok(Object.isFrozen(s));
});

test('reveal returns the stored value', () => {
  assert.equal(new Secret(token).reveal(), token);
});

test('empty', () => {
  assert.equal(new Secret('').empty(), true);
  assert.equal(new Secret(token).empty(), false);
});

// hint has to distinguish two credentials without disclosing a character of
// either, because `tdo config` output is documented as safe to paste.
test('hint', () => {
  assert.equal(new Secret('').hint(), '', 'an unset secret hints nothing');

  // Whatever it prints, no run of the secret may appear in it. Four
  // characters was the old behaviour and is what this guards against
  // coming back.
  const hint = new Secret(token).hint();
  for (let n = 3; n <= token.length; n++) {
    for (let i = 0; i + n <= token.length; i++) {
      const run = token.slice(i, i + n);
      assert.ok(
        !hint.includes(run),
        `the hint ${hint} contains ${run}, a run of the secret`,
      );
    }
  }
  assert.ok(
    hint.startsWith(REDACTED),
    `the hint ${hint} does not start with the redaction marker`,
  );
  assert.match(hint, /^\[REDACTED\]#[0-9a-f]{8}$/);

  // Same secret, same fingerprint: that is what makes "did tdo pick up the
  // token I rotated?" answerable, and what lets two origins of one token be
  // compared.
  assert.equal(new Secret(token).hint(), hint);

  // Different secrets, different fingerprints — including two that differ
  // only in the tail the old implementation would have shown.
  for (const different of [
    token + 'x',
    'TOKEN_GOES_HERE_9876543210',
    token.replace(/9$/, '8'),
    'short',
  ]) {
    assert.notEqual(
      new Secret(different).hint(),
      hint,
      `${different} and a different secret share the hint ${hint}`,
    );
  }

  // A short secret is fingerprinted like any other: the old rule gave short
  // values no suffix, which leaked the fact that they were short.
  const short = new Secret('abc').hint();
  assert.notEqual(short, REDACTED);
  assert.ok(
    short.startsWith(REDACTED + '#'),
    `a short secret hints ${short}; its length must not change the shape`,
  );
});

// The fingerprint is a SHA-256 of a domain-separated input, so it must agree
// with what any other SHA-256 of the same bytes produces. These vectors pin
// the hand-written implementation rather than the hint format.
test('the fingerprint is a real SHA-256', async () => {
  const digest = async (s: string): Promise<string> => {
    const bytes = new TextEncoder().encode(s);
    const sum = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(sum)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  };
  for (const value of [
    'abc',
    '',
    token,
    'a'.repeat(55),
    'a'.repeat(56),
    'a'.repeat(64),
    'a'.repeat(200),
    // Multi-byte input, to exercise the hand-written UTF-8 encoder.
    'ひらがな \u{1f510}',
  ]) {
    if (value === '') {
      continue; // hint() short-circuits on an unset secret.
    }
    const want = (
      await digest('todocloud/secret-fingerprint/v1\u0000' + value)
    ).slice(0, 8);
    assert.equal(
      new Secret(value).hint(),
      REDACTED + '#' + want,
      `fingerprint of ${JSON.stringify(value)}`,
    );
  }
});

test('fromJSON', () => {
  const tests: Array<{ name: string; in: unknown; want: string }> = [
    { name: 'plain value', in: token, want: token },
    { name: 'redaction marker becomes absent', in: REDACTED, want: '' },
    { name: 'hint becomes absent', in: REDACTED + '…6789', want: '' },
  ];
  for (const tc of tests) {
    assert.equal(Secret.fromJSON(tc.in).reveal(), tc.want, tc.name);
  }
  assert.throws(() => Secret.fromJSON(42), TypeError);
  assert.throws(() => Secret.fromJSON(null), TypeError);
});

// A redacted document must be safe to feed back in without resurrecting a
// value or carrying the marker into a provider request.
test('a round trip through JSON does not keep the value', () => {
  const data = JSON.stringify(new Secret(token));
  const back = Secret.fromJSON(JSON.parse(data));
  assert.ok(
    back.empty(),
    `round trip produced ${back.reveal()}, want an absent secret`,
  );
});
