// The check that would have caught the crash, and the tree it guards.
//
// The last case is the one that matters: the whole repository, every tracked
// file a runtime executes, with no finding. That is the test that fails if a
// function of this shape is ever written again.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { check, findings } from './check-recursion.mjs';
import { execFileSync } from 'node:child_process';

/** found is the names reported for one snippet of source. */
function found(source) {
  return findings('probe.js', source).map((f) => `${f.name}: ${f.call}`);
}

// The two helpers as they shipped. Both came out of one search-and-replace
// over `app.js` that rewrote the bodies of the helpers it was introducing.
test('the shapes that shipped are reported', () => {
  assert.deepEqual(
    found("const messageOf = (err) => (err instanceof Error ? messageOf(err) : String(err));\n"),
    ['messageOf: messageOf(err)'],
  );
  assert.deepEqual(
    found('const closestOf = (event, sel) => (nodeOf(event).closest(sel));\n'),
    [],
  );
  assert.deepEqual(
    found('const closestOf = (event, sel) => (closestOf(event, sel));\n'),
    ['closestOf: closestOf(event, sel)'],
  );
});

test('a declaration and a method are reported too', () => {
  assert.deepEqual(
    found('function f(a) {\n  if (a) { return f(a); }\n  return 0;\n}\n'),
    ['f: f(a)'],
  );
  assert.deepEqual(found('const o = { m(a) { return o.m(a); } };\n'), []);
  assert.deepEqual(found('const api = { get(a) { return get(a); } };\n'), ['get: get(a)']);
});

// Recursion that makes progress is recursion, and most of it is fine.
test('an argument that changes is not reported', () => {
  for (const source of [
    'function f(n) { return n <= 0 ? 0 : f(n - 1); }\n',
    'function f(a, b) { return f(b, a); }\n',
    'function walk(node) { for (const k of node.kids) walk(k); }\n',
    'const g = (a) => a.map((x) => g(x));\n',
    'function f(a) { return h(a); }\n',
  ]) {
    assert.deepEqual(found(source), [], source.trim());
  }
});

// A nested function taking the same name shadows the outer one, so a call
// inside it is not a call to the outer one.
test('a shadowing inner function is not the outer one', () => {
  assert.deepEqual(
    found('function f(a) {\n  const f = (a) => a;\n  return f(a);\n}\n'),
    [],
  );
});

// A no-argument function that calls itself has nothing to make progress
// with but outer state, and nothing in this tree recurses that way.
test('a no-argument self-call is reported', () => {
  assert.deepEqual(found('function tick() { return tick(); }\n'), ['tick: tick()']);
});

test('every tracked file in the repository is clean', () => {
  const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter((f) => /\.(ts|mts|js|mjs|cjs)$/.test(f) && !f.endsWith('.d.ts'));
  assert.ok(files.length > 50, `only ${files.length} files were walked`);
  assert.deepEqual(
    check(files).map((f) => `${f.file}:${f.line}: ${f.name} — ${f.call}`),
    [],
  );
});
