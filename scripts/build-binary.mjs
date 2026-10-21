// Builds the shipped executable with `bun build --compile`: one file, no
// runtime to install.
//
// This replaced a Node single executable application (SEA). Measured on an
// M-series Mac, `tdo --help`: the SEA started in 110 ms at 140 MB, this
// starts in 32 ms at 68 MB. The deciding fact was not either number but the
// target list — Node's SEA cannot produce a macOS x64 executable at all, so
// an Intel Mac had no archive, while `bun build --compile` cross-compiles
// every supported target from this one machine.
//
// Node has not gone anywhere. It is still the runtime for `npm test` and for
// development; only the shipped binary is built by Bun.
//
// Four things make this more than a one-liner.
//
// **No emit step.** Bun bundles and transpiles TypeScript itself, so there is
// no `tsc` run ahead of it and no emitted `dist/` to stage. The root
// `tsconfig.build.json` that used to produce one existed for the npm
// packages, whose consumers' Node might not strip types, and went with them
// (MIGRATION.md, "The npm channel, and why it closed").
//
// **The assets have to be embedded.** Go embedded `internal/web/assets` with
// `go:embed`, so a missing asset was a build failure. `packages/cli/src/web/
// web.ts` reads `packages/cli/assets` off disk at startup instead, and
// `packages/cli/src/admin.ts` reads `packages/cli/package.json` to answer
// `tdo version`. A bundle carries neither — a bundler follows `import`
// statements, not `fs.readFile` calls — so a binary built without `--asset`
// compiles fine and then fails when `tdo serve` starts or `tdo version`
// runs. Both are embedded here, and `smoke()` exercises both.
//
// **What `/$bunfs/root` means.** A compiled executable mounts its own files
// at `/$bunfs/root`, and that is where `import.meta.dirname` resolves to for
// the bundled code. `--asset <path>` embeds a file or directory there under
// its own basename: `--asset packages/cli/assets` lands at
// `/$bunfs/root/assets`, and `--asset packages/cli/package.json` at
// `/$bunfs/root/package.json`. So the two readers above resolve their own
// `import.meta.dirname` against that layout rather than walking up `../..`
// as they do from source and from an npm install.
//
// **`--bytecode` requires CJS.** It is a real startup win, but Bun emits a
// bytecode cache only for a CommonJS bundle, and CommonJS has no top-level
// `await`. So `packages/cli/src/main.ts` must not have one — it wraps its
// startup in an async function for exactly this reason — and if a top-level
// `await` comes back, the build stops here with "await can only be used
// inside an async function" pointing at the line. `--no-bytecode` is the
// escape hatch for telling that apart from a real bundling failure; a
// release does not use it.
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist-bin');
const entry = 'packages/cli/src/main.ts';

/**
 * The supported targets, as Bun's `--target` name against the os/arch names
 * the release archives use (`tdo_<version>_<os>_<arch>`), which are Go's
 * spelling and are what README.md, the Homebrew formula and every published
 * archive since the Go tree have said. `bun-*` is Bun's own prefix; there is
 * no musl/Alpine target and no s390x, same as before.
 */
const targets = [
  { bun: 'bun-linux-x64', os: 'linux', arch: 'amd64' },
  { bun: 'bun-linux-arm64', os: 'linux', arch: 'arm64' },
  { bun: 'bun-darwin-x64', os: 'darwin', arch: 'amd64' },
  { bun: 'bun-darwin-arm64', os: 'darwin', arch: 'arm64' },
  { bun: 'bun-windows-x64', os: 'windows', arch: 'amd64' },
];

/** hostTarget is the target this machine builds when given no --all. */
function hostTarget() {
  const os = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[process.platform];
  const arch = { arm64: 'arm64', x64: 'amd64' }[process.arch];
  const found = targets.find((t) => t.os === os && t.arch === arch);
  if (found === undefined) {
    throw new Error(`no supported target for ${process.platform}/${process.arch}`);
  }
  return found;
}

let all = false;
let bytecode = true;
let smokeTest = true;
for (const arg of process.argv.slice(2)) {
  if (arg === '--all') all = true;
  else if (arg === '--no-bytecode') bytecode = false;
  else if (arg === '--no-smoke') smokeTest = false;
  else {
    console.error(`usage: node scripts/build-binary.mjs [--all] [--no-bytecode] [--no-smoke]`);
    process.exit(2);
  }
}

// Fail here rather than three steps in with an ENOENT nobody can read. Bun is
// pinned in mise.toml, so there is one answer to give.
const bun = spawnSync('bun', ['--version'], { encoding: 'utf8' });
if (bun.error !== undefined || bun.status !== 0) {
  console.error('bun is not on PATH. Install it with:\n\n  mise install bun\n');
  process.exit(1);
}
console.error(`bun ${bun.stdout.trim()}`);

// The version comes out of the manifest, which scripts/set-version.mjs writes
// once before anything is built — the same number `tdo version` reports from
// the embedded copy of this file, so an archive's name and its contents
// cannot disagree.
const manifest = path.join(root, 'packages/cli/package.json');
const { version } = JSON.parse(fs.readFileSync(manifest, 'utf8'));

/** build compiles one target and returns the path of the executable. */
function build(target) {
  const base = `tdo_${version}_${target.os}_${target.arch}`;
  const dir = path.join(out, base);
  // The file inside is plainly `tdo`, not `tdo_<version>_<os>_<arch>`: the
  // name a user ends up typing is `tdo`, and the release archives this
  // directory's contents under the directory's own name.
  const exe = path.join(dir, target.os === 'windows' ? 'tdo.exe' : 'tdo');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const args = [
    'build',
    '--compile',
    `--target=${target.bun}`,
    ...(bytecode ? ['--bytecode'] : []),
    '--asset',
    'packages/cli/assets',
    '--asset',
    'packages/cli/package.json',
    '--outfile',
    path.relative(root, exe),
    entry,
  ];
  console.error(`\nbuilding ${base}...`);
  execFileSync('bun', args, { cwd: root, stdio: 'inherit' });

  // A build that wrote nothing, or wrote an empty file, must not reach a
  // release: `bun build` has exited 0 on a bundle it then failed to write.
  if (!fs.existsSync(exe)) throw new Error(`${exe} was not written`);
  const size = fs.statSync(exe).size;
  if (size === 0) throw new Error(`${exe} is zero bytes`);
  return { base, exe, size };
}

/**
 * smoke drives the built binary through scripts/smoke.sh, which redirects
 * HOME, the XDG paths and every TODOCLOUD_* variable before it runs anything.
 *
 * A build script that cannot tell you its output is broken is half a build
 * script. The SEA build shipped a bug of exactly this shape — it embedded
 * file *paths* as file *contents*, and nothing noticed until a human ran the
 * executable. Here the equivalent mistake is a missing `--asset`, which only
 * shows up when `tdo version` or `tdo serve` reads from `/$bunfs/root`.
 *
 * It is always scripts/smoke.sh and never a bare invocation: a `tdo` with no
 * environment set finds the real config at ~/.config/todocloud/config.toml
 * and writes to the maintainer's own provider. Read the header of that script
 * for the two times that happened.
 */
function smoke(exe) {
  console.error('\nsmoke-testing the host binary...');
  execFileSync('./scripts/smoke.sh', [exe], { cwd: root, stdio: 'inherit' });
}

const host = hostTarget();
const built = [];
for (const target of all ? targets : [host]) {
  built.push(build(target));
}

// A stable path for the host's binary, beside the per-target directories.
// Everything local wants the thing it just built without having to know the
// version in the manifest: scripts/install-local.sh installs from here, and
// `scripts/smoke.sh dist-bin/tdo` is a command a human can type. A symlink,
// so seventy-odd megabytes are not on disk twice; a copy on Windows, where a
// symlink needs a privilege the shell may not have.
const mine = built.find((b) => b.base.endsWith(`_${host.os}_${host.arch}`));
let link = null;
if (mine !== undefined) {
  link = path.join(out, path.basename(mine.exe));
  fs.rmSync(link, { force: true });
  if (process.platform === 'win32') fs.copyFileSync(mine.exe, link);
  else fs.symlinkSync(path.relative(out, mine.exe), link);
}

// Only the host's binary can be run here, so that is the one that is tested.
// The others are checked by the release, which runs each on its own platform.
if (smokeTest && link !== null) smoke(link);

console.error('');
for (const b of built) {
  console.error(`${path.relative(root, b.exe)}\t${(b.size / 1024 / 1024).toFixed(0)} MB`);
}
if (link !== null) console.error(`${path.relative(root, link)}\t-> ${path.basename(path.dirname(mine.exe))}`);
