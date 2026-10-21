// Finding the files that ship beside the code: `packages/cli/assets` for the
// viewer and `packages/cli/package.json` for the version.
//
// Go had `go:embed`, so there was nothing to find. A TypeScript build reads
// both from the filesystem, and the path they sit at depends on how `tdo` was
// installed. Four layouts are in use, and the first three agree while the
// fourth does not:
//
//   1. from source, in this repository:
//        packages/cli/src/web/web.ts -> ../../assets
//        packages/cli/src/admin.ts   -> ../package.json
//   2. from an npm install: scripts/pack-npm.mjs stages the emitted `src/`
//      beside the manifest and the asset directory, so `src/web/web.js` and
//      `src/admin.js` reach them by exactly the same relative paths.
//   3. inside the Node single executable: the VFS mounts the tree read-only
//      as `node_modules/@todocloud/cli/`, mirroring the on-disk layout, so
//      again the same relative paths resolve.
//   4. inside a `bun build --compile` executable: every module reports
//      `import.meta.dirname` as `/$bunfs/root` — there is no directory tree
//      to walk up, because the bundle is one file. `--asset <dir>` embeds a
//      directory under its basename beside the entry, so `packages/cli/assets`
//      arrives as `/$bunfs/root/assets` and the embedded manifest as
//      `/$bunfs/root/package.json`. The repository path they had is gone.
//
// So each resource has two candidate paths — the layout-relative one that
// 1-3 share, and the entry-adjacent one Bun produces — and this module tries
// them in order and returns the first that exists.
//
// It is a probe rather than a test for Bun (no `globalThis.Bun`, no version
// sniff) on purpose. A probe states what the code actually needs, which is a
// file at one of two places; a runtime check states who it believes put it
// there, and goes wrong the moment a runtime, a bundler or a packaging step
// changes. The probe stays true across all of them.
//
// This lives in `packages/cli` rather than `packages/core` because it needs
// `node:fs`, and `packages/core` must keep running in a browser — the PWA
// imports it and `browser-safe.test.ts` enforces it. Both callers are here
// anyway: `src/admin.ts` and `src/web/web.ts`.

import { existsSync } from 'node:fs';
import * as path from 'node:path';

/**
 * resolveBundled returns the path to a file or directory shipped beside the
 * code.
 *
 * `moduleDir` is the caller's `import.meta.dirname`, `up` the relative path
 * from it to the resource's parent in the source layout (`'..'`, `'../..'`),
 * and `name` the resource's basename, which is also the name it keeps inside
 * a Bun executable.
 *
 * When neither candidate exists the layout-relative path is returned, so the
 * caller's own failure — `tdo serve` naming the directory it looked in, or
 * `tdo version` falling back to `0.0.0-unknown` — reports the path a broken
 * install is actually missing rather than the virtual one.
 *
 * Callers resolve lazily and memoise: `tdo --help` must not pay a `stat` for
 * a file only `tdo version` or `tdo serve` reads (MIGRATION.md records the
 * 84 ms startup budget against a 42 ms floor).
 */
export function resolveBundled(moduleDir: string, up: string, name: string): string {
  const layoutRelative = path.join(moduleDir, up, name);
  // Candidate order follows which layouts are common, not which is likely to
  // exist: a checkout, a tarball and the SEA all answer on the first probe,
  // and only the Bun executable reaches the second.
  for (const candidate of [layoutRelative, path.join(moduleDir, name)]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return layoutRelative;
}
