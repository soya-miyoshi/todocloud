# Contributing

## Setup

Two runtimes, both pinned in `mise.toml`, so `mise install` gets you both.

**Node** (26.12.0 there) is the development runtime: it runs the `.ts` sources
directly, it runs `npm test`, and it is what the published npm package
executes on a consumer's machine. Any Node 24 or newer will do — that is what
`engines` names, because that is where `node:sqlite` became stable — and the
pin is simply the one version the tree is developed and tested against. There
used to be a 25.5-and-official-build-only requirement here; it was Node's own
single-executable build searching the node binary for a sentinel string that
Homebrew's node does not carry, and that build is gone, so the requirement is
too.

**Bun** (1.4.3 there) builds the shipped executable, and nothing else. It is
pinned for the same reason Node is and one more: the compiled binary embeds
that exact Bun runtime, so the pinned version is the one every user who
downloads an archive ends up running. The test suite is run under it as well
as under Node in CI, because shipping a binary built on an engine the tests
never ran on is the thing to avoid.

```sh
git clone https://github.com/soya-miyoshi/todocloud
cd todocloud
make hooks     # installs the pre-commit secret scan — do this before anything else
npm ci
make check     # type-check, tests, secret scan
```

`make check` is the whole gate: `tsc --noEmit` over every package, the tests
and the secret scan. There is no build step in development — Node runs the
TypeScript directly by stripping types, and `packages/*` resolve each other
through their `exports` maps straight to `src/*.ts`. The tests need no network
access, no provider CLI and no credential of any kind.

Two more targets matter when you are near the release path:

- **`make binary`** compiles the single executable into `dist-bin/tdo`, which
  is what a user actually installs; `make binary ARGS=--all` cross-compiles
  every target this machine ships, which Bun can do for all five from one
  host. There is no emit step ahead of it — Bun bundles and transpiles the
  TypeScript itself — and `packages/cli/assets` and
  `packages/cli/package.json` are embedded with `--asset`, which is what
  replaced Go's `go:embed` for the viewer's files and the version string.
  `packages/cli/src/respath.ts` resolves both inside the executable and on
  disk. The build smoke-tests
  whatever it built for this host before it exits; read the header of
  `scripts/build-binary.mjs` for the four things about it that are not
  obvious.
- **`make icons`** redraws the viewer's icons into `packages/cli/assets` with
  `scripts/genicon.mjs`. Run it only when the mark changes; the PNGs are
  committed so that they can be rebuilt rather than merely replaced.

The project has **zero runtime dependencies**. `typescript` is the only
devDependency, plus `@types/node`.

## Tests

`npm test` runs `node --test` over every `packages/*/src/**/*.test.ts`. What is
in there, so that a new test has a place to go:

- **In-process command tests** (`packages/cli/src/*.test.ts`) drive the
  commands through the same tree `src/main.ts` runs, against a temporary
  SQLite database and a temporary state directory, capturing both streams.
  `packages/cli/src/testsupport.ts` is that harness: use it rather than
  building a second one. Nothing in it reaches the developer's own config,
  database or keychain — the environment is injected and the keychain lookup is
  a stub.
- **The shared provider conformance suite** (`packages/store-testkit`) is the
  specification every provider is held to: the tree rules, availability,
  completion with the last action, and the migration harness described below.
  A behaviour asserted there is asserted for every provider at once, and that
  suite is the reason this project was ported off Go at all — the CLI, the
  local viewer and the PWA cannot be allowed to disagree about what is
  available. A provider's own `conformance.test.ts` is two imports and a call:
  `run(() => new SqliteStore(':memory:'))`, where the factory returns a
  **fresh, empty** store and must not call `init`, because `init` on an empty
  store is one of the things being checked. `run` registers one `node:test`
  test per sub-suite; nothing has to be awaited. The migration harness is a
  second entry point (`runMigrations`) because it needs the raw SQL access the
  `Store` interface deliberately does not offer. Read the header of
  `packages/store-testkit/src/index.ts` before adding to it.
- **Four seeded property tests**, one for each of Go's four fuzz targets: the
  TOML parser (`packages/cli/src/toml.test.ts`), `parseValue`
  (`packages/core/src/task.test.ts`), the import decoder
  (`packages/cli/src/import_fuzz.test.ts`) and `databaseFromURL`
  (`packages/core/src/providercli.test.ts`). `node --test`
  has no fuzzer, so each target was ported as a property test over a
  hand-written PRNG with a **fixed seed**: every corpus entry Go added with
  `f.Add` survives as an explicit case, and the inputs the engine would have
  evolved are generated instead. The fixed seed keeps the one thing a fuzz
  target is for — a failure that replays, to the iteration, from the seed
  printed in the message. Be clear-eyed about what was lost: coverage guidance.
  These inputs come from a hostile grammar rather than being evolved towards
  new branches, so this is a weaker instrument than a real fuzzer, and it is
  not a reason to decline one if the tree ever gains the means to run one.
- **A browser-safety invariant** (`packages/core/src/browser-safe.test.ts`)
  fails if any non-test source under `packages/core` imports a `node:*`
  module. The PWA imports `core`, so such an import breaks the browser build,
  and the one line that does it is always added for a good local reason in a
  file nobody is reviewing. It reads the sources as text rather than importing
  them, because an import that resolves under Node is exactly the failure
  being looked for.
- **Two whole-table invariants** in the command layer, which is where the
  project's central promises are asserted as a matrix rather than as
  assertions scattered over the command tests.
  `packages/cli/src/credential_matrix.test.ts` populates every credential
  source at once — both token environment variables, a guarded config file,
  the keychain and a provider CLI that mints a token — and then walks every
  registered command asserting that no sentinel value reaches stdout or
  stderr, in plain, `--json`, `--debug` and both.
  `packages/cli/src/schema_mismatch.test.ts` asserts that no command reads or
  writes a store at a schema version this binary does not write, in either
  direction, and that a command which refused also left the recorded version
  alone.
- **The built executable is exercised in CI, not here.** Go had an end-to-end
  suite under `cmd/tdo` that built the binary and drove it as a subprocess;
  compiling the executable takes too long to belong in `npm test`. The
  `binary` job in `.github/workflows/ci.yml` cross-compiles every target in
  one job and then runs the host one through `scripts/smoke.sh` — `--help`,
  `version --json`, `init`, `add`, `ls --json`, `tag ls`, `done` against a
  throwaway store. That is the shape of failure the asset layout really has:
  the viewer's files and the manifest are embedded with `--asset` and read
  back from `/$bunfs/root`, so a missing one compiles cleanly and fails at
  the first `tdo serve` or `tdo version`. The cross-built binaries are only
  built, since the runner cannot exec them.

  Never run a `tdo` you just built except through `scripts/smoke.sh`. A bare
  invocation finds the real config at `~/.config/todocloud/config.toml` and
  writes to whichever provider is configured there; the header of that script
  records the two times that happened.

A test must never touch the developer's real config, database, keychain or
provider CLI: the seams for injecting fakes already exist, so use them rather
than reaching for `$HOME`.

## Ground rules

1. **Never commit a credential.** Not in tests, fixtures, docs or examples.
   Nothing here needs one: tests use local SQLite and a `node:http` fake
   server, and examples use obvious placeholders (`libsql://example.turso.io`,
   `TOKEN_GOES_HERE`). Never commit with `--no-verify`. If you think a secret
   has been committed, say so in an issue-free channel (a security advisory) and
   revoke the token first — rewriting history does not undo exposure.

   CI installs gitleaks by version *and* SHA256, because that job reads the
   whole history and a tag by itself does not detect a release asset replaced
   after publication. Raising the version in `.github/workflows/ci.yml` means
   raising the hash with it, taken from that release's own
   `gitleaks_<version>_checksums.txt`.
2. **English only in the repository** — code, comments, docs, CLI strings,
   commit messages, PRs, issues.
3. **The direct dependency set is empty, and that is the design.** Node covers
   what the Go standard library and the four Go dependencies covered:
   `node:sqlite` (built in, so there is still no native build step),
   `node:util`'s `parseArgs` under a hand-written subcommand dispatcher,
   `node:tty`'s `isatty`, a hand-written ULID over `crypto.getRandomValues`,
   and a hand-written TOML subset. A CLI framework is deliberately not used:
   exit code `2` for usage errors and the exact `--json` shapes in
   `docs/agents.md` are contracts, and a framework owns both. Adding anything —
   runtime or dev — needs a reason in the PR description and maintainer
   agreement. `typescript` and `@types/node` are the only devDependencies.
4. **`packages/core` must not import `node:*`.** The PWA imports it, so an
   import the browser cannot resolve breaks that build; code that needs Node
   belongs in `packages/cli`, `packages/store-sqlite` or, as `providercli`
   does, behind an installable seam that `packages/cli` fills in. The
   invariant test above enforces this, and a failure names the move to make.
5. **Secrets never become flags.** There is no `--token` flag and there must
   never be one; `argv` is world-readable and lands in shell history. For the
   same reason a secret is never passed to a subprocess in `argv` — `tdo login`
   and the keychain code move tokens on stdin. `tdo login` writes to the OS
   keychain and nowhere else: never into a file `tdo` manages, never to disk in
   plaintext.
6. **No network access in tests.** `npm test` passes offline.
7. **Machine output on stdout, human output and logs on stderr.** Every command
   supports `--json`; changing a `--json` shape or an exit code is a breaking
   change and needs a version bump and a note in `docs/agents.md`.

## Adding a schema version

The schema lives in `packages/core/src/store/schema.ts`, once, for every
provider: both shipped providers speak the SQLite dialect, so a ladder kept per
provider is a ladder that gets a step added to one and forgotten in the other —
and the store that forgets is the one in somebody's cloud account, which has no
transaction over the wire and nothing to restore from.

To add a version:

1. **Freeze the current DDL.** Copy the statements the live DDL creates today
   into `historical.ts` verbatim, as `historicalV<N>`, and register it in the
   `historical` map. A literal copy, never a reference to the live DDL — the
   copy is the whole value of the file.
2. **Edit the live DDL** in `schema.ts` so that a fresh store is created at the
   new version directly. A new install should not replay history.
3. **Append a `Step`** to the ladder with `to` set to the new version, a name
   `tdo migrate` can print, and the statements that carry an existing store
   there.
4. **Bump `Version`.** The module validates the ladder — contiguous, named,
   non-empty, reaching `Version` — and throws otherwise, so a mismatch fails
   every test that touches a store rather than some user's database.

Two rules hold for every statement, both because the Turso provider has no
transaction to hide behind:

- **Idempotent.** The version is recorded after the step, in a separate round
  trip, so a migration interrupted between the two leaves a store whose
  statements ran and whose version did not move. The next `tdo migrate` runs
  the step again and it must succeed. In practice: `CREATE ... IF NOT EXISTS`,
  `UPDATE ... WHERE` the row still needs it, and a backfill that changes
  nothing the second time. SQLite has no `ALTER TABLE ADD COLUMN IF NOT
  EXISTS`, so a step that adds a column rebuilds the table through a temporary
  one, itself created `IF NOT EXISTS`.
- **Forward-only.** There is no down step. A mistake is corrected by a further
  step, because the user's data has already moved.

One more rule is specific to this runtime: **bind a whole number as a
`BigInt`.** `node:sqlite` binds a JS number as REAL, so `2` written into the
TEXT version marker became `"2.0"` where every other writer puts `"2"`. The
conformance suite caught that on its first run against a real provider;
`MIGRATION.md` records it, and `packages/store-sqlite` routes the version
marker, `position`, `estimated_minutes` and the boolean columns through its
`intBind()`.

Then let the conformance harness decide. `packages/store-testkit` builds a
store from every frozen historical schema, fills it with representative data,
runs the provider's own migration, and asserts both that the data still means
what it meant — read back through the `Store` API, not through SQL — and that
the resulting schema is the schema `init` writes today, compared through the
engine's catalogue rather than through DDL text. An `init` and a `migrate` that
quietly produce different schemas is the bug that shows up a year later on
exactly the installs nobody can restore.
`packages/store-sqlite/src/migration.test.ts` walks the same ladder directly as
well, because SQLite is the reference provider: a broken ladder is broken here
first, and this package should say so whether or not the shared suite is
present.

A check that has never rejected anything is not a check to trust with a
database that cannot be rolled back, which is why the harness exports
`ladderDiff`: it returns the difference between the two stores as text instead
of failing, so a test can hand the harness a deliberately drifting ladder and
assert that it is rejected and that it names what differs. **Nothing calls
`ladderDiff` yet** — the Go tree proved the harness against a toy ladder in
`internal/store/sqlite/harness_test.go`, and that self-test was not ported.
Writing it back is the next thing anyone touching the migration machinery
should do.

## Cutting a release

Releases are made by pushing a tag. Nothing else triggers
`.github/workflows/release.yml`, and nothing in it can be started by a fork.

```sh
git tag v0.1.0        # vMAJOR.MINOR.PATCH; the workflow rejects anything else
git push origin v0.1.0
```

What then happens, in order:

1. **verify** — `npm ci`, the type-check, and the tests under **both**
   runtimes against the tree being tagged: `npm test` because that is what an
   npm install runs, `bun test` because that is the engine the archives
   carry. A release that cannot be unpublished from the machines that already
   downloaded it is not cut from an unchecked tree.
2. **meta** — the version is parsed out of the tag once, in one place, rather
   than in each build job.
3. **build** — **one job** that compiles every executable: linux amd64 and
   arm64, darwin amd64 and arm64, windows amd64. `bun build --compile
   --target=...` cross-compiles all five from a single Ubuntu runner, which is
   the property `CGO_ENABLED=0` gave Go and the Node SEA took away — a SEA is
   the *target platform's own* node binary with code injected into it, so it
   needed a runner per platform. **darwin amd64 is back** with the change:
   Node could not build a macOS x64 executable at all, and an Intel Mac had to
   install from npm. It no longer does. **windows arm64** is still absent, and
   that was never a build-host question — it is not in the target list in
   `scripts/build-binary.mjs`, and adding it is a change to that list.

   There is no linker to stamp a version in with, so the job's first step
   writes the tag into the shipped `packages/*/package.json` with
   `scripts/set-version.mjs`, before anything is built.
   `packages/cli/src/admin.ts` reads its own manifest, and
   `scripts/build-binary.mjs` embeds that same file into the executable with
   `--asset` and names each output directory after the version it read from
   it, so the number arrives by the route a Node package's version always
   travels. That one step is also what the npm job runs, so there is exactly
   one place a version enters the build; `TODOCLOUD_VERSION` stays a developer
   override and the release never sets it. It replaced two separate hacks — a
   rewrite of the Node SEA's boot shim and a regex patch of the emitted
   `admin.js` — which `scripts/set-version.mjs` records in full.
   `TODOCLOUD_COMMIT` is still an environment variable, because a git SHA has
   no home in a manifest, and nothing bakes it in, so a released binary
   reports an empty commit. Then the job asks the **host** executable for
   `version --json`: a tag claiming 1.2.3 that produces a binary saying
   something else fails the build rather than being discovered by someone
   debugging the wrong version. It can only be the host one now that four of
   the five are cross-built, and that is enough, because all five embed the
   one manifest that step wrote. Each archive is
   `tdo_<version>_<os>_<arch>.tar.gz` (`.zip` for windows, written with `zip`
   on the Linux runner that built it rather than `7z` on a Windows one).
4. **publish** — the per-platform artifacts are gathered, `SHA256SUMS` is
   computed once over the whole set, and `gh release create --verify-tag`
   attaches the archives and the checksums with generated notes. A tag
   containing a `-` is published as a prerelease.
5. **homebrew** — writes `Formula/tdo.rb` into `soya-miyoshi/homebrew-tap`
   with four URLs and their checksums: macOS arm64 and Intel, Linux arm64 and
   Intel, each under its own `on_arm`/`on_intel` branch. The macOS `on_intel`
   branch is new again — the formula used to carry `depends_on arch: :arm64`
   so brew would refuse on an Intel Mac rather than install an archive it
   could not exec, because there was no such archive. There is one now. This
   writes to a *different* repository, so it needs a `HOMEBREW_TAP_TOKEN`
   secret; `GITHUB_TOKEN` cannot reach the tap. Without that secret the job
   skips and the release still happens — a missing token costs a
   `brew upgrade`, not a release. A prerelease tag never touches the tap, and a
   formula that already matches is not re-pushed.

The token reaches git through a credential helper reading stdin, not through
the remote URL: a URL ends up in `.git/config`, in the process list and in any
error message that echoes the remote.

The size of what ships is worth knowing before you are surprised by it: the
executable carries a whole JavaScript engine, so the host build is **71 MB**
and the largest target is **95 MB**, against the 8–15 MB static binary Go
produced. That is not reducible from here. It is also the fastest of the ways
to start the tool, at **32 ms** — `MIGRATION.md` has the measurements and what
they bought.

## Commits and PRs

Small, focused commits with an imperative subject line (`Add Turso store`).
Explain *why* in the body when it is not obvious. A PR should say what it
changes, how it was tested, and whether it touches the `--json` contract.
