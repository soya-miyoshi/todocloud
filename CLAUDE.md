# CLAUDE.md

Instructions for AI assistants working in this repository. These rules are not
suggestions; a change that violates §1 must not be committed under any
circumstances.

## 0. What this project is

`todocloud` is a Go CLI (`tdo`) that stores a todo list in a database the user
owns. The user supplies their own provider credentials via environment
variables or `~/.config/todocloud/config.toml`. There is **no backend service**
and no hosted account — the CLI talks directly to the user's provider
(local SQLite, then Turso, Firestore, Cloudflare D1, in that order).

Read `PLAN.md` before making design decisions; it records why the backend was
dropped, why Go was chosen, and what ships in which milestone.

## 1. Credentials — hard rules

This is an open-source repository. A leaked token is public forever.

1. **Never write a real credential into any file in this repository.** Not in
   tests, fixtures, examples, docs, comments, commit messages, or temporary
   scratch files. This holds even for a credential the user pasted into the
   conversation, and even for one they say is expired or disposable.
2. **Never commit a file matching a secret shape** — `.env*`, `*.pem`, `*.key`,
   `*-credentials.json`, `service-account*.json`, `.dev.vars`, `config.toml`,
   `*.db`. These are in `.gitignore`; do not add exceptions, do not use
   `git add -f` on them, and never commit with `--no-verify`.
3. **Use placeholders in every example**: `libsql://example.turso.io`,
   `TOKEN_GOES_HERE`, `00000000-0000-0000-0000-000000000000`. A placeholder must
   be obviously fake — never a realistic-looking token.
4. **Never run a command that prints a credential** into the transcript
   (`env`, `cat ~/.config/todocloud/config.toml`, `echo $TODOCLOUD_D1_TOKEN`,
   `wrangler whoami`, `gcloud auth print-access-token`). If a value is needed,
   ask the user to check it themselves.
5. **Never make a request against the user's real provider account** to "verify"
   something. Tests use local SQLite and a `node:http` fake server
   (`packages/store-turso/src/fakeserver.test.ts`, backed by a real in-memory
   `node:sqlite` engine). If a real
   credential is genuinely required for a one-off check, print the command and
   let the user run it.
6. **Never add a flag that takes a secret.** `argv` is world-readable via `ps`
   and is saved in shell history. A secret reaches the tool from three places
   only — an environment variable, the OS keychain (`tdo login`), or the user's
   own config file at the XDG path when it passes the guards in `SECURITY.md`.
   There is no `--token` flag and there must never be one. This applies to a
   secret handed to a subprocess too: pass it on stdin, never in `argv`.
7. **Secrets must stay unprintable in code.** Every token is held in the
   `Secret` type, whose `String`, `Format`, `MarshalJSON` and `LogValue` return
   `[REDACTED]`. Never log a request header, a full URL with a query string, or
   a config struct without passing it through the redactor. `--debug` output is
   held to the same standard as normal output.
8. If you believe a credential has already been committed, **stop and tell the
   user immediately**. Do not try to fix it by amending or force-pushing on your
   own — the token must be revoked first, and that is their call.

Before any `git commit`, run `make scan` (or `scripts/scan-secrets.sh --staged`)
and read the output. The pre-commit hook does this too, but do not rely on the
hook being installed.

## 2. Language

**Everything committed to this repository is written in English**: code,
identifiers, comments, docs, CLI help text, error messages, test names, commit
messages, PR descriptions and issue text. `PLAN.md` and every file under `docs/`
are English as well.

The maintainer converses in Japanese. Do not let that leak into the repository:
when asked in Japanese to add a comment or a doc, write the comment or doc in
English. If you find Japanese text in a committed file, treat it as a bug worth
reporting.

## 3. Engineering conventions

The CLI is TypeScript on Node 24+. Node is the development runtime, the one
`npm test` and the published npm package use, and the one pinned in
`mise.toml`; the shipped executable is compiled by Bun with
`bun build --compile` (`make binary`, `ARGS=--all` to cross-compile every
target), also pinned there. Both runtimes must stay green — `npm test` and
`bun test` — because one is what users on npm run and the other is what the
downloaded binary carries. `MIGRATION.md` records what the port decided and
why, the Node single executable this build replaced and the measurements that
replaced it, and the two Go bugs it deliberately does not carry over.

- **Node standard library first. The direct dependency set is empty.**
  `typescript` is the only devDependency. What the four Go dependencies did:
  - `node:sqlite` replaces `modernc.org/sqlite`, and is built in, so there is
    no native build step.
  - `node:util` `parseArgs`, under a hand-written subcommand dispatcher,
    replaces `urfave/cli/v3`. No CLI framework: exit code `2` for usage errors
    and the `--json` shapes are contracts, and a framework owns both.
  - ULID generation is hand-written over `crypto.getRandomValues`, which exists
    in Node and in browsers, replacing `oklog/ulid/v2`.
  - `node:tty` `isatty` replaces `mattn/go-isatty` — `tdo rm --purge` must
    refuse rather than prompt when stdin is not a terminal.

  Anything beyond this needs the user's agreement, with the reason recorded in
  the PR. There is still no TOML library: the config parser is a hand-written
  subset, deliberately.
- **`packages/core` must run in a browser.** The PWA imports it, so nothing in
  it may import `node:*`. Runtime-specific code lives in `packages/store-sqlite`
  (Node only) and `packages/cli`; `packages/store-turso` uses `fetch` and works
  in both. Tests for core may use `node:*`.
- **Providers go behind the `Store` interface.** No provider-specific type may
  escape its package into the command layer.
- **Machine output on stdout, everything else on stderr.** Every command
  supports `--json`; its shape is documented in `docs/agents.md` and changing it
  is a breaking change.
- Exit codes are fixed: `0` ok, `1` error, `2` usage, `3` config/credential,
  `4` provider/network, `5` not found, `6` ambiguous id.
- `tsc` is clean under `--strict` before every commit, including
  `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Tests:
  `npm test` must pass with no network access.
- **`npm run lint` looks for a function that calls itself with its own
  arguments**, which is a stack overflow on the first call and shipped from
  here once: `messageOf(err)` inside `messageOf`, which crashed the installed
  PWA on load. No JavaScript linter has that rule — Sonar's S2190 is
  Java/C#/C only and Biome has nothing equivalent — so
  `scripts/check-recursion.mjs` is it, over the AST of the `typescript` this
  repository already depends on. It adds no dependency, `npm test` runs it
  over every tracked file, and `make check` includes it.
- **`npm run probe` loads the viewer in a real browser** and fails on
  anything thrown while the page loads or while its panes and dialogs are
  driven. That is the tier `app.js` otherwise has none of: the type checker
  cannot see a runtime error and no test in this tree executes a line of it.
  It needs `playwright`, which is **not** a dependency of this project — the
  script says so and exits 0 when it is absent — so it is a thing to run
  before touching the viewer (`npm i -D playwright && npx playwright install
  chromium`), not something CI does today. Making it a CI job means adding
  that dependency, which is §4's kind of question.
- **The viewer's `app.js` and `sw.js` are checked too.** They are
  hand-written browser JavaScript and stay that way — they are served as
  they are — but `packages/cli/assets/tsconfig.json` (and `tsconfig.sw.json`
  for the worker) puts them under `checkJs` with `strictNullChecks`, and
  `npm run typecheck` runs all three projects. A DOM lookup answers
  `… | null`, so `$` throws rather than handing a null on, and `maybe` is
  the lookup for the handful of elements that genuinely differ between the
  two shells. Do not reach for `document.querySelector` directly, and do not
  silence a diagnostic with `any` where a JSDoc type would say what the
  element actually is.
- Match the surrounding code's style, naming and comment density. This
  repository writes substantial "why" comments; keep them when porting rather
  than dropping them.

## 4. Things to ask about rather than decide

- Adding a dependency, a provider, or a new top-level command.
- Anything that changes an existing `--json` shape or an exit code.
- Any network listener, any telemetry, any crash reporting — the default answer
  is no; the project sends nothing anywhere except to the user's own database.
- `git commit`, `git push`, tagging a release, or creating a PR: only when the
  user asks for it.
