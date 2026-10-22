// The static shell, held to the four invariants that cannot be checked by
// running the app.
//
// Everything in `public/` is served to a browser, and nothing in this
// repository can run a browser — `node --test` is the whole test tier, and a
// headless one is not being added. So the files that only a browser executes
// are checked here as text, against the things that would otherwise be found
// out by a phone failing to load:
//
//   1. Every file the shell names is a file that exists — in `public/`, or
//      in `packages/cli/assets`, which is where the viewer's `app.js`,
//      `app.css` and icons live. There is one copy of those: the build
//      copies them out of that directory (see `//build` in package.json).
//      This used to be a byte-for-byte diff against a second copy in
//      `public/`, and a second copy of `src/api.ts` against the CLI's; both
//      copies are gone — the assets are shared from one directory and the
//      API layer is `@todocloud/core/webapi` — so there is nothing left for
//      a drift test to guard.
//   2. The import map covers every bare specifier the app actually loads.
//      There is no bundler, so a specifier missing from the map is a module
//      that does not resolve, and the app does not start.
//   3. The service worker's allow-list is exactly the modules the app loads.
//      A module missing from it is fetched from the network at every launch,
//      so the installed app does not open offline.
//   4. Nothing the browser loads imports `node:*`.
//
// The module graph is computed here rather than listed, by walking the
// imports from `main.ts` the way a browser would.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';

/** The three directories this file reasons about. */
const pwaDir = path.join(import.meta.dirname, '..');
const packagesDir = path.join(pwaDir, '..');
/**
 * assetsDir is the one copy of the viewer's assets. `packages/cli/assets` is
 * where it is because `packages/cli/src/web/web.ts` reads it from disk
 * relative to itself and `scripts/build-binary.mjs` embeds it into the single
 * executable with `--asset`; this app's build copies out of it.
 */
const assetsDir = path.join(packagesDir, 'cli', 'assets');

const publicFile = (name: string): string => path.join(pwaDir, 'public', name);

/**
 * servedFile is where a path the shell names comes from. The served root is
 * two directories: this app's own shell in `public/`, and the shared viewer
 * assets copied in from `assetsDir` at build time. A name in neither is a
 * 404 on the installed app, which is what the callers assert.
 */
function servedFile(name: string): string {
  const mine = publicFile(name);
  return existsSync(mine) ? mine : path.join(assetsDir, name);
}

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

/** importMap is the map out of `index.html`, parsed as a browser parses it. */
function importMap(): Record<string, string> {
  const html = read(publicFile('index.html'));
  const found = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html);
  assert.notEqual(found, null, 'index.html has no import map');
  const parsed = JSON.parse((found as RegExpExecArray)[1] as string) as {
    imports: Record<string, string>;
  };
  return parsed.imports;
}

/**
 * sourceOf turns a published module path — `/core/src/task.js`, which is what
 * the import map and the service worker name — into the TypeScript file it is
 * emitted from.
 */
function sourceOf(published: string): string {
  assert.ok(published.endsWith('.js'), `${published} is not a module path`);
  return path.join(packagesDir, published.replace(/^\//, '').replace(/\.js$/, '.ts'));
}

/** publishedOf is sourceOf backwards. */
function publishedOf(source: string): string {
  return '/' + path.relative(packagesDir, source).replace(/\.ts$/, '.js');
}

/**
 * graph walks the imports from `main.ts`, resolving a relative specifier
 * against the importing file and a bare one through the import map. It
 * returns the source files a browser would load, and the bare specifiers it
 * saw on the way — which is what checks the map for completeness in both
 * directions.
 */
function graph(): { files: Set<string>; bare: Set<string> } {
  const map = importMap();
  const files = new Set<string>();
  const bare = new Set<string>();
  const pending = [path.join(pwaDir, 'src', 'main.ts')];
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (files.has(file)) {
      continue;
    }
    files.add(file);
    const text = read(file);
    // `from '…'` covers every import and re-export form this tree uses; a
    // dynamic `import('…')` would be missed, and there is none.
    for (const found of text.matchAll(/from\s+'([^']+)'/g)) {
      const specifier = found[1] as string;
      if (specifier.startsWith('.')) {
        pending.push(path.resolve(path.dirname(file), specifier));
        continue;
      }
      bare.add(specifier);
      const target = map[specifier];
      assert.notEqual(
        target,
        undefined,
        `${specifier}, imported by ${path.relative(packagesDir, file)}, is not in the import map in index.html`,
      );
      pending.push(sourceOf(target as string));
    }
  }
  return { files, bare };
}

/** shellList is the SHELL array out of `sw.js`. */
function shellList(): string[] {
  const text = read(publicFile('sw.js'));
  const found = /const SHELL = \[([\s\S]*?)\];/.exec(text);
  assert.notEqual(found, null, 'sw.js has no SHELL list');
  return [...((found as RegExpExecArray)[1] as string).matchAll(/'([^']+)'/g)].map(
    (m) => m[1] as string,
  );
}

test('the shell names only files that exist, from the two directories it is built from', () => {
  // The viewer's assets are shared rather than copied, so this is the test
  // that catches the arrangement coming apart: a rename in
  // `packages/cli/assets` leaves the page pointing at nothing, and the build
  // step that copies them is a `cp` with a spelled-out list.
  for (const name of ['app.js', 'app.css', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png']) {
    assert.equal(
      existsSync(publicFile(name)),
      false,
      `public/${name} exists; the viewer's assets have one copy, in packages/cli/assets, and a file here would shadow it`,
    );
    assert.ok(
      statSync(path.join(assetsDir, name)).isFile(),
      `packages/cli/assets/${name} is gone, and the page and sw.js still name it`,
    );
  }
});

test('the import map resolves every specifier the app loads, and nothing else', () => {
  const { bare } = graph();
  const map = importMap();
  assert.deepEqual(
    Object.keys(map).sort(),
    [...bare].sort(),
    'the import map and the specifiers the app imports have diverged; an extra entry is dead weight and a missing one is a module that does not resolve',
  );
  // Every target is a file that exists and will be emitted.
  for (const target of Object.values(map)) {
    assert.ok(statSync(sourceOf(target)).isFile(), `${target} has no source file`);
  }
});

test('the service worker caches exactly the shell, and the shell is complete', () => {
  const listed = shellList();
  const { files } = graph();
  const modules = listed.filter((entry) => entry.endsWith('.js') && entry !== '/app.js');
  assert.deepEqual(
    modules.sort(),
    [...files].map(publishedOf).sort(),
    'sw.js SHELL and the modules the app loads have diverged; a module missing from SHELL is one the installed app fetches from the network at every launch',
  );

  // The static half of the shell: the page, the styles, the viewer script,
  // the manifest and the icons. Each has to be a file that exists.
  for (const entry of listed) {
    if (entry === '/' || entry.endsWith('.js')) {
      continue;
    }
    const name = entry.replace(/^\//, '');
    assert.ok(
      statSync(servedFile(name)).isFile(),
      `SHELL names ${entry}, which is neither in public/ nor in packages/cli/assets`,
    );
  }
  for (const name of readdirSync(path.join(pwaDir, 'public'))) {
    assert.ok(
      listed.includes(`/${name}`) || name === 'sw.js',
      `public/${name} is served but not in sw.js SHELL, so the app would not have it offline`,
    );
  }
});

test('the service worker answers nothing but the allow-list', () => {
  const text = read(publicFile('sw.js'));
  // One gate, before the one respondWith. A URL that is not on the list gets
  // no response from this file, which is what keeps every request to the
  // user's database — and the Authorization header on it — out of here.
  assert.equal([...text.matchAll(/event\.respondWith\(/g)].length, 1);
  assert.match(text, /if \(!shellURLs\.has\(key\)\) \{\s*return;\s*\}\s*event\.respondWith/);
  // And exactly one place a response is written to a cache, keyed by an
  // allow-listed URL rather than by the request.
  assert.equal([...text.matchAll(/cache\.put\(/g)].length, 1);
  assert.match(text, /cache\.put\(key,/);
});

test('nothing the browser loads imports node:*', () => {
  const { files } = graph();
  for (const file of files) {
    const text = read(file);
    for (const found of text.matchAll(/from\s+'(node:[^']+)'/g)) {
      assert.fail(
        `${path.relative(packagesDir, file)} imports ${found[1] as string}, which does not exist in a browser`,
      );
    }
  }
});

test('the CSP hash matches the import map it is there to allow', () => {
  const html = read(publicFile('index.html'));
  const map = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html);
  const digest = createHash('sha256')
    .update((map as RegExpExecArray)[1] as string, 'utf8')
    .digest('base64');
  assert.ok(
    html.includes(`'sha256-${digest}'`),
    `the import map changed and the Content-Security-Policy hash did not; it should be 'sha256-${digest}'`,
  );
});

test('the page carries no token, no template action and no realistic secret', () => {
  const html = read(publicFile('index.html'));
  // The local viewer's page is a template with a write token in it. This one
  // is a static file, and has to stay one: a `{{…}}` here would be served to
  // a browser verbatim.
  assert.equal(html.includes('{{'), false);
  assert.equal(/data-token\s*=/.test(html), false);
  // The only credential-shaped strings on the page are the repository's
  // placeholders (CLAUDE.md §1.3).
  assert.ok(html.includes('TOKEN_GOES_HERE'));
  assert.ok(html.includes('libsql://example.turso.io'));

  // The load order the shim depends on: this module first, the viewer after
  // it, and the viewer deferred so that order holds.
  const mine = html.indexOf('<script type="module" src="/pwa/src/main.js">');
  const viewer = html.indexOf('<script src="/app.js" defer>');
  assert.ok(mine > 0 && viewer > mine, 'main.js must be loaded before app.js, and app.js deferred');
});

test('the manifest is installable and points at files that exist', () => {
  const manifest = JSON.parse(read(publicFile('manifest.webmanifest'))) as {
    name?: string;
    start_url?: string;
    display?: string;
    icons?: { src: string; sizes: string }[];
  };
  assert.equal(manifest.name, 'tdo');
  assert.equal(manifest.start_url, '/');
  // Installability, as a browser checks it: a name, a start URL, a display
  // mode that is not `browser`, and a 192px and a 512px icon.
  assert.notEqual(manifest.display, 'browser');
  const sizes = (manifest.icons ?? []).map((icon) => icon.sizes);
  assert.ok(sizes.includes('192x192') && sizes.includes('512x512'));
  for (const icon of manifest.icons ?? []) {
    assert.ok(statSync(servedFile(icon.src.replace(/^\//, ''))).isFile());
  }
});

// The fifth invariant, learned the hard way: this shell and the local
// viewer's are two files on purpose — the connect flow, the disconnect
// button and the token hint are this app's and nothing else's — but `app.js`
// is one file serving both, and it looks its furniture up by id. An element
// added to one shell and not the other is not a layout difference; it is a
// `TypeError` on the next render, in whichever front end was forgotten.
//
// So every id `app.js` reaches for with `$` has to be in this page. `$`
// throws rather than answering null, which is what makes the list it asks
// for a contract; the handful that genuinely differ between the two shells
// are asked for with `maybe`, which answers null, and are not on it.
test('every element app.js looks up by id is in this shell', () => {
  const js = read(path.join(assetsDir, 'app.js'));
  const html = read(publicFile('index.html'));
  const wanted = new Set(
    [...js.matchAll(/\$\('#([A-Za-z0-9_-]+)'/g)].map((m) => m[1] as string),
  );
  const have = new Set([...html.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map((m) => m[1] as string));
  const missing = [...wanted].filter((id) => !have.has(id)).sort();
  assert.deepEqual(
    missing,
    [],
    `app.js looks these up and this shell has none of them: ${missing.join(', ')}`,
  );
});
