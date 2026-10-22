// The deploy step that rewrites the service worker's cache name, tested here
// rather than found out on the runner. The step it replaced was a `sed` with
// the version written into it twice, and the way that failed — a hand-edit of
// the literal turning into a refused deploy — is the first case below.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stamp } from './stamp-cache.mjs';

// An obviously fake commit: 40 hex characters, as a real one is, but one
// word repeated. A plausible-looking 40-hex string is a Cloudflare API token
// to a secret scanner (CLAUDE.md §1.3), and the scanner is right to say so.
const sha = 'deadbeef'.repeat(5);
const worker = new URL('../packages/pwa/public/sw.js', import.meta.url);
// `fileURLToPath`, not `.pathname`: on Windows the pathname of a file URL is
// `/C:/…`, which node cannot resolve as a module path.
const script = fileURLToPath(new URL('./stamp-cache.mjs', import.meta.url));

test('the real worker is stamped with the commit', () => {
  const out = stamp(readFileSync(worker, 'utf8'), sha);
  assert.match(out, new RegExp(`^const CACHE = 'tdo-shell-${sha}';$`, 'm'));
  assert.equal(out.match(/^const CACHE = /gm)?.length, 1);
});

// Whatever the literal in the source says. The previous step matched one
// spelling of it, so changing that spelling broke the deploy — which is the
// opposite of what a cache name is for.
test('any name in the source is accepted', () => {
  for (const was of ["tdo-shell-local", "tdo-shell-v2", "anything-at-all", ""]) {
    const out = stamp(`const CACHE = '${was}';\n`, sha);
    assert.equal(out, `const CACHE = 'tdo-shell-${sha}';\n`);
  }
});

test('a source with no cache line, or two, is refused', () => {
  assert.throws(() => stamp('// no cache here\n', sha), /exactly one/u);
  assert.throws(
    () => stamp("const CACHE = 'a';\nconst CACHE = 'b';\n", sha),
    /exactly one/u,
  );
});

test('something that is not a commit is refused', () => {
  const source = "const CACHE = 'tdo-shell-local';\n";
  for (const bad of ['', 'HEAD', 'main', 'abc', '0123456789abcdefg']) {
    assert.throws(() => stamp(source, bad), /not a commit sha/u);
  }
});

// A line already carrying a commit is stamped again rather than refused: the
// deploy builds from a clean checkout, but a re-run over a built directory
// must not be the one thing that fails.
test('stamping twice is stamping once', () => {
  const once = stamp("const CACHE = 'tdo-shell-local';\n", sha);
  assert.equal(stamp(once, sha), once);
});

test('the command writes the file and reports what it wrote', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stamp-cache-'));
  const file = join(dir, 'sw.js');
  writeFileSync(file, "const CACHE = 'tdo-shell-local';\n");
  const out = execFileSync(process.execPath, [script, file, sha], {
    encoding: 'utf8',
  });
  assert.match(out, new RegExp(`tdo-shell-${sha}`));
  assert.equal(readFileSync(file, 'utf8'), `const CACHE = 'tdo-shell-${sha}';\n`);
});

test('the command fails loudly rather than leaving the file alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stamp-cache-'));
  const file = join(dir, 'sw.js');
  writeFileSync(file, '// nothing to stamp\n');
  assert.throws(
    () => execFileSync(process.execPath, [script, file, sha], { stdio: 'pipe' }),
    /exactly one/u,
  );
  assert.equal(readFileSync(file, 'utf8'), '// nothing to stamp\n');
});
