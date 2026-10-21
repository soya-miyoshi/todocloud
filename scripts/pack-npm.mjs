// Stages the npm packages: one directory per published package, each holding
// emitted JavaScript and a manifest that points at it.
//
// Why a staged copy rather than a publishable `packages/*` tree
// -------------------------------------------------------------
// Every manifest in `packages/` points `exports` and `bin` at `./src/*.ts`,
// because Node 24+ runs TypeScript directly and the whole tree — `npm test`,
// `node packages/cli/src/main.ts`, a cross-package bare specifier — depends on
// that (MIGRATION.md, "No build step"). A consumer's Node may not strip types,
// and `bin` has to work there, so a published package must resolve to `.js`.
//
// The other way to square this is a `"development"` export condition selected
// with `node --conditions=development`, with `"default"` pointing at `dist/`.
// That was rejected: it puts a flag on every command in the repository — `npm
// test`, `tsc`, `node packages/cli/src/main.ts --help`, an editor's resolver —
// and the failure when the flag is missing is a resolution error pointing at a
// `dist/` that development never builds. A publish-time transformation has the
// opposite shape: the repository keeps working with no flag at all, and the
// rewriting happens in one readable place that only the release runs.
//
// The cost is that the directory `npm publish` is pointed at is not a workspace
// directory, so `npm pack --workspace todocloud` describes the development tree
// rather than the tarball. `npm pack --dry-run` inside `dist-npm/<pkg>` is what
// shows the real file list, and the release job prints it before publishing.
//
// Where the version comes from
// ----------------------------
// The staged manifests inherit `version` from the in-tree
// `packages/*/package.json`, and the pinned `@todocloud/*` ranges are pinned
// to that same number. The release writes it there once, before anything is
// built, with `scripts/set-version.mjs` — which is the one place a version
// enters the build, so the single executable and the tarballs cannot disagree
// about it. Read that script for what this arrangement replaced.
//
// `--version` stays as a convenience for a one-off stage by hand, when
// editing the tree's manifests would be beside the point. It applies to the
// staged copies only and leaves `packages/` alone, so it is the one path by
// which a staged tarball can carry a version `tdo version` has never heard
// of — which is harmless here, because `admin.js` reads whichever manifest it
// is installed beside, this one included.
//
// Usage: node scripts/pack-npm.mjs [--version X.Y.Z]
// With neither --version nor a set-version run the staged manifests keep the
// in-tree 0.0.0, which npm refuses to publish twice.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as process from 'node:process';
import { fileURLToPath } from 'node:url';

import { assertVersion } from './set-version.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const out = path.join(root, 'dist-npm');

/**
 * The packages that ship, in dependency order: a scoped dependency has to
 * reach the registry before the package that names an exact version of it.
 * `store-testkit` and `pwa` stay private — the testkit is test scaffolding and
 * the PWA is a deployed site, not a library. The compiled executable needs no
 * such list: `bun build --compile` follows the imports from
 * packages/cli/src/main.ts and takes what it finds.
 */
const shipped = ['core', 'store-sqlite', 'store-turso', 'cli'];

let version = null;
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--version') {
    version = process.argv[++i] ?? null;
  } else if (arg.startsWith('--version=')) {
    version = arg.slice('--version='.length);
  } else {
    throw new Error(`unknown argument ${arg}`);
  }
}
// One definition of what a version looks like, shared with the script that
// writes it into the manifests, so the two cannot drift.
if (version !== null) assertVersion(version);

function walk(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full, base) : [path.relative(base, full)];
  });
}

// 1. Emit JavaScript. tsconfig.build.json already excludes the tests and
//    testsupport.ts, which have no business in a tarball. Only the tarballs
//    need this step — the compiled executable is bundled by Bun, which
//    transpiles TypeScript itself.
console.error('building JavaScript...');
fs.rmSync(dist, { recursive: true, force: true });
execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'], {
  cwd: root,
  stdio: 'inherit',
});

// 2. Stage one directory per package.
fs.rmSync(out, { recursive: true, force: true });
const staged = [];
for (const pkg of shipped) {
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'packages', pkg, 'package.json'), 'utf8'));
  const dir = path.join(out, pkg);
  fs.mkdirSync(dir, { recursive: true });

  // The emitted modules, in place of src/*.ts.
  const from = path.join(dist, pkg, 'src');
  if (!fs.existsSync(from)) throw new Error(`nothing emitted for ${pkg}; did tsc run?`);
  fs.cpSync(from, path.join(dir, 'src'), { recursive: true });

  // The viewer's assets ride along, because web.ts reads them off disk at
  // startup (MIGRATION.md). They are listed in `files` too; both are needed —
  // `files` decides what npm takes, this decides what is there to take.
  if (fs.existsSync(path.join(root, 'packages', pkg, 'assets'))) {
    fs.cpSync(path.join(root, 'packages', pkg, 'assets'), path.join(dir, 'assets'), { recursive: true });
  }

  // Every consumer of the tarball gets the licence and the readme, so the
  // registry page and `node_modules` both carry them.
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(dir, 'LICENSE'));
  fs.copyFileSync(path.join(root, 'README.md'), path.join(dir, 'README.md'));

  const manifest = { ...onDisk };
  delete manifest.private;
  delete manifest.scripts; // `build` and `test` are development scripts.
  for (const key of Object.keys(manifest)) {
    if (key.startsWith('//')) delete manifest[key]; // the in-tree notes.
  }
  if (version !== null) manifest.version = version;

  // .ts -> .js, for `exports` and for `bin`.
  const retarget = (target) => target.replace(/\.ts$/, '.js');
  if (manifest.exports) {
    manifest.exports = Object.fromEntries(
      Object.entries(manifest.exports).map(([k, v]) => {
        if (typeof v !== 'string') throw new Error(`${onDisk.name}: exports["${k}"] is not a plain path`);
        return [k, retarget(v)];
      }),
    );
  }
  if (manifest.bin) {
    manifest.bin = Object.fromEntries(Object.entries(manifest.bin).map(([k, v]) => [k, retarget(v)]));
  }

  // A workspace dependency is `*`, which on the registry means "whatever is
  // newest". The published set is versioned together, so it is pinned exactly:
  // `todocloud` 1.2.3 must get `@todocloud/core` 1.2.3 and not a later core
  // that changed the Store interface under it.
  if (manifest.dependencies) {
    manifest.dependencies = Object.fromEntries(
      Object.entries(manifest.dependencies).map(([name, range]) => [
        name,
        name.startsWith('@todocloud/') ? manifest.version : range,
      ]),
    );
    const foreign = Object.keys(manifest.dependencies).filter((n) => !n.startsWith('@todocloud/'));
    // PLAN.md §1: the direct runtime dependency set is empty. A tarball is
    // where that promise would quietly stop being true.
    if (foreign.length > 0) throw new Error(`${onDisk.name} has runtime dependencies: ${foreign.join(', ')}`);
  }

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');

  // The shebang the sources carry asks for type stripping:
  //   #!/usr/bin/env -S node --experimental-strip-types
  // which is right for `./src/main.ts` and wrong for emitted JS — it pins the
  // installed command to a Node that still accepts an experimental flag, and
  // `env -S` is not portable. The published bin asks for plain node.
  for (const name of Object.keys(manifest.bin ?? {})) {
    const file = path.join(dir, manifest.bin[name].replace(/^\.\//, ''));
    const src = fs.readFileSync(file, 'utf8');
    if (!src.startsWith('#!')) throw new Error(`${file} has no shebang; bin "${name}" would not run`);
    fs.writeFileSync(file, src.replace(/^#!.*\n/, '#!/usr/bin/env node\n'));
  }

  // Nothing published may still point at a .ts file: that is the one mistake
  // this script exists to prevent, and it is cheap to assert.
  const text = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
  if (text.includes('.ts"')) throw new Error(`${onDisk.name}: a manifest target still points at TypeScript`);

  staged.push({ name: manifest.name, version: manifest.version, dir, files: walk(dir).length });
}

for (const p of staged) {
  console.error(`${p.name}@${p.version} -> ${path.relative(root, p.dir)} (${p.files} files)`);
}
console.error('\npublish in this order:');
for (const p of staged) console.error(`  npm publish ${path.relative(root, p.dir)}`);
