# AGENTS.md

Two different jobs land in this repository. Pick the one you are doing.

## You are *using* `tdo` as a tool

Read [`docs/agents.md`](docs/agents.md). It is the output contract: the `--json`
shape of every command, the fixed exit codes, and the rule that machine output
goes to stdout while warnings go to stderr.

The short version:

```sh
tdo add "Review the contract" --project Legal --due 2026-11-01 --json
tdo ls --json                      # what can be worked on right now
tdo next --json                    # the single next action
tdo done <id> --json
```

- Every command takes `--json`. Parse that, not the human table.
- Exit codes mean something: `0` ok, `1` error, `2` usage, `3` config or
  credential, `4` provider or network, `5` not found, `6` ambiguous id. Branch
  on them instead of matching error text. An illegal parent/kind pairing and a
  move that would make a cycle are usage errors: `2`.
- **One tree, three kinds.** A `folder` holds folders and projects, a
  `project` holds tasks, a `task` holds tasks. A task with no parent is in the
  inbox, which is the absence of a container rather than a thing that exists.
- **`tdo ls` shows what is available, not everything.** A deferred task, a
  task in an on-hold project and a task queued behind its sibling in a
  sequential project are all absent. `--all`, `--blocked`, `--deferred` and
  `--status` widen it.
- **Never recompute availability.** Every task object carries `available` and,
  when it is false, `blocked_by` naming the rule and the item responsible.
  `tdo show` says the same thing in a sentence.
- **Nothing generates a row while you read.** The next instance of a repeating
  item appears only from an explicit `tdo done`, which reports it under
  `repeated`. `ls`, `show`, `next`, `review` without a reference, `series` and
  `export` write nothing at all.
- Required keys are `id`, `kind`, `title`, `parent_id`, `position`, `status`,
  `flagged`, `sequential`, `completed_by_children`, `defer_at`, `due_at`,
  `estimated_minutes`, `note`, `repeat`, `series_id`, `review_interval`,
  `last_reviewed_at`, `created_at`, `updated_at`, `completed_at`,
  `dropped_at`, `deleted_at` and `tags`, plus the derived `done`, `available`,
  `blocked_by` and `next_review_at`. **Any other key is a field a user
  invented with `--set`** — carry it through, do not reject a task because of
  a key you do not recognise.
- Use the `id` from `--json` output, not the short number a listing prints:
  the numbers come from a cache of the last *human* listing and are meant for
  humans. Machine output never refreshes that cache.
- No command prompts, except `tdo rm --purge`, `tdo login --remove` and the
  delegated Turso mint, which refuse outright rather than prompting when stdin
  is not a terminal. Pass `--yes` only when you genuinely mean to destroy data
  or to mint a credential. `tdo rm --purge` on a container also needs
  `--recursive` before it will take the subtree.
- Only `tdo init` creates a store, and its `created` key says whether this run
  made it; nothing else creates the database or its directory, so a wrong path
  is an exit-3 error rather than a new, empty list. `tdo import` never
  overwrites a task, validates the whole file before the first write, and
  refuses an id that is not a ULID (exit 2) unless you pass `--new-ids`.
- You never need a credential. `tdo` reads tokens from the environment, the OS
  keychain or the user's config file, in that order. There is no `--token`
  flag, and `tdo config`, `tdo doctor` and `tdo login --show` redact
  everything — a token shows as `[REDACTED]#1a2b3c4d`, a fingerprint rather
  than any part of the value — so their output is safe to paste. If a token is genuinely
  missing, `tdo login` reads one from stdin (one line, no prompt, when stdin is
  a pipe) — never from a flag.
- A mistyped flag or an unknown command exits 2, like any other usage error. A
  value that begins with a dash goes after `--`, with every flag before it
  (`tdo add --json -- "--not-a-flag"`), and `--note=<value>` is the reliable
  form for a value that could be mistaken for a flag; a `--where key=value`
  match compares against the stored value's type, so a field set from JSON is
  not matched by its text form.
- Which store is in use comes from `--provider`, else `TODOCLOUD_PROVIDER`,
  else the config file. Check it with `tdo config --json` (its `origins` says
  where the answer came from) rather than changing it yourself; a write to a
  store that did not come from the config file prints a notice on stderr, never
  in `--json` stdout.

## You are *working on* this repository

Read [`CLAUDE.md`](CLAUDE.md) first, then [`PLAN.md`](PLAN.md).

The rules that are not negotiable: never write a real credential into any file
here, write everything in English, keep to the standard library plus the four
approved dependencies, keep `CGO_ENABLED=0` working, and run `make check`
(`gofmt`, `go vet`, `go test`, secret scan) before proposing a commit. Do not
commit, push, tag or open a pull request unless the maintainer asks.
