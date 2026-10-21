# todocloud — implementation plan

A single-binary CLI (`tdo`) that keeps a todo list in **a database you own**.
You supply your own provider credentials through the environment, the OS
keychain or your own config file; the tool talks
directly to that provider over HTTPS. There is no todocloud server, no hosted
account, and no telemetry. Nothing leaves your machine except requests to the
database endpoint you configured.

- Repository: `github.com/soya-miyoshi/todocloud`
- Binary / command: `tdo`
- Language: TypeScript on Node 24+ (zero runtime dependencies)
- Distribution: one executable compiled with `bun build --compile`, which
  needs no runtime installed — through Homebrew and the GitHub release
  archives
- License: MIT
- Status: v0.1 is being implemented. Nothing is tagged yet.

## 1. Why this shape

**No backend.** An earlier draft put a Cloudflare Worker between the CLI and the
database. It was dropped: the whole premise is that the user already trusts the
CLI with their own database credentials, so a relay adds a deployment step for
the user and buys nothing. If per-user sharing or narrower tokens are ever
needed, a Worker can be added later as an *optional* provider, not as a
requirement.

**TypeScript, not Go.** Every command is one HTTPS round trip (50–300 ms);
parsing a few KB of JSON is noise, so language performance is not a selection
criterion. This project was written in Go first, for three reasons recorded
here: cross-compilation with `CGO_ENABLED=0`, a standard library that covered
everything including the Firestore signing work, and no runtime for the user to
install.

It was rewritten in TypeScript for one reason those three could not answer: a
standalone PWA that queries the user's database directly from the browser, with
no relay. That is possible — `libsql-server` wraps its user HTTP API, the one
serving `/v2/pipeline`, in a permissive CORS layer (`allow_origin(Any)`,
`allow_headers(Any)`), and authentication is a Bearer header rather than a
cookie, so the wildcard origin applies. What Go could not answer is sharing one
implementation with it. Compiling the core to WebAssembly was considered: the
HTTP providers would have worked, but the local SQLite provider could not
(there is no filesystem in a browser), the boundary to the UI is untyped
`js.Value`, and the wasm payload is megabytes. The alternative was implementing
availability and repeat completion twice, in two languages, which is exactly
the drift `internal/web` was built to avoid.

The cost is paid honestly, and part of it has since been paid back. Startup
roughly doubled: the Go binary ran `tdo version` in 16 ms on the maintainer's
machine and the shipped executable takes 33 ms, against a 7 ms floor for the
engine it carries. (The "roughly 5 ms" this section used to claim was never
measured; `MIGRATION.md` records what the measurements actually say.) Cross-compilation came back, though — `bun build --compile
--target=...` produces all five supported targets from one machine, which is
what `CGO_ENABLED=0` used to do — and so did the property that the user needs
no runtime: the executable carries its own. What it costs instead is size,
71 MB to 95 MB depending on the target against Go's 8–15 MB, and a second
toolchain for whoever builds a release. Against all of that, one
implementation of availability, repeat completion and the task shape now
serves the CLI, the local viewer and the PWA.

Node remains the development runtime; Bun builds the executable and nothing
else. Both are pinned in `mise.toml` and the test
suite runs under both in CI.

Cloudflare D1 does not get the direct-from-browser treatment. Its REST API
does not send configurable CORS headers and is not meant to be called from a
browser, so D1 stays CLI-only unless an *optional* Worker relay is added later.

**The direct dependency set is empty.** Node 24+ covers what the Go standard
library and the four Go dependencies covered:

- `node:sqlite` replaces `modernc.org/sqlite`, with no native build step.
- `node:util` `parseArgs`, under a hand-written subcommand dispatcher, replaces
  `urfave/cli/v3`. A framework is not used because exit code `2` for usage
  errors and the `--json` shapes in `docs/agents.md` are contracts, and a
  framework owns both.
- ULID generation is hand-written over `crypto.getRandomValues`, which exists
  in both runtimes, replacing `oklog/ulid/v2`.
- `node:tty` `isatty` replaces `mattn/go-isatty`.
- `tsc --strict` replaces `gofmt` and `go vet`; `node --test` replaces
  `go test`.

`typescript` is the only devDependency. There is still no TOML library: the
config parser remains a hand-written subset, deliberately. Anything beyond this
needs the user's agreement, with the reason recorded in the PR.

A dynamic language also makes the open JSON field map of §3 easier to write,
which was noted here as a minor advantage of TypeScript even while Go was the
choice.

The toolchain is pinned for this repository in `mise.toml`. Node 24 or newer is
required, because `node:sqlite` is stable there.

## 2. Provider roadmap

Providers sit behind one `Store` interface. They ship one at a time, each one
fully working (including tests and docs) before the next starts.

| Provider | Credential the user supplies | Scoping of that credential | State |
|---|---|---|---|
| **Local SQLite** | none (a file path) | n/a | shipped |
| **Turso / libSQL** | database URL + database token | **per database** — the token only reaches this one database | shipped |
| **Cloudflare D1** | account ID + API token | **account-wide** — see the warning below | later |

**Turso is the recommended cloud provider** for anyone who wants the narrowest
possible credential, because its tokens are issued per database.

**Firestore was built and then dropped.** An earlier plan had it second,
reasoning that a schemaless document store suits the open map of §3. The GTD
model of §3.1 changed that: folders, projects and the inbox are one tree, and
availability (§3.3) needs the ancestors of every candidate, not just the
candidate. The implementation already read the whole collection for every
listing to avoid demanding hand-built composite indexes, and tree traversal on
top of that would have meant downloading the database to list a day's work.
The code was removed rather than left to rot against an interface it no longer
satisfies.

One useful result survives it: the Firestore REST value converter and both
auth flows (service-account RS256 JWT, and ADC refresh-token) were written
with **no dependency beyond the standard library**, so the
`golang.org/x/oauth2/google` question recorded here earlier is answered — it
was never needed. The same holds after the TypeScript rewrite: `node:crypto`
signs an RS256 JWT, so no auth library is needed there either. If a
document-store provider is ever revisited, that is the precedent.

### Credential-scope warning (must appear in README and SECURITY.md)

Cloudflare API tokens **cannot be scoped to a single D1 database**. The minimum
permission that allows writes is `Account → D1 → Edit`, which grants write
access to *every* D1 database in that account; the specific database is chosen
only by the UUID in the request path
(`POST /accounts/{account_id}/d1/database/{database_id}/query`).

Therefore the D1 docs must tell users plainly: the token you hand to `tdo` can
read and modify all your D1 databases. Recommend a dedicated Cloudflare account
(or an account whose only D1 database is this one) for anyone who cares.
Turso is documented as the recommended cloud provider precisely because its
tokens are per-database. Verify this against Cloudflare's token docs again
before the D1 milestone ships, in case scoping has improved.

## 3. Data model

One table / collection, `tasks`, holding every node of one tree. Requirements
differ per user, so the **required fields** are real columns and everything
else lives in one open JSON map the CLI carries through untouched. Adding an
attribute of your own still needs no migration.

### 3.1 One tree, three kinds

OmniFocus distinguishes folders, projects and actions, but they are the same
shape: a thing with a title that may contain other things. They are one table
with a `kind`, and containment is a single `parent_id` edge.

| `kind` | May contain | Notes |
|---|---|---|
| `folder` | folders, projects | organisation only; never actionable, never completed |
| `project` | tasks | an outcome; completable |
| `task` | tasks (an action group) | an action |

The rules the store enforces, because a broken tree is worse than a rejected
command:

- A `folder`'s parent is a folder or nothing. A `project`'s parent is a folder
  or nothing. A `task`'s parent is a project or a task, or nothing.
- **A task with no parent is in the inbox.** The inbox is not a container; it
  is the absence of one, so nothing has to create it and it cannot be deleted.
- **Cycles are refused** (exit 2), including an item made its own parent.
- Deleting a container does not orphan its children silently: `tdo rm` on a
  container tombstones the subtree, and `--purge` refuses unless the subtree is
  empty or `--recursive` is given.

### 3.2 Required fields

These names are **reserved** and cannot be used as user-defined fields.

| Field | Type | Notes |
|---|---|---|
| `id` | text | ULID, generated client-side |
| `kind` | text | `folder`, `project` or `task` |
| `title` | text | required, non-empty |
| `parent_id` | text / null | null means top level, and for a task, the inbox |
| `position` | int | manual order among siblings; ties break by `id` |
| `status` | text | `active`, `on_hold`, `done` or `dropped` |
| `flagged` | bool | |
| `sequential` | bool | a container whose children must be done in order |
| `completed_by_children` | bool | the container completes when its last child does |
| `defer_at` | text / null | RFC 3339; not available before this |
| `due_at` | text / null | RFC 3339 |
| `estimated_minutes` | int | `0` when unset |
| `note` | text / null | |
| `repeat` | object / null | see §3.4 |
| `series_id` | text / null | ties the instances of a repeat together |
| `review_interval` | object / null | projects and folders; see §3.5 |
| `last_reviewed_at` | text / null | |
| `created_at` | text | RFC 3339, UTC |
| `updated_at` | text | RFC 3339, UTC |
| `completed_at` | text / null | set when `status` becomes `done` |
| `dropped_at` | text / null | set when `status` becomes `dropped` |
| `deleted_at` | text / null | tombstone |

`status` replaces the old boolean `done`. Four states are needed because GTD
distinguishes *not now* (`on_hold`) and *never, but remember I decided that*
(`dropped`) from *finished*. `done` remains in `--json` output as a derived
convenience field equal to `status == "done"`, so the common case stays one key.

Tags are many-to-many and live in their own `task_tags` table rather than in
the JSON map, because `tdo ls --tag home` must be a join and not a scan.

A tag is also a row of its own, in a `tags` table keyed by the folded name,
carrying a `status` of `active`, `on_hold` or `dropped` — never `done`, since
a tag is a context and not a piece of work. A tag used by a task but with no
row of its own is active, so the table is an addition and not a precondition;
a tag keeps its row, and its status, when its last task is finished, because
putting a context on hold is not undone by emptying it. What this buys is rule
2a of §3.3: one command takes a whole context out of play.

Everything else set with `--set k=v` is an ordinary member of the open map and
is flattened alongside the required fields in `--json`, exactly as before.

### 3.3 Availability

This is the computation GTD lives or dies by, and it is defined once, in the
store layer, so every provider and every command agrees.

An item is **available** when all of these hold:

1. Its `status` is `active`.
2. Its `defer_at` is absent or in the past.
2a. No tag it carries is `on_hold` or `dropped`.
3. Every ancestor is `active`, no ancestor has a future `defer_at`, and no
   ancestor carries a tag that is `on_hold` or `dropped`.
4. For itself and for **every ancestor**: if that item's parent is
   `sequential`, the item is the first child of that parent which is not
   `done`, `dropped` or deleted. The rule is transitive on purpose — an action
   group whose turn has not come blocks everything inside it, or a list would
   surface the children of a step nobody has started. Deleted siblings are
   skipped, so a tombstone cannot stall a sequence forever.

Anything that fails 2, 2a, 3 or 4 is **blocked**; `tdo ls` shows available
items by default and `--blocked`, `--deferred` or `--all` widen that. Rule 3
is why putting a project on hold silently empties it from every list, which is
the whole point of putting a project on hold.

Rule 2a is the promoted tag, and it is a deliberate departure from OmniFocus,
which does not inherit a tag down the tree: here a tag on a *container* holds
back what is inside it as well, because the alternative is a project visibly
out of play whose actions are still offered as next actions. The reported rule
is `tag_status` or `ancestor_tag_status`, and both carry the tag's name
alongside the item's id — the item is not what has to change for the hold to
lift.

Three cases fall outside the four rules and are never available: a **folder**
(it is organisation, not work), a **tombstoned** item or one with a tombstoned
ancestor, and an **orphan** whose parent id names nothing — an item nobody can
reach should not be offered as the next thing to do. The reported reason is
always the most specific one: an item's own deferral is reported before an
ancestor's.

`tdo ls --json` carries `available` and, when false, `blocked_by` naming the
rule and the ancestor responsible — a caller should not have to recompute this,
and an agent should be able to say *why* nothing is actionable. Every command
that emits tasks emits one shape, `{"tasks":[…],"count":n}`, including the
commands that act on a single item: `{"task":{…}}` existed alongside it and
was merged away while nothing was released (§9), because the only line that
read both was `jq '.task // .tasks[]'`.

### 3.3a Complete with last action

A container whose `completed_by_children` is set completes itself when its
last open child closes. OmniFocus calls this "complete with last action", and
it is what stops a project lingering on a list after the work in it is done.

- **The trigger** is a child becoming `done`, `dropped` or tombstoned. A child
  is *open* when it is none of those — the same set §3.3's rule 4 skips when
  it looks for the first child of a sequential container, and for the same
  reason. A child that is itself a container counts as an ordinary child,
  open until its own status closes.
- **It cascades.** A container that completes this way may be the last open
  child of its own parent. The walk is upward and stops at the first ancestor
  that does not complete, because everything above it still has an open child.
- **A container with no children never completes this way.** Completing
  nothing is not completing something: an empty project would otherwise
  complete the moment it was created, and tombstoning a container's children
  would read as having done the work.
- **A repeating container is never completed this way**, and the cascade stops
  there. Auto-completing it would have to either kill its series silently or
  manufacture a successor while the user was merely finishing a child, and
  §3.4 says a row is created only as the direct result of an explicit
  `tdo done`. Finishing a repeating container is something the user does on
  purpose. A repeating *child* is an ordinary child.
- **Nothing reopens automatically.** Undoing a child of a container that was
  completed this way leaves the container done. Nothing records *why* a
  container is done, so reopening would be a guess, and a wrong guess
  resurrects a project the user finished deliberately. Closing is monotone;
  `tdo undone <container>` is one command and says which was meant.
- A **folder** never completes (§3.1). A container that is already `done`,
  `dropped` or tombstoned is left exactly as it is — a dropped outcome must
  not quietly become a completed one. A container **on hold** does complete:
  the work it was holding is finished, and leaving it on hold would strand an
  unactionable container in the tree forever.

Like availability, this rule lives in one place in the store layer and is
reused by every provider rather than reimplemented, and the shared conformance
suite holds both providers to it. `tdo done`, `tdo drop` and `tdo rm` report
any container they completed this way.

### 3.4 Repetition

`repeat` is `{"method": …, "every": …}`. `every` is a duration-with-calendar
spelling (`3d`, `2w`, `1mo`, `1y`, and `1mo:last-friday` for the calendar cases
OmniFocus supports). The three methods are OmniFocus's three, and they differ
only in what the next instance's dates are computed from:

| `method` | Next `defer_at` / `due_at` computed from |
|---|---|
| `fixed` | the previous instance's own dates — a true calendar schedule that can fall behind |
| `from_completion` | the moment of completion — "every 3 days after I actually do it" |
| `defer_another` | the moment of completion, and only `defer_at` moves |

**A new instance is created only as the direct result of an explicit
`tdo done`.** Nothing is generated in the background, on a timer, or during a
read: `tdo ls` never writes. This is a safety property, not an implementation
detail — a tool an agent drives must not manufacture rows while being read.

Completing a repeating item creates exactly one successor, carrying the same
`series_id` (minted on the first instance), the same fields, and a fresh `id`.
`tdo done --no-repeat` completes without a successor, and `tdo repeat --stop`
ends the series while leaving its history.

### 3.5 Review

`review_interval` is `{"every": "1w"}` on folders and projects.
`next_review_at` is derived from `last_reviewed_at + every`, so it cannot drift
out of sync, and `tdo review` lists what is due and `tdo review <ref>` marks
one reviewed. A container that has never been reviewed is due now, and
`tdo project ls --needs-review` shares the review window with `tdo review`
so the two cannot answer differently.

### 3.6 Perspectives

A perspective is a **saved query**, nothing more: a name plus a filter. They
live in a `perspectives` table and are applied with
`tdo ls --perspective <name>`. A perspective never stores results and never
pins ids, so it cannot go stale; running one is exactly equivalent to typing
its filter.

Perspectives are part of a backup: `tdo export` writes them in a
`perspectives` key alongside the tasks and `tdo import` restores them, since
§10 makes export/import the way to move a list to another provider. An import
never overwrites: a name already in use is skipped and counted, the same way
a task whose id is taken is. CSV carries tasks only and says on stderr when
it is leaving saved queries behind.

A stored filter is the on-disk format of a perspective, so its JSON tags are
structure rather than presentation; changing one changes the meaning of every
perspective already saved and needs a migration. The in-memory `Filter` and
the stored one are deliberately the same type: splitting them would buy an
independent query API at the price of a conversion where a forgotten field
stops being saved without failing to compile, which is the silent widening
this is all guarding against. A golden test pins the shape instead. A stored filter holding a key
this binary does not know is refused rather than ignored, because every field
narrows a listing and a dropped one would run the saved query wider than it
was saved.

The honest limit: a perspective holds a server-side `Filter`, so the flags
evaluated on the client — `--where`, `--priority`, `--untagged`,
`--estimate-under` and `--sort title` — **cannot be saved in one**, and
`tdo perspective save` refuses them rather than storing a filter that would
mean something narrower when run. Closing that gap means moving those
conditions into `Filter`, which is the same work §10's filtering asymmetry
describes.

### 3.7 Decisions to hold to

- **No deletes by default.** `tdo rm` sets a `deleted_at` tombstone;
  `tdo rm --purge` really deletes. This keeps multi-device behaviour sane.
- **ULIDs, not autoincrement**, but users type short numbers. Client-side id
  generation is required for offline creation; lexicographic ULID order equals
  creation order, so one `ORDER BY` serves every provider; and ULIDs do not
  collide across devices. For day-to-day use `tdo ls` prints a small number per
  row and caches that listing locally, so `tdo done 3` works. Machine output
  does not refresh that cache, so a `--json` caller cannot renumber a list
  someone else is reading.
- **Ids are generated with monotonic entropy**, so ids created in one burst
  sort in creation order. The honest residual: a ULID's timestamp is
  millisecond-resolution and the monotonic sequence is per process, so **two
  separate `tdo add` processes that land in the same millisecond may order
  either way** — stably, since the ids are then fixed.
- **Short id prefixes** are accepted on the command line (`tdo done 01J3`) as
  long as they are unambiguous, like git.
- **The listing cache is a local JSON file** at
  `$XDG_STATE_HOME/todocloud/lastlist.json`, mode 0600, keyed by the store the
  listing came from, so a number from one provider is never applied to another.
  A cache miss is never fatal.
- **Availability is computed in one place** and never duplicated into a
  command. A provider may push parts of it down for speed, but the result must
  equal the definition in §3.3, and the shared conformance suite checks that.
- Schema version lives in a `meta` table so `tdo migrate` can upgrade an
  existing remote database.
- **Order is editable.** In a sequential project the position of a child is
  the order its actions become available, so `tdo mv --before/--after` exists:
  without it, "do this one last" means deleting the action and adding it
  again, which loses its id, its note and its history. A placement rewrites
  the positions of the whole sibling group, because a manual order has no
  guaranteed gaps to insert into.

## 4. Command surface

```
# Capture and the inbox
tdo add <title...> [--project P] [--parent REF] [--inbox]
       [--defer D] [--due D] [--flag] [--tag t1,t2] [--note S]
       [--estimate 25m] [--repeat 1w[:method]] [--priority N] [--set k=v]...
tdo inbox [--count]                      # the tasks with no parent
tdo inbox process <ref> --project P      # file one inbox item

# Looking at things
tdo ls [--available|--blocked|--deferred|--all|--deleted] [--inbox] [--flagged]
       [--project P] [--under REF] [--kind task|project|folder]
       [--status active|on_hold|done|dropped]... [--tag t] [--untagged]
       [--due-before D] [--defer-before D] [--estimate-under 30m]
       [--priority N] [--where k=v]... [--perspective NAME] [--limit n]
       [--sort position|created|updated|due|defer|title] [--tree]
tdo show <ref>                            # includes why it is blocked
tdo next [--project P]                    # the first available action, per GTD

# Changing things
tdo done <ref...> [--no-repeat]
tdo undone <ref...>
tdo drop <ref...>                         # decided against; not deleted
tdo hold <ref...> / tdo unhold <ref...>   # status on_hold
tdo flag <ref...> / tdo unflag <ref...>
tdo defer <ref...> <when|--clear>
tdo due <ref...> <when|--clear>
tdo edit <ref> [--title S] [--note S] [--estimate 25m] [--priority N]
       [--tag t1,t2] [--untag t] [--set k=v]... [--unset k]...
tdo mv <ref...> <parent-ref|--inbox|--top>   # reparent; refuses a cycle
tdo mv <ref...> <--before REF|--after REF>   # order among siblings
tdo rm <ref...> [--recursive] [--purge] [--yes]

# Structure
tdo project add <title...> [--folder F] [--sequential] [--review 1w]
tdo project ls [--status ...] [--needs-review]
tdo project <ref> [--sequential|--parallel] [--complete-with-last]
                  [--review 1w] [--folder F]   # F empty: move to the top level
tdo folder add <title...> [--folder F]
tdo folder ls
tdo tag ls [--status S] [--unused]           # every tag, its status, its count
tdo tag hold <tag...> / unhold <tag...> / drop <tag...>
tdo tag rename <old> <new> / rm <tag...>

# Repetition and review
tdo repeat <ref> <every>[:fixed|from_completion|defer_another]
tdo repeat <ref> --stop
tdo series <ref>                          # the instances of one series
tdo review                                # projects and folders due for review
tdo review <ref> [--interval 1w]          # mark reviewed

# Saved queries
tdo perspective save <name> -- <ls flags...>
tdo perspective ls / rm <name> / show <name>

# Administration (unchanged)
tdo init / migrate / config / login / doctor / version
tdo config set <key> <value>              # maintain the config file (§5)
tdo export [--csv] [--all] / tdo import <file> [--new-ids]
```

A `<ref>` is either the short number from the last `tdo ls` or an unambiguous
id prefix. Where the thing being named is a **container** — `--project`,
`--folder`, `--parent`, the destination of `tdo mv`, the argument of
`tdo project`/`tdo folder`/`tdo review` — its exact title is accepted too,
case-insensitively, because a container is typed far more often than it is
listed. The title is tried last, after the number and the id prefix, so a
number never changes meaning; two containers sharing a title is exit 6.

**A reference that resolves to the wrong kind is an error.** The numbers are
the last listing's, so the same `1` names a folder after `tdo folder ls` and a
project after `tdo project ls`; `tdo project 1 --sequential` therefore checks
the kind and exits 2 rather than reshaping a folder, and a reshape that does
go through prints what it resolved to on stderr. For the same reason a flag a
command declares but does not apply at this position is exit 2 naming where it
does work: a silent exit 0 is the worst of the three available answers.

**Tags are named, never numbered.** `tdo tag ls` prints no numbers and does
not touch the listing cache: a second, parallel set of numbers is exactly how
`tdo project 1` came to mean a folder, and a tag is unique by name anyway.

A date is `YYYY-MM-DD` or RFC 3339. There are no relative words: `tomorrow`
is a usage error, because a tool an agent drives should not have to agree
with it about what day it is.

Global flags: `--json`, `--debug`, `--config PATH`, `--provider NAME`. There is
no `--token` flag and there must never be one.

`--priority N` (0–3) is an ordinary user-defined field with a dedicated flag
and a guaranteed place in `--json`, not a column: it predates the GTD model
and OmniFocus has no equivalent, so it stays where a user's own fields live.

`--set k=v` types the value the way it reads: `--set estimate=3` stores the
number 3, `--set ref=3.0.1` stores the string `"3.0.1"`. Reserved names (the
required fields in §3.2) are rejected.

### 4.1 Defaults that encode the method

- **`tdo ls` shows available items** (§3.3) — not everything. A deferred task,
  a task in an on-hold project and a task queued behind its sibling in a
  sequential project are all absent, because GTD's claim is that a list you
  cannot act on is worse than no list. `--all` is always there to see the rest,
  and `tdo show` always explains a blocked item.
- **`tdo add` with no `--project` and no `--parent` captures to the inbox**,
  because the cost of filing must not be charged at the moment of capture.
- **`tdo done` on a repeating item creates its successor** and says so; nothing
  else, anywhere, ever generates a row (§3.4). It also reports any container it
  completed by finishing that container's last action (§3.3a), as do `tdo drop`
  and `tdo rm`.

### 4.2 Rules that apply to all commands

- Every command accepts `--json` and emits a stable, documented JSON shape on
  stdout. Human-readable output goes to stdout too, but logs, progress and
  warnings go to **stderr**, so `--json` output is always safe to pipe.
- Exit codes: `0` ok, `1` generic error, `2` usage error, `3` config/credential
  error, `4` provider/network error, `5` not found, `6` ambiguous id. A
  mistyped flag, an unknown command, an illegal parent/kind pairing and a
  reparent that would make a cycle are usage errors: exit 2.
- No command is interactive unless it would destroy data or create something
  outward-facing (§5.1); `--yes` skips the prompt, and a non-TTY stdin implies
  `--yes` is required rather than assumed.
- **No command writes while reading.** `tdo ls`, `tdo show`, `tdo next`,
  `tdo review` (without a ref) and `tdo export` are pure reads: they do not
  generate repeats, do not file inbox items and do not refresh anything a
  machine caller could race a human on.

## 5. Configuration and credentials

Resolution order, highest priority first:

1. command-line flags (never for secrets — see below)
2. environment variables
3. the OS keychain (tokens only, written by `tdo login`)
4. `$TODOCLOUD_CONFIG` if set
5. `$XDG_CONFIG_HOME/todocloud/config.toml` (default `~/.config/todocloud/config.toml`)

```toml
# ~/.config/todocloud/config.toml   — NEVER inside a repository
provider = "turso"

[sqlite]
path = "~/.local/share/todocloud/tasks.db"

[turso]
url = "libsql://my-tasks-myname.turso.io"
# token: TODOCLOUD_TURSO_TOKEN, else the OS keychain (`tdo login`), else a
# `token` key here subject to the guards below

[d1]
account_id = "..."
database_id = "..."
# token: TODOCLOUD_D1_TOKEN, else the OS keychain, else a `token` key here
```

Environment variables: `TODOCLOUD_PROVIDER`, `TODOCLOUD_SQLITE_PATH`,
`TODOCLOUD_TURSO_URL`, `TODOCLOUD_TURSO_TOKEN`,
`TODOCLOUD_D1_ACCOUNT_ID`,
`TODOCLOUD_D1_DATABASE_ID`, `TODOCLOUD_D1_TOKEN`.

Hard rules, enforced in code:

- **Secrets are never accepted as command-line flags.** `argv` is visible to
  every process on the machine via `ps` and lands in shell history. There is no
  `--token` flag.
- **A token comes from the environment, the OS keychain or the config file**,
  in that order of precedence. The environment variable wins outright and the
  keychain is then not consulted at all. The keychain is read only for the
  provider actually in use, with a two-second timeout; a keychain failure is
  never fatal and falls through to the config file with a warning. A token in
  the config file is loaded only when the file is outside every git repository,
  is the XDG config file or the one named by `$TODOCLOUD_CONFIG` (so a
  `--config` path never supplies one), and is not group- or world-readable.
  A refused token raises a loud warning on stderr naming the file, the line and
  the alternatives — never the value — and a file holding no token warns not at
  all. The one supported spelling is `token` under `[turso]` or `[d1]`; every
  other secret-shaped key (`api_token`, `secret`, `password`, `key`) is never
  loaded and always warns. See `SECURITY.md` for why a config file is permitted
  rather than forbidden.
- **Secrets are never printed.** A `Secret` string type wraps every token; its
  `String()`/`Format()`/`MarshalJSON()` return `[REDACTED]`. `tdo config` and
  `tdo doctor` print only the last 4 characters at most, and `--debug` logging
  passes request headers through a redactor before writing them.
- **The only credential `tdo` writes is the one `tdo login` puts in the OS
  keychain.** `tdo` must never write a credential into a file it manages, and
  never writes one to disk in plaintext. `tdo` does maintain the config file
  itself (§5.0), which is why the writer refuses a secret-shaped key in code
  rather than by convention. `tdo login` reads the token from stdin
  only; for Turso it does not read one at all, delegating to the Turso CLI to
  mint a per-database token. See §5.1.
- **A secret is never passed to a subprocess in `argv`** — it travels on the
  child's stdin — for the same reason there is no `--token` flag. A platform
  whose keychain binary can only take a secret as an argument therefore has no
  writable backend: `tdo login` prints the command for the user to run
  themselves and exits 0.
- Config files are opened with a permission check: warn loudly if a file
  containing a token is group/world-readable.

### 5.0 Writing the config file

`tdo` maintains the config file rather than printing lines to paste: `tdo
config set <key> <value>` is the general command, and `tdo login` uses the same
writer to record the `provider` and the `[turso] url` it just learned
(`--no-save` opts out). Dotted keys map to `table.key`; a bare key is top
level.

The writer is the other half of the hand-written TOML subset — there is no TOML
library and there must not be one (`CLAUDE.md` §3) — and it holds to four
rules:

- **It edits in place.** Comments, blank lines, key order, spacing and every
  table or key it was not asked about survive byte for byte. Setting an
  existing key replaces its value; a new key joins its table; a missing table
  is appended. A file the reader cannot parse is refused, not rewritten.
- **It writes atomically**, through a temporary file in the same directory
  renamed over the target, at mode 0600 in a 0700 directory whatever the
  umask — the same treatment the store gives the database.
- **It refuses exactly where the reader refuses a token**: anywhere inside a
  git repository, and any path that is neither the XDG config file nor
  `$TODOCLOUD_CONFIG` (so `--config PATH` never names a file tdo writes).
  Unlike the reader it has no fallback to the process's home directory: an
  environment that names none is a refusal, so nothing can reach a real config
  file from a stripped environment.
- **It never writes a credential.** A key named `token`, or any other name on
  the reader's secret-shaped list, is refused inside the writer so that a
  future caller cannot reach disk with one. `tdo config set turso.token …` is
  exit 2 pointing at `tdo login`.

A write is never silent: the file and the keys that changed are named on
stderr (`tdo login`) or on stdout (`tdo config set`), and `tdo config` with no
arguments still only reads.

### 5.1 `tdo login`

```
tdo login [--provider NAME] [--database NAME] [--remove] [--show] [--yes]
```

Two paths have consequences and are therefore confirmed, following
`tdo rm --purge`: `--remove`, which destroys an unrecoverable credential, and
the delegated Turso mint, which creates a token on the user's Turso account.
Each prompts on a terminal and exits 2 without one unless `--yes` is passed;
the refused mint does not fall back to stdin, since that would store a
different credential than the caller asked for. `--show`, the stdin paste path,
D1 and the no-CLI fallback stay unguarded.

No flag takes a token. On a terminal the prompt is not echoed; when stdin is a
pipe, one line is read with no prompt, which is what a script or an agent uses.

- **Turso** — with the `turso` CLI installed and logged in, `tdo login` runs
  `turso db tokens create <database>`, stores the result in the OS keychain and
  prints the matching `[turso] url = …` line on stderr. Nothing is pasted, and
  the token is narrower than one a user would create by hand. The database comes
  from `--database`, else from the configured Turso URL, else from
  `turso db list` when it holds exactly one database; otherwise exit 2 asking
  for `--database`. The `provider` and the URL are then written to the config
  file (§5.0) and the write is reported on stderr; a refused or failed write
  is **not** a failed login — the token is already stored, so it warns, prints
  the lines to paste and exits 0. `turso` installed but not logged in is exit 3
  (`turso auth login`). `turso` missing prints install instructions and falls
  back to stdin, exit 0. A minted token that cannot be stored is **discarded
  rather than printed**, with instructions to mint one by hand, exit 0.
- **Cloudflare D1** — no delegation. `wrangler`'s OAuth token is not usable
  from another tool and `CLAUDE.md` §1.4 forbids running `wrangler whoami`, so
  `tdo` neither runs nor detects wrangler. The token is pasted on stdin, after
  the account-wide-token warning of §2.
- **SQLite** — a usage error: a local file needs no credential.

### 5.2 Choosing the store, and not writing to the wrong one

Which provider a command uses is resolved in this order, highest priority
first:

1. `--provider NAME` — a one-off override, for a single command.
2. `TODOCLOUD_PROVIDER` — the ambient choice a CI job, a container or a shell
   session makes.
3. `provider = "..."` in the config file — the normal way. The config file is
   the answer to "which store am I using", the way `kubectl`'s current context
   is.

With none of them set, the provider is `sqlite`.

`tdo config` (and `tdo config --json`) prints the resolved provider and, under
`origins`, where that answer came from: `flag:--provider`,
`env:TODOCLOUD_PROVIDER`, `file:<path>` or `default`. It is the command to run
when in doubt about which store is in use.

The hazard here is not the credential, it is writing to the wrong store: the
tasks are not lost, they are in a place the user is not looking. A stale
`TODOCLOUD_PROVIDER` in a shell, or a mistyped `--provider`, is exactly how
that happens. Five guards:

1. **A write announces an unexpected store.** `add`, `edit`, `done`, `undone`,
   `rm`, `init`, `migrate` and `import` print one line on **stderr** naming the
   store whenever the provider did not come from the config file — e.g.
   `tdo: warning: writing to sqlite: /path/to/tasks.db: TODOCLOUD_PROVIDER
   overrides the "turso" named in /path/to/config.toml`, or `… : --provider
   selected it for this command only`. Never on stdout, so `--json` output
   stays parseable. The read-only commands (`ls`, `show`, `export`, `config`,
   `doctor`) say nothing: an unexpected list is self-evident.
2. **No noise when there is nothing to warn about.** A `TODOCLOUD_PROVIDER`
   that agrees with the config file is silent, and so is a machine with no
   config file at all — there the environment *is* the configuration. Only a
   genuine disagreement, or `--provider`, is announced.
3. **The short numbers never cross stores.** The listing cache of §3 is keyed
   by the store that produced it, so a number from one provider is never
   applied to another; it simply misses and says to run `tdo ls`.
4. **A store with no schema refuses writes.** Switching to a provider that has
   never been initialised is exit 3 with the advice to run `tdo init`, so a
   mistyped provider name cannot quietly grow a second, parallel task list.
5. **Only `tdo init` creates a store.** Every other command — `doctor`
   included — opens an existing one and creates neither the database file nor
   any parent directory, so a mistyped path is an exit-3 error rather than a
   new, empty list. `init` reports which happened in its `created` key.

`tdo rm --purge` names the store in its confirmation prompt, and in its refusal
when there is no terminal (`refusing to purge 2 task(s) from sqlite: /path …
pass --yes`).

## 6. Repository safety (no credential ever reaches the repo)

This is a hard requirement, not a best effort. Four independent layers, so that
no single mistake — mine or a contributor's — is enough:

1. **Nothing in the repo ever needs a real credential.** Tests run against
   local SQLite and against a `node:http` fake server for Turso and D1.
   There is no fixture, no example and no CI job that requires a real token.
   Example files use obvious placeholders (`libsql://example.turso.io`,
   `TOKEN_GOES_HERE`).
2. **`.gitignore` denies the whole shape of a secret** — `.env*`, `*.pem`,
   `*.key`, `*-credentials.json`, `service-account*.json`, `.dev.vars`,
   `config.toml`, `*.db` — rather than listing known filenames.
3. **A pre-commit hook scans the staged diff** and blocks the commit on a hit.
   It uses `gitleaks` when installed and otherwise falls back to a dependency-free
   pattern scan (`scripts/scan-secrets.sh`). Installed with `make hooks`;
   `make hooks` is part of the contributing instructions and of `tdo doctor`'s
   advice for contributors.
4. **CI runs the same scan on every push and pull request**, over the full
   history, so a hook that someone skipped with `--no-verify` still fails the
   build before merge.

See `CLAUDE.md` for the rules AI assistants must follow in this repo, and
`SECURITY.md` for the user-facing credential-handling documentation and the
disclosure process.

## 7. Documentation language

**All files in this repository are written in English** — code, comments,
commit messages, docs, issues, PR descriptions, CLI help and error strings.
This includes planning documents like this one. Japanese may be used in
conversation with the maintainer, but must not appear in committed files.
CLI message localisation, if it ever happens, goes through a proper i18n
mechanism rather than translated source strings.

## 8. Using `tdo` from an AI agent

This answers a design question raised early: does an AI consumer change the
API, and is MCP needed?

**It does not change the interface.** The CLI *is* the API. An agent that can
run shell commands uses the exact same commands a human does; `--json` and the
documented exit codes are what makes the output parseable. Agent support is
therefore a documentation and output-hygiene concern, not a second interface:

- every command has `--json` with a documented, versioned shape
- machine output on stdout, human noise on stderr
- distinct exit codes per failure class (see §4) so an agent can react without
  parsing prose
- no interactive prompt on any path an agent would take
- `tdo --help` output kept short and stable enough to paste into a prompt
- `docs/agents.md` holds the commands and JSON shapes, so an agent needs no
  trial and error, and `AGENTS.md` is the entry point that routes a tool user
  there and a contributor to `CLAUDE.md`

**MCP is optional, and deferred to v0.4 at the earliest.** It is worth adding
only for clients that cannot run arbitrary shell commands (Claude Desktop with
no terminal access, hosted assistants). If added, it is a thin `tdo mcp`
subcommand that serves stdio MCP and exposes the same operations as tools
(`add_task`, `list_tasks`, `complete_task`, …) by calling the same internal
`Store` interface — never a reimplementation, and never a network listener by
default. (The one listener the tool does have is `tdo serve`, §8.1, which is
loopback unless the user asks otherwise.) The user's credentials stay in their environment exactly as before.

### 8.1 The browser viewer

`tdo serve` serves a local viewer: an OmniFocus-shaped three-pane page over
the store, with full editing. It is the one listener in the tool, and the
rules that keep it from turning the project into the service §1 dropped:

- **Loopback by default.** `--port` chooses the port; reaching it from the
  network takes `--addr`, and saying so earns a warning naming what was
  exposed.
- **A front end, not a second implementation.** Every read and write goes
  through `packages/core/src/taskops`, the layer the command bodies go
  through, and a
  task is serialized as `output.TaskView` — the documented `--json` shape.
  Completing a repeating item in the browser is the same call `tdo done`
  makes, so §3.4 cannot have two answers.
- **Writes need a per-process token**, handed to the page and sent as a
  header. A browser will connect to localhost from any page, but it cannot
  read the page or the response, so it cannot write. A cookie would have been
  attached automatically and would have been the vulnerability.
- **No purge, and no credential.** The irreversible path (§4.2) stays where it
  can prompt, and the viewer never shows or accepts a token: it talks to the
  store the process already opened.
- **One request at a time.** A `Store` expects one caller at a time; the
  server holds a mutex rather than inventing a pool.

The assets are a handful of files under `packages/cli/assets`, read from disk
relative to the module and written by hand: no bundler, no framework, no
dependency. The PWA of §8.2 shares them.

### 8.2 Installing the viewer on a phone

The page is a progressive web app, so a phone on the same tailnet can add it
to its home screen and get a full-screen viewer with an icon. `packages/pwa`
is the other half of that answer: the same viewer, pointed straight at a Turso
database rather than at a local `tdo serve`, so it needs no machine at home to
be awake.

A native iOS client remains undecided and unbuilt. A design note for one was
kept here while the implementation was Go, built on a `gomobile` binding; the
TypeScript migration removed its premise along with the Go tree, and the note
was deleted rather than left to describe a mechanism that no longer exists.

There are two front ends and two service workers, and they have **opposite
cache policies** on purpose. The distinction is worth stating precisely,
because it is the only place in the tree where the same file name means two
different designs.

- **`packages/cli/assets/sw.js` caches nothing** — no `caches`, no
  `respondWith`, and a test says so. It is registered because a page with a
  manifest and a worker is installable, and for no other reason. This page in
  particular could never be cached: it carries the per-process write token, so
  a stale copy would hold a token a restarted server no longer honours, and
  the first edit would fail with a 403 for no visible reason on the one device
  with no devtools window to find out why. Out of range, the browser says it
  cannot reach the server, which is the truth — the server really is the thing
  that went away.
- **`packages/pwa/public/sw.js` caches the shell, and only the shell.** This
  app has no server and no per-process token; it is a static site whose whole
  reason to exist is to be installed on a phone, where a cold start with no
  shell is a blank screen. So the page, the stylesheets, the modules, the
  manifest and the icons are precached from a literal allow-list, served
  cache-first, and revalidated behind the answer.

The consequence is the one that matters in use: **the only host this app needs
to reach is the user's own database.** Once it is installed, whether
`soya-miyoshi.github.io` is reachable is irrelevant — the shell comes off the
device, and the first request that leaves the tab goes to Turso. A phone on a
network that cannot see GitHub, or a GitHub outage, costs nothing.

What is still deliberately absent is an offline *data* mode, and that has not
changed. No API response can enter a cache, and there is no code path here
that could put one there: `shim.ts` answers `/api/*` inside the page, so a
request that never leaves the tab never passes a service worker at all, and
the worker does not call `respondWith` for a cross-origin URL. A phone holding
a second opinion about the tasks is the sync problem §10 has not taken on, and
a screen that looks live and is not would break the one property this project
is for — that the CLI, the browser and the phone cannot disagree about what is
available. Without the database the app opens, says it cannot reach it, and
shows nothing it might be wrong about. That also keeps the credential out of
every cache: the one copy is the one in storage that `credentials.ts` owns.

**A worker is registered only in a secure context**, which is what a browser
requires: loopback, or TLS. That is why the hosted build is the real answer
for a phone and `tdo serve` across a tailnet is not: reached as plain `http://`
there is no worker and no install, and the viewer degrades to an ordinary page
rather than breaking. `tailscale serve` in front of `tdo serve` is how that
install gets its `https://`, and it is documented rather than required.

**Where the PWA is hosted, and the one thing that choice costs.**
`.github/workflows/pwa.yml` publishes the build to `soya-miyoshi.github.io`,
a repository holding nothing but the output. A user site is served from the
domain root, and the root is what this app needs: `manifest.webmanifest`
declares `id`, `start_url` and `scope` as `/`, the import map and the
`<link>`s in `index.html` are absolute, and `sw.js`'s precache list is a list
of literal absolute paths. Under `…github.io/todocloud/` the manifest's scope
would not contain the page, so the browser would refuse to install it, and
`addAll` would reject as a unit and leave no shell at all. Nothing secret is
published: the app has no credential of its own, and the one it is given is
typed in by the person using it (`packages/pwa/src/credentials.ts`).

The cost is that **the whole subdomain is now this app's origin**, and that
is a security boundary, not a URL detail. Browser storage is scoped to an
origin and not to a path, so every page under `soya-miyoshi.github.io/*` —
any other repository of the maintainer's published to Pages, and every
third-party script such a page loads — could read the database token out of
storage. Other people's sites cannot: `someone-else.github.io` is a different
host, and `github.io` is on the Public Suffix List, so there is no
cross-subdomain cookie to share either. The service worker widens the same
point: its `fetch` handler maps *any* navigation on the origin to `/`, so once
it is installed every path on the subdomain serves this app's page.

So the subdomain is dedicated to `tdo` by decision, and the decision is
recorded here because nothing enforces it: enabling Pages on a second
repository is what breaks it, and it breaks quietly. The clean fix, if that
ever becomes tempting, is a custom domain — it needs no change to the build,
only a `CNAME`, and it moves the app to an origin of its own. The mitigations
that remain available on a shared origin are the ones the connect screen
already argues for: a per-database token rather than a Platform API token,
`--expiration` on it, `turso db tokens invalidate` to rotate, `--read-only`
for a device that only needs to read, and leaving the token in
`sessionStorage` rather than asking the browser to remember it.

Updates reach an installed phone without the user doing anything.
`packages/cli/assets/app.js` registers the worker with
`updateViaCache: 'none'`, so `sw.js` is always fetched from the network and a
changed byte in it installs a new worker, which re-fetches the whole shell and
claims the clients. The cache name is that byte, so the deploy workflow stamps
it with the commit rather than trusting a hand-written bump: without that, an
unchanged name means the update arrives only through `shell()`'s background
revalidation, and the next launch still opens the previous build — with the
import map and the emitted modules from two different builds for that window.


The icons are generated by `scripts/genicon.mjs` (`make icons`), with no
dependency, so the
committed PNGs can be rebuilt rather than merely replaced.

## 9. Milestones

Nothing has been released and the repository has no tag, so there is no
compatibility to preserve: the schema, the `--json` shapes and the command
surface are still free to change, and the work below is sequenced by
dependency rather than by version number.

**Shipped — the SQLite CLI.** `Store` interface, SQLite implementation
(`node:sqlite`, built in, so there is no native build step), the open
`fields` column and `--set`/`--where`, `--json` everywhere, config loading and
the credential precedence of §5, `tdo login` (§5.1), `Secret` redaction type,
full repo-safety tooling (§6), README, MIT license.

**Shipped — Turso.** `Store` over the libSQL `/v2/pipeline` HTTP API, tested
against a `node:http` fake (`packages/store-turso/src/fakeserver.test.ts`)
backed by a real in-memory `node:sqlite` engine, so the LIKE-escaping and
constraint behaviour asserted is the engine's. No new dependency: `fetch` and
`node:http`.

**In progress — the GTD model (§3) and its command surface (§4).** Folders,
projects and the inbox as one tree; `status` in place of the `done` boolean;
availability; repetition and series; review; perspectives. Because this
reshapes the core, it lands as one piece across the domain types, the store
interface, both providers and the command layer, with a shared provider
conformance suite (`packages/store-testkit`) as the specification both
providers are held to.

**In progress — tags as first-class, schema version 2.** A `tags` table, a
status per tag, the two availability rules it drives (§3.3 rule 2a), and
`tdo tag`. It lands with three corrections the same work made obvious: a
reference that resolved to the wrong kind of item, a flag that was accepted
and ignored by `tdo project <ref>`, and an order that could not be changed
without recreating the item. The single-item `--json` envelope was merged into
the listing shape at the same time, which is a breaking change and is why it
happened now rather than later.

**Dropped — Firestore.** Built, tested and green against the pre-GTD
interface with no new dependency, then removed when the GTD model landed; the
reasoning is in §2. Nothing in the tree references it.

**Later — Cloudflare D1.** REST `/query` implementation, batched statements,
and the account-wide-token warning from §2 placed prominently in the D1 docs.

**Later, only if asked for:** `tdo mcp` (§8), multi-device conflict handling
beyond last-write-wins, a TUI, shell completions
(`tdo completion bash|zsh|fish`), attachments, and an optional Worker provider
for anyone who wants to avoid handing the CLI a broad token.

## 10. Open questions

- Turso vs. plain libSQL naming in the docs and config (`provider = "turso"`
  vs `"libsql"`). Settled as `turso`, since that is the name on the account the
  token comes from; a self-hosted sqld is reached through the same provider by
  giving it an `http://` URL.
- Whether `tdo ls` should default to hiding completed tasks. Settled, and
  widened: `tdo ls` shows *available* items (§3.3), which excludes completed,
  dropped, deferred and sequentially blocked ones. `--all` shows everything.
- Multi-device: last-write-wins on `updated_at` is assumed. Good enough for one
  person on several machines; revisit only with a real complaint. The tree
  makes this slightly worse than it was — two devices can reparent the same
  item differently — but not worse than the tombstone already was.
- Should `tdo export`/`import` be the migration path between providers, or is a
  dedicated `tdo sync --from sqlite --to turso` worth it? (Export/import first.)
  For now switching providers moves no data: there is no automatic migration,
  and the path is `tdo export` on the old store followed by `tdo import` on the
  new one, which is lossless including user-defined fields. The export envelope
  carries a `store` key naming where it was taken from, so an archive is not
  anonymous.
- **Named stores?** Instead of selecting a bare provider name, the config file
  could hold `[store.work]` / `[store.personal]` sections selected with
  `--store NAME`, the way AWS CLI profiles and `kubectl` contexts work. It would
  help anyone keeping more than one list, and it makes "which store am I on"
  answerable by name rather than by provider. It is also a considerably bigger
  surface, and v0.1 does not need it. Undecided.
- **Filtering is asymmetric, and the asymmetry is deliberate.** Conditions on
  user-defined fields (`--tag`, `--due-before`, `--where`) are evaluated
  *client-side*, so the same flags behave identically on every provider, while
  SQLite's `json_extract` accepts anything. Server-side filtering therefore
  covers the required fields only. Whether this stays acceptable once a list
  grows large enough to make the client-side pass expensive is open — and
  availability (§3.3) raises the stakes, because it needs the ancestors of
  every candidate, not just the candidate.
