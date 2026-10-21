// Writes a release version into the shipped `packages/*/package.json`.
//
// This is the one place a version enters the build. Everything downstream
// reads it back out of the manifests:
//
//   - `packages/cli/src/admin.ts` reads its own manifest, so `tdo version`
//     reports it both from source and from the single executable.
//   - `scripts/build-binary.mjs` embeds `packages/cli/package.json` into the
//     compiled executable with `--asset`, and names each output after the
//     version it reads from there.
//
// What this replaced is worth recording, because both halves were clever and
// neither should have had to exist. The release used to bake the version in
// twice, after the build rather than before it: `.github/workflows/
// release.yml` rewrote the SEA's generated boot shim to assign
// `process.env.TODOCLOUD_VERSION` — converting its static import to a dynamic
// one, because ESM evaluates imports before the importing module's body, so
// the assignment would otherwise have run after `admin.js` had already read
// the environment — and the npm publish path regex-patched the emitted
// `admin.js` to replace the hardcoded fallback, a tarball having no shim to
// edit. Two mechanisms for one fact, one of them editing compiled output, and
// each could drift from the other. A Node package's version belongs in its
// manifest; putting it there before anything is built makes both unnecessary.
//
// The `version` value is replaced textually rather than by round-tripping the
// JSON: these manifests carry `//`-prefixed explanatory keys in a deliberate
// order, and a reserialize would be a diff over the whole file.
//
// Usage: node scripts/set-version.mjs 1.2.3
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as process from 'node:process';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The packages a release stamps: the CLI and the three libraries it is built
 * out of. `store-testkit` and `pwa` are not part of what ships, so neither
 * carries a release version. Only `cli`'s copy is read back — by
 * `packages/cli/src/admin.ts` and by `scripts/build-binary.mjs` — but all
 * four are written, because a manifest left at 0.0.0 beside three stamped
 * ones is a trap rather than a saving.
 */
export const shipped = ['core', 'store-sqlite', 'store-turso', 'cli'];

/** What a manifest's `version` will accept, and what the tag is validated against. */
export const versionPattern = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** assertVersion throws unless v is MAJOR.MINOR.PATCH[-prerelease]. */
export function assertVersion(v) {
  if (typeof v !== 'string' || !versionPattern.test(v)) {
    throw new Error(`${v} is not MAJOR.MINOR.PATCH[-prerelease]`);
  }
  return v;
}

/**
 * setVersion rewrites the `version` field of one manifest in place and
 * returns the text it wrote. The match is asserted: a manifest this script
 * silently skipped would ship as 0.0.0, which is the bug it exists to
 * prevent.
 */
export function setVersion(file, version) {
  assertVersion(version);
  const src = fs.readFileSync(file, 'utf8');
  // The real `version`, anchored to the top-level two-space indent, so a
  // nested `"version"` inside some other object cannot be hit instead.
  const re = /^(  "version": ")[^"]*(",)$/m;
  if (!re.test(src)) throw new Error(`${file}: no top-level "version" field to set`);
  const out = src.replace(re, `$1${version}$2`);
  fs.writeFileSync(file, out);
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = assertVersion(process.argv[2]);
  for (const pkg of shipped) {
    const file = path.join(root, 'packages', pkg, 'package.json');
    setVersion(file, version);
    console.error(`${path.relative(root, file)} -> ${version}`);
  }
}
