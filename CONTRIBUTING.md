# Contributing

## Setup

Go 1.27 or newer is required to build. The toolchain is pinned for this
repository in `mise.toml`, so `mise install` picks up the pinned version if you
use mise; plain `go build` works for everyone else. (CI builds with
`go-version: stable`, not the pinned version.)

```sh
git clone https://github.com/soya-miyoshi/todocloud
cd todocloud
make hooks     # installs the pre-commit secret scan — do this before anything else
make check     # gofmt, go vet, go test, secret scan
```

`make check` is the whole gate: it runs `gofmt`, `go vet`, the tests and the
secret scan. The tests need no network access, no provider CLI and no
credential of any kind.

## Tests

What `make check` runs, so that a new test has a place to go:

- **In-process command tests** (`internal/cli`) drive the commands through the
  same entry point `main` uses. They include a credential-leak matrix that
  asserts no sentinel token reaches stdout or stderr for any command, in plain,
  `--json`, `--debug` and both modes.
- **An end-to-end suite** (`cmd/tdo`) builds the real binary and drives it as a
  subprocess: the exit-code contract, file permissions, several processes
  running at once, and the invariant that only `tdo init` creates a store while
  nothing deletes one. It skips under `go test -short`.
- **Four fuzz targets**: the TOML parser, `task.ParseValue`, the import decoder
  and `providercli.DatabaseFromURL`. `go test ./...` runs their seed corpora; a
  longer run is explicit, e.g.
  `go test -run XXX -fuzz FuzzParseTOML -fuzztime 30s ./internal/config/`.
- **A shared provider conformance suite** (`internal/store/storetest`) is the
  specification both providers are held to: the tree rules, availability,
  completion with the last action, and the migration harness described below.
  A behaviour asserted there is asserted for every provider at once.
- **`go test -race ./...`** is expected to pass, and is worth running before a
  change to anything concurrent.

A test must never touch the developer's real config, database, keychain or
provider CLI: the seams for injecting fakes already exist, so use them rather
than reaching for `$HOME`.

## Ground rules

1. **Never commit a credential.** Not in tests, fixtures, docs or examples.
   Nothing here needs one: tests use local SQLite and `httptest` fake servers,
   and examples use obvious placeholders (`libsql://example.turso.io`,
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
3. **Standard library first.** The direct dependency set is exactly four:
   `github.com/urfave/cli/v3` (the CLI framework), `modernc.org/sqlite` (pure
   Go, so `CGO_ENABLED=0` keeps working), `github.com/oklog/ulid/v2`, and
   `github.com/mattn/go-isatty`. isatty is needed so `tdo rm --purge` refuses
   rather than prompts when stdin is not a terminal; `os.ModeCharDevice` is not
   sufficient, because `/dev/null` is a character device too, and isatty was
   already in the module graph as a dependency of `urfave/cli`, so it adds no
   new supply-chain surface. Adding anything else needs a reason in the PR
   description and maintainer agreement — including a Google auth library,
   which the removed Firestore provider managed without (PLAN.md §2). `CGO_ENABLED=0` must keep
   working on darwin, linux and windows for amd64 and arm64, so no cgo.
4. **Secrets never become flags.** There is no `--token` flag and there must
   never be one; `argv` is world-readable and lands in shell history. For the
   same reason a secret is never passed to a subprocess in `argv` — `tdo login`
   and the keychain code move tokens on stdin. `tdo login` writes to the OS
   keychain and nowhere else: never into a file `tdo` manages, never to disk in
   plaintext.
5. **No network access in tests.** `go test ./...` passes offline.
6. **Machine output on stdout, human output and logs on stderr.** Every command
   supports `--json`; changing a `--json` shape or an exit code is a breaking
   change and needs a version bump and a note in `docs/agents.md`.

## Adding a schema version

The schema lives in `internal/store/schema`, once, for every provider: both
shipped providers speak the SQLite dialect, so a ladder kept per provider is a
ladder that gets a step added to one and forgotten in the other — and the store
that forgets is the one in somebody's cloud account, which has no transaction
over the wire and nothing to restore from.

To add a version:

1. **Freeze the current DDL.** Copy the statements `Initial()` returns today
   into `historical.go` verbatim, as `historicalV<N>`, and register it in the
   `historical` map. A literal copy, never a reference to the live DDL — the
   copy is the whole value of the file.
2. **Edit the live DDL** in `schema.go` so that a fresh store is created at the
   new version directly. A new install should not replay history.
3. **Append a `Step`** to `steps` with `To` set to the new version, a name
   `tdo migrate` can print, and the statements that carry an existing store
   there.
4. **Bump `Version`.** The package's `init` validates the ladder — contiguous,
   named, non-empty, reaching `Version` — and panics otherwise, so a mismatch
   fails every test in the module rather than some user's database.

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
- **Forward-only.** There is no `Down`. A mistake is corrected by a further
  step, because the user's data has already moved.

Then let the conformance harness decide. `internal/store/storetest` builds a
store from every frozen historical schema, fills it with representative data,
runs the provider's own `Migrate`, and asserts both that the data still means
what it meant — read back through the `Store` API, not through SQL — and that
the resulting schema is byte-for-byte the schema `Init` writes today, compared
through the engine's catalogue rather than through DDL text. An `init` and a
`migrate` that quietly produce different schemas is the bug that shows up a
year later on exactly the installs nobody can restore.

The harness proves itself rather than asking to be trusted: the shipped ladder
is still empty, so `internal/store/sqlite/harness_test.go` runs it over a
test-only toy ladder twice — once with a correct step, which must pass, and
once with a deliberately drifting step whose column has lost its `NOT NULL` and
whose index was never created, which must be rejected and must name what
differs. A check that has never rejected anything is not a check to trust with
a database that cannot be rolled back.

## Cutting a release

Releases are made by pushing a tag. Nothing else triggers
`.github/workflows/release.yml`, and nothing in it can be started by a fork.

```sh
git tag v0.1.0        # vMAJOR.MINOR.PATCH; the workflow rejects anything else
git push origin v0.1.0
```

What then happens, in order:

1. **verify** — `go vet`, `go test -race ./...` and a `gofmt` check against the
   tree being tagged. A release that cannot be unpublished from the machines
   that already downloaded it is not cut from an unchecked tree.
2. **build** — `CGO_ENABLED=0` builds for darwin, linux and windows × amd64 and
   arm64, each as `tdo_<version>_<os>_<arch>.tar.gz` (`.zip` for windows), plus
   a `SHA256SUMS` file. The version and the commit are stamped in with
   `-ldflags -X`, and the linux/amd64 binary is unpacked and asked for
   `version --json`: a tag claiming 1.2.3 that produces a binary saying
   something else fails the build rather than being discovered by someone
   debugging the wrong version.
3. **publish** — `gh release create --verify-tag` with the archives and the
   checksums attached, and generated notes.
4. **homebrew** — writes `Formula/tdo.rb` into `soya-miyoshi/homebrew-tap` with
   the four macOS and Linux URLs and their checksums. This writes to a
   *different* repository, so it needs a `HOMEBREW_TAP_TOKEN` secret;
   `GITHUB_TOKEN` cannot reach the tap. Without that secret the job skips and
   the release still happens — a missing token costs a `brew upgrade`, not a
   release. A prerelease tag (one containing a `-`) never touches the tap, and
   a formula that already matches is not re-pushed.

The token reaches git through a credential helper reading stdin, not through
the remote URL: a URL ends up in `.git/config`, in the process list and in any
error message that echoes the remote.

## Commits and PRs

Small, focused commits with an imperative subject line (`Add Turso store`).
Explain *why* in the body when it is not obvious. A PR should say what it
changes, how it was tested, and whether it touches the `--json` contract.
