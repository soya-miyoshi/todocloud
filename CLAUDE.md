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
   something. Tests use local SQLite and `httptest` fake servers. If a real
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

- **Go standard library first.** The four direct dependencies, and the reason
  each one is here:
  - `modernc.org/sqlite` — pure Go, so `CGO_ENABLED=0` keeps working.
  - `github.com/urfave/cli/v3` — the command and flag tree.
  - `github.com/oklog/ulid/v2` — task ids.
  - `github.com/mattn/go-isatty` — `tdo rm --purge` must refuse rather than
    prompt when stdin is not a terminal, and `os.ModeCharDevice` is not enough
    because `/dev/null` is a character device too. It was already in the module
    graph via `urfave/cli`, so it adds no new supply-chain surface.

  `golang.org/x/oauth2` is planned for the Firestore milestone and is not a
  dependency yet. Anything beyond this list needs the user's agreement, with
  the reason recorded in the PR. There is no TOML library: the config parser is
  a hand-written subset, deliberately.
- `CGO_ENABLED=0` must keep working for darwin/linux/windows × amd64/arm64.
  Never introduce a cgo dependency.
- **Providers go behind the `Store` interface.** No provider-specific type may
  escape its package into the command layer.
- **Machine output on stdout, everything else on stderr.** Every command
  supports `--json`; its shape is documented in `docs/agents.md` and changing it
  is a breaking change.
- Exit codes are fixed: `0` ok, `1` error, `2` usage, `3` config/credential,
  `4` provider/network, `5` not found, `6` ambiguous id.
- `gofmt` and `go vet` are clean before every commit. Tests: `go test ./...`
  must pass with no network access.
- Match the surrounding code's style, naming and comment density.

## 4. Things to ask about rather than decide

- Adding a dependency, a provider, or a new top-level command.
- Anything that changes an existing `--json` shape or an exit code.
- Any network listener, any telemetry, any crash reporting — the default answer
  is no; the project sends nothing anywhere except to the user's own database.
- `git commit`, `git push`, tagging a release, or creating a PR: only when the
  user asks for it.
