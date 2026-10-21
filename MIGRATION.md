# Go to TypeScript migration

This records the target stack, the package mapping and the order of work. It
is a working document for the migration and is deleted when the Go tree is
removed.

## Why

A standalone PWA must talk to the user's database directly from the browser.
Turso's HTTP API permits this: `libsql-server/src/http/user/mod.rs` wraps the
user HTTP API — the one serving `/v2/pipeline` — in a permissive CORS layer
(`allow_origin(Any)`, `allow_headers(Any)`), and authentication is a Bearer
header rather than a cookie, so the wildcard origin applies. Sharing one
implementation of availability, repeat completion and the task shape between
the CLI and that PWA is what this migration buys.

Cloudflare D1 is not reachable this way: its REST API does not send
configurable CORS headers and is not meant to be called from a browser. D1
therefore stays CLI-only, or gains an optional Worker relay later.

## Stack: zero runtime dependencies

`PLAN.md` §1 chose Go partly because the standard library covered everything.
Node 24+ covers the same ground, so the direct dependency set is empty and
`typescript` is the only devDependency.

| Go | TypeScript |
| --- | --- |
| `urfave/cli/v3` | `node:util` `parseArgs`, plus a hand-written subcommand dispatcher |
| `modernc.org/sqlite` | `node:sqlite` (built in; no native build step) |
| `oklog/ulid/v2` | hand-written, over `crypto.getRandomValues` (works in both runtimes) |
| `mattn/go-isatty` | `node:tty` `isatty` |
| hand-written TOML subset | ported as-is; still deliberately a subset |
| `go test` | `node --test` |
| `gofmt` / `go vet` | `tsc --strict` |

A hand-written dispatcher over `parseArgs` rather than a CLI framework: exit
code `2` for usage errors and the exact `--json` shapes in `docs/agents.md`
are contracts, and a framework owns both.

## Package layout

The browser cannot use `node:sqlite`, so the runtime-specific stores are
separate packages and `core` imports neither.

- `packages/core` — runtime-agnostic: task, recur, taskops, the `Store`
  interface, availability, id, output, exit codes, secret. Nothing here may
  import `node:*`; a package that needs to belongs below.
- `packages/store-sqlite` — `node:sqlite`. Node only.
- `packages/store-turso` — `fetch` against `/v2/pipeline`. Both runtimes.
- `packages/cli` — the `tdo` binary: config, keyring, shortref, the provider
  CLI runner, commands. `shortref` lives here rather than in `core`, where the
  Go tree had it under `internal/`: it is a filesystem cache of what the
  terminal last printed, so it needs `node:fs` and the PWA has no use for it.

`providercli` is split rather than placed. The URL and database-name rules are
in `core`, because the PWA validates the same values, but spawning `turso` is
not possible there. Go already had `lookPath` and `runner` as package
variables, so those became the seam: `core` ships no default runner, and
`packages/cli` installs one over `node:child_process`. Until it does, the
`turso*` helpers refuse rather than pretend — which is the correct answer in a
browser and an obvious one in a misconfigured Node process.
- `packages/pwa` — the standalone PWA. Turso only.

## Port order

Dependency-first, so every package is ported against finished dependencies.

1. `task`, `id`, `secret`, `exit`, `shortref` — no internal dependencies.
2. `recur`, `keyring`, `providercli`.
3. `store` (+ `schema`, `sqlite`, `turso`, `storetest`), `output`, `config`.
4. `taskops`.
5. `web`, `cli`.
6. `pwa`, then remove the Go tree.

## Rules that do not change

CLAUDE.md applies unchanged. In particular: §1 credentials (no secret in
`argv` — pass it to a subprocess on stdin), §2 English only, machine output on
stdout, and the fixed exit codes. `Secret` keeps its unprintable contract via
`toString`, `toJSON` and `node:util.inspect.custom`.

Tests are ported with their package. The suite must keep passing with no
network access.

## Open decisions, for review

**A hand-written SHA-256 in `packages/core/src/secret.ts`.** `Secret.hint()`
returns an eight-hex-digit fingerprint so a user can tell which token was
picked up without printing any of it. Go used `crypto/sha256` synchronously.
In `core` the constraint is that nothing may import `node:*`, because the PWA
imports it, and the browser's `crypto.subtle.digest` is async — which would
make `hint()` async and spread `await` through every caller. The port therefore
carries its own SHA-256, pinned in the tests against `crypto.subtle` over eight
vectors including the 55/56/64-byte block-boundary cases, and producing
fingerprints identical to the Go implementation.

It is worth a second look because hand-written crypto is normally the wrong
answer. What makes it defensible here: the digest protects nothing. It is a
cosmetic identifier, not an authentication or integrity check, and the
alternative is an async signature on a method called from synchronous output
code. If that trade is unwelcome, the fix is to make `hint()` async and use
`crypto.subtle`, and the fingerprints stay byte-compatible either way.

**No build step.** Node 24 runs TypeScript directly by stripping types, so
`packages/*` resolve each other through their `exports` maps straight to
`src/*.ts`, and `tdo` runs from source. One root `tsconfig.json` covers every
package, which is why a cross-package import needs no project reference.

The alternative was emitting `dist/` per package with `composite` and
`declaration`. That was tried first and abandoned: a sibling package could not
be type-checked until core had been built, and the tests — which run the `.ts`
files directly — resolved to a `dist/` that did not exist yet. Shipping an
emitted bundle is still open, and is a packaging decision for the release, not
something the tree has to carry while it is being ported.

**`node:sqlite` binds a JS number as REAL.** The schema version marker lives in
a TEXT column, and binding `2` wrote `"2.0"` where Go wrote `2`. The
conformance suite caught it on its first run against a real provider, through
the case that checks the recorded version marker is never written down to a
lie. The fix is to bind a whole number as a `BigInt`, which binds as INTEGER;
`packages/store-sqlite` does that through its `intBind()` for the version
marker, `position`, `estimated_minutes` and the boolean columns.

Anything that binds an integer through `node:sqlite` needs the same treatment.
It is the one place where a provider ported method-for-method from Go still
produces different bytes.

## A credential-disclosure bug the port fixed

`internal/store/turso/client.go:188` put a piece of a failed response body into
the error it raised, through `readSnippet` and `clip`. `clip`
(`internal/store/turso/protocol.go:357`) strips control characters and
truncates to 120 bytes; it does not redact. Nothing else in `client.go`
scrubbed a response, so a server — or a proxy between — that reflected the
request headers into an error body put `Authorization: Bearer <token>` into the
user's terminal. The truncation limits how much escapes, not whether it
escapes.

CLAUDE.md §1.7 says never to log a request header. The rule held everywhere the
code wrote a header itself, and failed where a remote end wrote one back.

`packages/store-turso` scrubs the revealed token out of everything that comes
from the far end: the status-error snippet, the pipeline-level error, and the
engine text carried by `RemoteError`. The test asserts both that the token is
absent and that `[REDACTED]` is present, so quietly dropping the whole message
would not pass.

The Go tree is deleted at the end of this migration, so it was left as is. If
this migration is ever abandoned or paused with a release cut from the Go tree,
that fix has to be made there.

## One copy of the browser API layer

The two front ends over the viewer's API — the local one `tdo serve` puts on
a port and the standalone PWA — were ported one after the other, and the
second one arrived as a copy. `packages/pwa/src/api.ts` was
`packages/cli/src/web/api.ts` byte for byte under a header saying so, and
`statusOf`, the `{"error":{code,message}}` envelope and the request mutex were
adapted a second time into `packages/pwa/src/router.ts`. A test diffed the
copies. That is a tripwire, not a fix: two front ends disagreeing about what
completing a repeating item does is the drift this migration was done to
prevent, and `app.js` is the same script in both, reading
`payload.error.message` and switching on a status code.

What stopped it being one module was packaging, not portability:
`@todocloud/cli` exports only `.`, so no specifier reaches into its
`src/web/`, and a relative path across the package boundary would have made
the PWA depend on `@todocloud/store-sqlite`, which imports `node:sqlite`. So
the module moved into the one package both front ends already depend on:

- `packages/core/src/webapi/api.ts` — the endpoints, reachable as
  `@todocloud/core/webapi`.
- `packages/core/src/webapi/http.ts` — `statusOf`, `errorEnvelope`,
  `messageOf`, `Mutex` and the two path matchers (`exact`, `taskPath`), as
  `@todocloud/core/webapi/http`.

Both stay out of the `index.ts` barrel, for the reasons `store/schema.ts`,
`output/*` and `taskops/*` do: `Req`, `Handler`, `Mutex` and `exact` are
names a front end wants for itself, and `statusOf` reads like a task's status
at the top level. `web.ts` and `router.ts` re-export `maxBodyBytes`, `Mutex`
and `statusOf` under the names they already had there, so nothing downstream
of either front end changed.

What each front end keeps is its transport, which is the half that was never
shared: `web.ts` reads a body off a socket, checks the per-process write
token and writes a `ServerResponse`; `router.ts` builds the `Req` in the tab,
returns a `Response`, and has no token because there is no listener to
protect.

The assets went the other way: they stayed put. `packages/cli/assets` is
read from disk by `web.ts` relative to the module and embedded into the
compiled executable with `--asset` by `scripts/build-binary.mjs`, so moving it
would have meant changing both for no gain. `packages/pwa`'s build copies `app.js`, `app.css`
and the three icons out of it instead of holding a second copy. Its `sw.js`,
`manifest.webmanifest`, `index.html` and `connect.css` remain its own: the
caching policy differs by design (§8.2 of `PLAN.md`), and so does the connect
screen, which the local viewer has no need of.

**The viewer's assets are a runtime dependency now.** Go embedded
`internal/web/assets` with `go:embed`, so a missing asset was a build failure.
`packages/cli/src/web/web.ts` resolves `packages/cli/assets` relative to the
module and reads it at startup, so a `tdo` shipped without that directory
beside the module fails when the server starts instead. The failure names the
file and the directory it looked in, and `packages/cli/package.json` lists
`assets` in `files`. Whatever ships has to carry the directory. There
is one route now — the compiled executable, which embeds it with `--asset`,
where `packages/cli/src/respath.ts` finds it at `/$bunfs/root/assets`. There
were two while the npm packages existed, and the staged tarballs carried a
copy beside the emitted modules; see "Distribution: a single executable"
below. `packages/cli/package.json` still lists `assets` in `files`, as the
declaration that it is not build output.

## Two Go bugs the port does not carry over

**The `%w` chain was being dropped.** Go wrapped with
`fmt.Errorf("sqlite: %s: %w", path, store.ErrNotInitialized)` and printing the
result gave both halves on one line. The port carries a sentinel as `cause`
instead, and `Printer.fail` wrote only `err.message` — so `tdo ls` against a
path with no store printed `tdo: sqlite: /path/tasks.db` and lost the
`run `tdo init`` advice that `docs/agents.md` promises. `flatten()` in
`packages/core/src/output/output.ts` walks the `cause` chain, skipping a cause
whose text the wrapper already quoted, since some wrappers in this tree follow
Go's other habit and interpolate it. This was a regression in the port, not a
Go bug, and it is fixed with four tests.

**`tdo tag ls` ran every row onto one line.** Go's `Printf` appends no newline,
unlike `Warnf`, and `internal/cli/tags.go:215` and `:171` passed no `"\n"`, so
the listing came out as `errand 1home 1` and the removal line ran into the
shell prompt. The port adds the newline. Human output is not the documented
`--json` shape, so there is nothing to preserve here, and shipping a known
unusable rendering to stay faithful serves nobody.

## Distribution: a single executable

`tdo` ships as one file the user can run with no runtime installed, which is
the property `PLAN.md` §1 gave up when the project left Go. How that file is
produced changed once, and the reversal is worth recording in full, because
the first answer was not wrong and the second one won on measurement.

**Node is not leaving.** It is still the development runtime, still what
`npm test` runs, and still pinned in `mise.toml`. Only the shipped executable
changed hands.

### First answer: a Node single executable application

The first build was `node --build-sea`, driven by `scripts/build-sea.mjs`
(`make sea`). It worked, and three things about it are the reason the tree
looks the way it does even now.

**The embedded code had to be JavaScript.** A SEA does not strip types: an
embedded `.ts` failed at import with a syntax error on the first type
annotation. The root `tsconfig.build.json` emitted JS for that. It outlived
the SEA, because the npm packages needed the same emit for a consumer's Node;
it went with them. The only `tsconfig.build.json` left is
`packages/pwa`'s, which emits for the browser.

**Building required an official Node 25.5 or newer.** `--build-sea` searched
the node binary for a fuse sentinel, and Homebrew's node does not carry it;
the build failed with "sentinel ... not found". That requirement reached into
`mise.toml`, `README.md`, `CONTRIBUTING.md`, both workflows and this file, and
it is the single largest thing the change deleted.

**A virtual file system restored `go:embed`.** The embedded files were mounted
read-only, so `packages/cli/assets` rode inside the executable and `tdo serve`
read it with ordinary `fs` calls. The main script sat at the root of the mount
as a one-line boot shim with the real tree under
`node_modules/@todocloud/<pkg>/`, mirroring the on-disk layout — which is what
kept both kinds of resolution working: a bare specifier
(`@todocloud/core/secret`) walked up to `node_modules`, and `web.ts`'s
`../../assets` landed where it does on disk.

It cost **110 ms** to start and **140 MB** on disk, and it could not produce a
macOS x64 executable at all.

### Second answer: `bun build --compile`

`scripts/build-binary.mjs` (`make binary`, `ARGS=--all`) compiles the
executable with Bun instead. Measured on this machine, twenty runs of
`tdo --help` each:

| | |
| --- | --- |
| `bun build --compile` | **33 ms** |
| bun running the `.ts` sources | 41 ms |
| node + emitted JS + the compile cache | 86 ms |
| the Node SEA it replaced | 110 ms |
| node running the `.ts` sources | 121 ms |
| `node -e 0`, Node's floor | 43 ms |
| Bun's own floor | 7 ms |
| the Go binary this replaced, measured | 16 ms |

Two readings of that table matter more than the headline.

**The win is mostly the floor, not the bundle.** Node cannot start in less
than 43 ms on this machine, so 86 ms was close to as good as a Node-hosted
`tdo` was ever going to get, and the SEA was slower still. Bun's floor is 7 ms
and the bundled `tdo` lands 26 ms above it. Nothing in the old arrangement had
that lever: bundling the 66 modules was named here as the remaining one and
rejected for costing a bundler, and Bun is a bundler that arrived attached to
the engine.

**The Go binary was never 5 ms.** `PLAN.md` said "roughly 5 ms" and this
document repeated it; the binary that was actually installed on the
maintainer's machine runs `tdo version` in **16 ms**, measured the same way as
every other row. So the honest comparison is that the shipped executable
starts in about twice the time the Go one did — not twenty times, which is
what the unmeasured figure implied, and not the same, which is what a broken
measurement briefly suggested (see below).

**`--bytecode` is not used, and the reason is a bug it hides.** Bun emits a
bytecode cache only for a CommonJS bundle, and `tdo` is structured to allow
that — `main.ts` has no top-level `await`. The flag does cut startup to about
15 ms, which is faster than Go. It also changes `import.meta.dirname` from
`/$bunfs/root` to **the source directory on the build machine**, baked into
the binary, which makes every `--asset` unreachable. On the machine that built
it, that path still exists, so `tdo version` and `tdo serve` appear to work
while reading whatever is on disk there: one build reported the version of a
stray `package.json` in a temporary directory. On a user's machine the path
does not exist and both fail. It was caught by installing the binary and
running it from an unrelated directory, which is now what
`scripts/install-local.sh` and the smoke test do. `scripts/build-binary.mjs`
carries the long version of this warning; the flag can come back when Bun
resolves embedded files consistently, proven by running the result from
somewhere that has nothing to do with the build.

**Size went down rather than up**: the host binary is **71 MB** with
`--bytecode`, against the SEA's 140 MB. Still an order of magnitude past the
8–15 MB static binary Go produced, and still not reducible from here, because
what it carries is a JavaScript engine.

**But the deciding fact was neither.** It was the target list. Bun
cross-compiles every supported platform from one machine — verified from
darwin arm64, producing `linux_amd64` 90 MB, `linux_arm64` 90 MB,
`darwin_amd64` 79 MB, `darwin_arm64` 71 MB and `windows_amd64` 95 MB — so the
release collapsed from a four-runner native matrix to one job, and
**macOS x64 ships again**. Under the SEA an Intel Mac had no archive and no
Homebrew bottle, and `README.md`, the formula and this document all sent that
user to npm instead. Those sentences are gone, the formula's `on_intel` branch
is back, and the npm channel they pointed at is gone too — see "The npm
channel, and why it closed" below. A performance number can be argued about; a
platform with nothing to download cannot.

**`--asset` is the new `go:embed`.** Go embedded `internal/web/assets` with
`go:embed`, so a missing asset was a build failure; the VFS above restored
that for the SEA. Bun does it with `--asset`, which embeds a file or directory
beside the entry point under its own basename, so `packages/cli/assets`
arrives as `/$bunfs/root/assets` and `packages/cli/package.json` — read by
`tdo version` — as `/$bunfs/root/package.json`. There is no directory tree to
walk up inside a compiled binary: every module reports `import.meta.dirname`
as `/$bunfs/root`. `packages/cli/src/respath.ts` is what squares that with the
layouts that do have a tree — the source checkout, and, while they lasted, an
npm install and the SEA — by probing both candidate paths rather than sniffing
for a runtime.
The build smoke-tests `tdo version` and `tdo serve` for exactly this reason: a
missing `--asset` compiles cleanly and fails at first run.

### What Bun costs

It is a second toolchain in `mise.toml` and a second thing to install before
the release path works, where Node alone used to be enough.

It is a different JavaScript engine. The suite passes on both — Node
`npm test` reports 1142 passing and `bun test` 833, the counts differing
because the two runners count subtests differently rather than because tests
are missing — and CI runs both, on all three OSes, so a divergence shows up
before a release rather than in it. That is not free: it is a second matrix to
keep green, and it exists because shipping a binary built on an engine the
tests never ran on is the thing worth paying to avoid.

It depends on two young features. `--asset` and `--bytecode` are both recent,
and `--bytecode` additionally requires a CommonJS bundle, which has no
top-level `await` — so `packages/cli/src/main.ts` wraps its startup in an
async function, and a top-level `await` reintroduced there breaks the release
build rather than a test. Bun is pinned to an exact version in `mise.toml`
because of this: the binary embeds that runtime, so a drifting local Bun would
produce a differently behaving `tdo` from the same source.

**What would make this worth reconsidering.** If Node's own startup floor came
down far enough that running on the user's Node were competitive with 32 ms,
the engine argument would mostly evaporate, and a single toolchain would be
worth something. If Node's SEA grew macOS x64 support and cross-building, the
platform argument — the one that actually decided this — would go with it. And
if `--asset` or `--bytecode` broke in a way that could not be pinned around,
the fallback is not the SEA but `bun build` without `--compile` plus a runtime,
which is a different trade again.

### The npm channel, and why it closed

For a while `tdo` was also an npm package — `todocloud`, plus the three
`@todocloud/*` libraries it depends on — and the decision to add it was a
sound one at the time, so it is recorded rather than quietly removed.

**Why it existed.** One reason, and not a hedge: the Node SEA could not
produce a macOS x64 executable at all. An Intel Mac therefore had no archive
and no Homebrew bottle, and `npm install -g todocloud` was the only way for
that user to get the tool. Everything else npm offered — `tdo` on the Node you
already have, a platform with no archive, a few hundred kilobytes instead of
seventy-odd megabytes — was real but secondary. A platform with nothing to
download is not a preference.

**What closed the gap.** `bun build --compile` cross-compiles every supported
target from one machine, `darwin_amd64` (79 MB) with the rest. The Intel Mac
has an archive and a bottle again, and the reason npm existed went with it.
The performance comparison then went the other way too: the compiled binary
starts in **32 ms** against **84 ms** for the same code on a user's Node, so
what was left was the slower of the two routes as well as the narrower one.

**What keeping it cost.** An npm scope to own and a package name to keep
holding. A publish token in the repository's secrets, which is one more place
a credential can leak from (`CLAUDE.md` §1). A publish-time staging
transformation — `scripts/pack-npm.mjs` — because the manifests in
`packages/` point at `.ts` for development and a consumer's Node needs
emitted `.js`, so the shipped manifests were never the ones in the tree, and
with it a second `tsc` emit configuration that nothing else needed. And four
packages that had to be published in dependency order, because `todocloud`
pins exact versions of the three libraries and a wrong order leaves the first
`npm install -g todocloud` unresolvable.

That is permanent maintenance for a channel nothing needs any more, so it is
gone: the `npm-publish` job, its token, the staging script and the root
`tsconfig.build.json`. `scripts/set-version.mjs` stays, because the version
still enters the build by being written into `packages/cli/package.json` and
read back out of the embedded copy.

**What the removal does not undo.** `@todocloud/*` is still how the workspace
packages name each other, and every such import in the source is correct —
those specifiers resolve through the `exports` maps to `src/*.ts`, which is
what "no build step" rests on. The names were never the registry; publishing
them was.

## Where the migration ended

The Go tree is gone: no `.go` file, no `go.mod`, no Go toolchain pinned. What
replaced it, measured on the finished tree:

| | Go | TypeScript |
| --- | --- | --- |
| Source | 20,070 lines, 66 files | 31,049 lines, 70 files |
| Tests | 17,920 lines, 74 files | 20,115 lines, 60 files |
| Passing tests | — | 1,125 |
| Direct dependencies | 4 | **0** |
| Commands | 33 | 33 |

The source grew by about half. Most of it is the comments the port carried over
plus the ones explaining where TypeScript forced a different answer, and the
hand-written replacements for things Go had in its standard library: a SHA-256
for `Secret.hint()`, a ULID generator, a PNG encoder for the icons, a `%w`-chain
flattener, and the seeded property tests that stand in for Go's fuzzing.

This document is the record of what the port decided. It is not deleted with
the Go tree, because every decision in it is still load-bearing — the async
`Store`, the dropped `context.Context`, the `node:sqlite` integer binding, the
two Go bugs not carried over, and the distribution trade.
