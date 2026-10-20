# Using `tdo` from an agent or a script

`tdo` has no separate API. The CLI is the interface, and an AI agent uses the
same commands a human does. What makes it safe to drive programmatically is the
output contract below.

This document is the contract. Changing anything in it is a breaking change.

## Contract

- **`--json` on every command.** Shapes are documented below and versioned with
  the tool.
- **stdout is machine output only.** Warnings, progress and logs go to stderr,
  so `tdo ls --json | jq` is always safe.
- **Exit codes are meaningful**, so an agent can branch without parsing prose:

  | Code | Meaning |
  |---|---|
  | 0 | success |
  | 1 | generic error |
  | 2 | usage error (bad flags, bad arguments, unknown command) |
  | 3 | configuration or credential problem |
  | 4 | provider or network failure |
  | 5 | not found |
  | 6 | ambiguous id prefix |

- **No prompts.** Only the three consequential paths ask for confirmation —
  `tdo rm --purge`, `tdo login --remove` and the delegated Turso mint — and
  each requires an explicit `--yes` rather than assuming it when stdin is not a
  TTY. A non-interactive caller that means to take one of those paths passes
  `--yes`; one that does not pass it gets a refusal and no effect.
- **Errors are JSON under `--json`**: `{"error":{"code":"not_found","message":"…"}}`,
  with the message free of credentials. Under `--json` the error object goes to
  **stdout**; the human-readable form goes to stderr.

## What `tdo` will not do unless you ask for it

- **Create a store.** `tdo init` is the only command that brings a database
  into being. No other command creates the database file or any parent
  directory of it, `tdo doctor` included.
- **Overwrite a task.** `tdo import` never replaces an existing task: an id
  already present in the store is skipped and counted in `skipped`.
- **Generate a row.** Only an explicit `tdo done` creates the next instance of
  a repeating item. No read generates one, and nothing happens on a timer.
- **Empty a container.** `tdo rm --purge` on a container that still holds
  items refuses with exit 2 unless `--recursive` is passed. Plain `tdo rm`
  tombstones the subtree, which is reversible and visible under
  `tdo ls --deleted`.
- **Mint or delete a credential.** Both paths confirm first and refuse without
  a terminal unless `--yes` is passed.
- **Listen on a port.** Only `tdo serve` opens a listener, and only on
  `127.0.0.1` unless `--addr` names something else. Nothing else in the tool
  accepts a connection, and no command ever sends anything anywhere but to
  your own database.

## Running several at once

Backgrounding is the shell's job. `tdo` is a plain foreground process: there is
no daemon, no `--background` flag and no network listener, so a caller that
wants parallelism starts several processes itself. What the tool guarantees for
one that does:

- **Concurrent invocation is safe.** The SQLite store runs in WAL mode with a
  five-second busy timeout, so parallel writers queue instead of failing. A
  test runs eight `tdo add` processes at once and requires either every task
  present afterwards or an explicit non-zero exit from whichever lost —
  never a silent loss.
- **`--json` output is written in one `write` call** per command, so a small
  document cannot be torn. A large one (`tdo ls --json` over hundreds of tasks)
  exceeds the size a pipe writes atomically, so **two backgrounded processes
  writing to the same stdout can interleave**. Redirect each to its own file or
  pipe.
- **The short numbers are per-store, and machine output does not update them.**
  every human listing caches the numbers it printed; `--json` deliberately does
  not, so a script or an agent listing tasks cannot renumber the list under
  whoever is reading the terminal. The same holds for `tdo export --json`,
  while a plain `tdo export` prints the rows `ls` would and keeps the numbers
  in step with them. A machine caller uses the `id` from `--json` and the
  question does not arise.
- **An interrupted command cannot corrupt the store.** WAL makes each write
  atomic, so the task is either there or not.

## Human output is escaped; `--json` is the faithful copy

A title, a tag or a field value is data. In the human table and in `tdo show`,
control characters (C0, C1 and DEL) are escaped before printing: an ESC renders
as `\e`, a carriage return as `\r`, and anything else as `\xNN` or `\uNNNN`. A
stored value therefore cannot colour the terminal, overwrite a row, or make the
output lie about what is stored.

**The stored value is unchanged, and `--json` output is unchanged**: JSON
escapes these characters itself, and `--json` is what a caller parses. So human
output pasted elsewhere is a sanitised rendering rather than the data; parse the
JSON when the exact bytes matter.

## Commands

```
# Capture and the inbox
tdo add <title...> [--project P] [--parent REF] [--inbox]
       [--defer D] [--due D] [--flag] [--tag t1,t2] [--note S]
       [--estimate 25m] [--repeat EVERY[:method]] [--priority N] [--set k=v]...
tdo inbox [--count]
tdo inbox process <ref> (--project P | --parent REF)

# Looking at things (pure reads)
tdo ls [--available|--blocked|--deferred|--all] [--deleted] [--inbox] [--flagged]
       [--project P] [--under REF] [--kind task|project|folder]
       [--status active|on_hold|done|dropped]... [--tag t] [--untagged]
       [--due-before D] [--defer-before D] [--estimate-under 30m] [--priority N]
       [--where k=v]... [--perspective NAME] [--limit n]
       [--sort position|created|updated|due|defer|title] [--tree]
tdo show <ref>
tdo next [--project P]
tdo serve [--port N] [--addr ADDR]

# Changing things
tdo done <ref...> [--no-repeat]
tdo undone <ref...> / tdo drop <ref...>
tdo hold <ref...> / tdo unhold <ref...>
tdo flag <ref...> / tdo unflag <ref...>
tdo defer <ref...> (<when>|--clear)
tdo due <ref...> (<when>|--clear)
tdo edit <ref> [--title S] [--note S] [--estimate 25m] [--tag t1,t2]
       [--untag t] [--priority N] [--set k=v]... [--unset k]...
tdo mv <ref...> (<parent-ref>|--inbox|--top)
tdo mv <ref...> (--before <ref>|--after <ref>)   # order among siblings
tdo rm <ref...> [--recursive] [--purge] [--yes]

# Structure
tdo project add <title...> [--folder F] [--sequential] [--review 1w] [--note S]
tdo project ls [--status ...] [--needs-review]
tdo project <ref> [--sequential|--parallel] [--complete-with-last] [--review 1w]
                  [--folder F]              # F empty moves it to the top level
tdo folder add <title...> [--folder F] [--review 1mo]
tdo folder ls
tdo tag ls [--status S] [--unused]
tdo tag hold <tag...> | unhold <tag...> | drop <tag...>
tdo tag rename <old> <new> | rm <tag...>

# Repetition, review and saved queries
tdo repeat <ref> <every>[:fixed|from_completion|defer_another]
tdo repeat <ref> --stop
tdo series <ref>
tdo review [--due]
tdo review <ref> [--interval 1w]
tdo perspective save <name> -- <ls filter flags...>
tdo perspective ls | show <name> | rm <name>

# Administration
tdo init | tdo migrate [--yes] | tdo config | tdo doctor | tdo version
tdo config set <key> <value>              # e.g. turso.url, provider
tdo login [--provider NAME] [--database NAME] [--remove] [--show] [--yes]
          [--no-save]
tdo export [--csv] [--all] | tdo import <file> [--new-ids]
```

Global flags: `--json`, `--debug`, `--config PATH`, `--provider NAME`. There is
no `--token` flag and there must never be one.

A `<ref>` is either the short number the last *human* listing printed for the
row or an unambiguous id prefix (`01J3`). `--project`, `--folder` and the
reference taken by `tdo project <ref>` and `tdo review <ref>` also accept a
container's exact title, compared case-insensitively; two containers with the
same title make it exit 6, and an id is then the way through.

The numbers come from a local cache of the last human listing — `--json`
output deliberately does not refresh it, see
[Running several at once](#running-several-at-once) — so an agent should use
the `id` from `--json` rather than a number. **Every human listing that prints
numbers caches them**, `ls`, `inbox`, `project ls`, `folder ls`, `review` and
`series` alike, so the numbers on screen are always the numbers that resolve.

**A reference that resolves to the wrong kind of item is an error, never a
guess.** The same `1` means the first row of whichever listing came last, so
`tdo folder ls` followed by `tdo project 1 --sequential` is naming a folder:
that exits 2 saying so, rather than reshaping the folder. A reshape that does
go through reports what the reference turned out to mean on stderr
(`1 → project "Kitchen" (01J3ZQK8)`), which is a human convenience and never
part of `--json` output.

Likewise, **a flag a command accepts at one position but does not apply at
another is a usage error** naming where it does work. `tdo project <ref>`
applies `--sequential`, `--parallel`, `--complete-with-last`, `--review` and
`--folder`; `--note`, `--tag`, `--due`, `--defer`, `--flag`, `--estimate`,
`--status`, `--priority` and `--set` belong to `tdo project add` and
`tdo edit`, and asking for one here exits 2 instead of exiting 0 with nothing
changed.

Ids are ULIDs generated with monotonic entropy, so ids created in one burst
sort in creation order. Two separate `tdo add` processes that land in the same
millisecond may order either way; see `PLAN.md` §3.

Two command-line shapes are easy to get wrong:

- **A value that begins with a dash goes after `--`, and every flag goes
  before it** — `tdo add --json -- "--not-a-flag"`. Anything following `--` is
  an argument, so a flag placed there becomes part of the title. `--note=<value>`
  is the reliable form for a value that could otherwise be read as a flag. The
  one exception is `tdo perspective save <name> -- <flags>`, where what follows
  `--` is deliberately read as the `ls` filter flags to save.
- **`--where key=value` compares against the stored value's type**, so a field
  set from JSON (`--set 'plan={"rounds":2}'`) is not matched by its text form.

## The model

One tree holds everything. A node is a **folder** (organisation; never
actionable, never completed), a **project** (an outcome; contains tasks) or a
**task** (an action, which may contain tasks and is then an action group).
Containment is one `parent_id`: a folder holds folders and projects, a project
holds tasks, a task holds tasks. **A task with no parent is in the inbox** —
the inbox is the absence of a container, so nothing creates it and nothing can
delete it.

An illegal placement and a move that would make a cycle are **usage errors
(exit 2)**, from `add`, `edit`, `mv`, `inbox process` and `import` alike.

`status` is one of `active`, `on_hold`, `done` and `dropped`; `done` survives
in the JSON as a derived boolean equal to `status == "done"`.

### Availability, and why something is blocked

An item is **available** when its status is `active`, its `defer_at` has
passed, no tag it carries is on hold or dropped, every ancestor is active with
no future `defer_at` and no inactive tag of its own, and neither it nor any
ancestor is waiting its turn inside a sequential container. A folder, a
tombstoned item and an orphan are never available.

`tdo ls` shows available items **by default** — a deferred task, a task in an
on-hold project and a task queued behind its sibling are all absent. Widen it
with `--all`, `--blocked`, `--deferred` or `--status`.

Every task object a listing or `tdo show` emits carries the answer, so a
caller never recomputes it:

```json
"available": false,
"blocked_by": {"rule": "ancestor_status", "task_id": "01J3…"}
```

`blocked_by` is `null` when `available` is true. The rules are
`not_actionable`, `deleted`, `status`, `deferred`, `tag_status`, `sequential`,
`missing_parent`, `ancestor_deleted`, `ancestor_status`, `ancestor_deferred`,
`ancestor_tag_status` and `ancestor_sequential`. The most specific one wins:
an item's own deferral is reported before an ancestor's, and `task_id` names
the item responsible — itself, the ancestor, or the sibling whose turn it is.

The two tag rules carry one key more, naming the tag responsible, since the
item itself is not what has to change for the hold to lift:

```json
"available": false,
"blocked_by": {"rule": "tag_status", "task_id": "01J3…", "tag": "errand"}
```

`tag` is present for `tag_status` and `ancestor_tag_status` and absent for
every other rule, so a caller switching on `rule` never has to ask whether
the key might be there.

### Tags carry a status

A tag is a row of its own, not just a string on a task. It has a status —
`active`, `on_hold` or `dropped`; never `done`, since a tag is a context and
not a piece of work — and **a tag that is not active holds back every item
filed under it**, and everything inside such an item. That is what a context
nobody can act in is for: the errands that cannot happen until the car is
back are not deferred to a date and not put on hold one by one.

`tdo tag ls` lists every tag with its status and how many live tasks carry it.
A tag keeps its row, and its status, when its last task is finished: putting a
context on hold is not undone by emptying it. `tdo add --tag` and
`tdo edit --tag` decide which tasks carry a tag; `tdo tag` decides what the
tag *is*.

**Tags are named, never numbered.** The short numbers of a listing belong to
the last listing of items, so `tdo tag ls` neither prints numbers nor
disturbs the ones already cached.

### Repetition: nothing is generated while you read

`repeat` is `{"method":"fixed"|"from_completion"|"defer_another","every":"1w"}`.
`every` is a duration-with-calendar spelling: `3d`, `2w`, `1mo`, `1y`, and
`1mo:last-friday`. `tdo repeat <ref> 1w:from_completion` names the method
after the interval; with no method named it is `fixed`.

**A new instance is created only as the direct result of an explicit
`tdo done`.** `tdo ls`, `tdo show`, `tdo next`, `tdo review` without a
reference, `tdo series` and `tdo export` are pure reads: they generate
nothing, file nothing and refresh nothing. `tdo done --json` reports the
successor it created under `repeated`, and `tdo done --no-repeat` creates
none. `tdo repeat <ref> --stop` ends the series and leaves its history.

Instances of one series share `series_id`; `tdo series <ref>` lists them,
every status and tombstones included.

### Review

`review_interval` is `{"every":"1w"}` on a folder or a project.
`next_review_at` is **derived** from `last_reviewed_at` plus the interval and
is present on every task object (null when there is no interval). A container
with an interval that has never been reviewed is due now. `tdo review` lists
what is due and writes nothing; `tdo review <ref>` marks one reviewed.

### Perspectives

A perspective is a saved filter and nothing else: it holds no results and pins
no ids, so it cannot go stale. `tdo perspective save hot -- --flagged
--kind task` stores the filter that command line expresses, and
`tdo ls --perspective hot` runs exactly it. Passing another filter flag
alongside `--perspective` is a usage error, because a half-overridden
perspective is neither the saved query nor the typed one. Filters evaluated on
the client (`--where`, `--priority`, `--untagged`, `--estimate-under`,
`--sort title`) cannot be saved yet, and saving one is a usage error rather
than a perspective that means something else when it is run.

## JSON shapes

A task, as every command emits it:

```json
{
  "id": "01J3ZQK8V9XW5S6R7T8Y9Z0A1B",
  "kind": "task",
  "title": "Pay the invoice",
  "parent_id": "01J3ZQK8V9XW5S6R7T8Y9Z0A1A",
  "position": 0,
  "status": "active",
  "done": false,
  "flagged": false,
  "sequential": false,
  "completed_by_children": false,
  "defer_at": null,
  "due_at": "2026-11-01T00:00:00Z",
  "estimated_minutes": 25,
  "note": "bank transfer",
  "repeat": null,
  "series_id": null,
  "review_interval": null,
  "last_reviewed_at": null,
  "next_review_at": null,
  "created_at": "2026-10-20T04:11:00Z",
  "updated_at": "2026-10-20T04:11:00Z",
  "completed_at": null,
  "dropped_at": null,
  "deleted_at": null,
  "tags": ["finance"],
  "priority": 2,
  "available": true,
  "blocked_by": null
}
```

Every key above is always present. `done`, `available`, `blocked_by` and
`next_review_at` are **derived**: they are computed on the way out, they are
reserved names, and `tdo import` reads and discards them. Timestamps are
RFC 3339 in UTC; `--due 2026-11-01` means that day at `00:00:00Z`.

**Unknown keys may appear.** Any field the user set with `--set` is flattened
alongside the ones above, so a user-defined `client` field is a top-level
`"client"` key. Do not reject a task object because of a key you do not
recognise; unknown keys round-trip losslessly through `tdo export` and
`tdo import`.

Per command:

**Every command that emits tasks emits the same shape**,
`{"tasks":[…],"count":n}`, including the ones that act on exactly one item:
read `.tasks[0]` where you know there is one. There is no `{"task":{…}}`
envelope and no `null` task.

| Command | Shape |
|---|---|
| `add`, `show`, `edit`, `next`, `inbox process`, `repeat`, `review <ref>`, `project add`, `project <ref>`, `folder add` | `{"tasks":[…],"count":1}` |
| `next` with nothing available | `{"tasks":[],"count":0}` |
| `ls`, `inbox`, `project ls`, `folder ls`, `review` | `{"tasks":[…],"count":n}` |
| `undone`, `drop`, `hold`, `unhold`, `flag`, `unflag`, `defer`, `due`, `mv`, `rm` | `{"tasks":[…],"count":n}` |
| `tag ls` | `{"tags":[{"name":"errand","status":"on_hold","count":3}],"count":n}` |
| `tag hold`, `tag unhold`, `tag drop`, `tag rename` | `{"tags":[…],"count":n}` — the tags as they now stand |
| `tag rm` | `{"removed":["errand"],"count":n,"untagged":n}` — `untagged` is how many tasks lost the tag |
| `done` | `{"tasks":[…],"count":n,"repeated":[…]}` — `repeated` holds the successors created, and is `[]` for a non-repeating item |
| `inbox --count` | `{"count":n}` |
| `series` | `{"series_id":"<id>","tasks":[…],"count":n}` |
| `rm --purge` | `{"purged":["<id>",…],"count":n}` |
| `perspective save`, `perspective show` | `{"perspective":{"name":"…","filter":{…},"created_at":"…","updated_at":"…"}}` |
| `perspective ls` | `{"perspectives":[…],"count":n}` |
| `perspective rm` | `{"removed":"<name>"}` |
| `init` | `{"provider":"sqlite","schema_version":2,"initialized":true,"created":true}` |
| `migrate` | `{"from":2,"to":2,"migrated":false,"backup_path":"","steps":[]}` |
| `doctor` | `{"ok":true,"checks":[{"name":"config","ok":true,"detail":"…"}],"from":2,"to":2,"backup_path":"","steps":[]}` |
| `login` | see below |
| `export` | `{"version":1,"exported_at":"…","store":"sqlite: /path/to/tasks.db","tasks":[…],"count":n,"perspectives":[…],"perspective_count":n}` |
| `import` | `{"imported":n,"skipped":n,"perspectives_imported":n,"perspectives_skipped":n}` |
| `version` | `{"version":"…","commit":"…","go":"…"}` |
| `config` | the resolved configuration, with every secret redacted |
| `config set` | `{"config_file":"/home/you/.config/todocloud/config.toml","created":false,"wrote":true,"changes":[{"key":"turso.url","value":"libsql://example.turso.io","previous":"","added":true,"changed":true}]}` |
| any failure | `{"error":{"code":"…","message":"…"}}` |

**`export` is the one exception to the task shape**: its `tasks` are the
stored rows, without the derived `available`, `blocked_by` and
`next_review_at` keys. An archive records what is stored, not what was
computed about it at the moment it was taken, and that is what makes
`export | import` lossless. `done` is still there, since it is part of the
import format.

`tdo export --csv` has one column per required field and keeps the
user-defined part of each task in a single `fields` column holding the JSON
map, so the CSV round trip is lossless too. A `tags` cell is a
comma-separated list.

`export`'s `store` key names the store the archive was taken from, so an
export is never anonymous about its origin.

`export`'s `perspectives` are the saved queries, in the shape
`perspective show` prints, and `import` restores them. An export is a backup
and the way to move a list to another provider, so leaving the saved queries
out of it would lose them on both paths. `count` is the number of tasks and
only that — what it means beside a `tasks` array everywhere else in this
document — and the saved queries are counted in `perspective_count`. The
envelope's `version` names the shape of the file, and this is shape 1.
`tdo export --csv` is a task
table and carries no perspectives; when there are any to leave out it
says so on stderr, so the CSV on stdout stays a CSV.

### What a listing selects, exactly

- Default: `status` in (`active`, `on_hold`) **and** available.
- `--all`: every status, any availability, tombstones excluded.
- `--blocked` / `--deferred`: open statuses, and not available / held by a
  defer date.
- `--status s`: those statuses, with no availability filter unless
  `--available` is also passed — otherwise `--status done` would always be
  empty.
- `--deleted`: **only** tombstones, with no status or availability filter.
- `--project P` and `--under REF` are the subtree at any depth, not the direct
  children.
- `--limit` counts items the caller asked to see: it is applied after the
  client-side conditions, never before them.
- `tdo export` is everything of every status; `tdo export --all` adds the
  tombstones.

### Creating a store, and what a wrong path does

`tdo init` is the only command that creates anything. Every other command opens
an existing store: it creates neither the database file nor any parent
directory, and neither does `tdo doctor`.

- **An uninitialised or missing store is exit 3**, with
  `store is not initialized; run `tdo init``, rather than a generic error.
  `tdo migrate` against a path that does not exist is exit 3 as well. This is a
  configuration problem, not a transient one, so do not retry it.
- **So a wrong path fails; it does not silently become a second, empty task
  list.** A mistyped `TODOCLOUD_SQLITE_PATH` is reported, not created.
- **A path that points at an existing file which is not a database** is refused
  with exit 4, and that file is not modified.

`init`'s `created` key says which of the two things happened: `true` when this
run brought the store into being, `false` when it was already initialised.
Check it before assuming you are looking at the user's existing list. The
human-readable forms are `created sqlite: /path/tasks.db at schema version 1`
and `sqlite: /path/tasks.db is already initialized at schema version 1`.

### Which store you are talking to

Three things select the provider, highest priority first: the global
`--provider NAME` flag (one command only), the `TODOCLOUD_PROVIDER` environment
variable, and `provider` in the user's config file. With none set it is
`sqlite`.

- **`tdo config --json` is how you check.** It reports the resolved provider and
  an `origins` map saying where each value came from: `flag:--provider`,
  `env:TODOCLOUD_PROVIDER`, `file:<path>` or `default`. Run it rather than
  inferring the store from the environment you can see.
- **A write to an unexpected store prints a notice on stderr**, never on
  stdout: `add`, `edit`, `done`, `undone`, `rm`, `init`, `migrate` and `import`
  name the store when the provider did not come from the config file. `--json`
  stdout is unaffected, so do not treat the extra stderr line as a failure —
  branch on the exit code.
- **Do not change the provider on the user's behalf.** Passing `--provider` or
  setting `TODOCLOUD_PROVIDER` yourself writes into a database the user may not
  be looking at.
- **The short numbers are per-store.** The listing cache is keyed by the store
  that produced it, so a number from one provider never resolves against
  another. Use the `id` from `--json` and the question does not arise.
- A store with no schema refuses writes with exit 3 and advises `tdo init`, and
  nothing is created in the meantime — see above.

### The schema version, and the two ways it can be wrong

Every command checks, before it does anything, that the store holds the schema
this binary writes. The check costs nothing worth counting — on Turso it is
answered from the probe the connection already made — and it is there so that
no command can return a wrong answer, or a raw engine error, against a schema
it does not understand.

Both mismatches are **exit 3** with the error code `config`, and the message
says which one it is:

- **The store is older than the binary.** The message reads: sqlite:
  /path/tasks.db is at schema version 1 and this tdo expects 2; run
  `tdo migrate` to upgrade it. Run it and try again.
- **The store is newer than the binary.** The message reads: … is at schema
  version 3 and this tdo only understands 2; upgrade tdo. There is no
  downgrade. Do not retry; the binary is the thing to change.

`init`, `migrate`, `config`, `version` and `doctor` are exempt. The first two
exist to put a store into the right state, `config` and `version` read no
store at all, and `doctor` reports the mismatch instead of refusing — that is
what it is for.

### `migrate`

`tdo migrate` plans the upgrade before it runs it, and the plan decides what
you see:

1. **The store is already current** — nothing is copied, nothing is changed,
   exit 0. `migrated` is `false`. This is a clean no-op, not an error, so it is
   safe to run unconditionally.
2. **A local store is behind** — the database is copied aside *before any
   statement runs*, to `<database>.backup-v<from>` beside it, mode 0600, and
   the path is printed on stderr and returned as `backup_path`. An existing
   backup is never overwritten. Then the steps run.
3. **A remote store is behind** — there is nothing to copy aside and a
   migration cannot be undone, so this is the one administrative command that
   asks. On a terminal it prints the warning and prompts; **without a terminal
   it refuses with exit 2** rather than assuming consent, exactly as
   `tdo rm --purge` does. Pass `--yes` to say so explicitly, which is what a
   script or an agent does. Declining the prompt changes nothing and exits 0.
4. **The store is newer than the binary** — exit 3, upgrade tdo.

`from` is the version found, `to` the version the store is at afterwards,
`migrated` is `to != from`, `backup_path` is `""` when no copy was taken, and
`steps` names the migrations that were due, in order (`[]` when there are
none). `backup_path`, `steps` and the `--yes` flag were added with the
migration machinery; `from`, `to` and `migrated` are unchanged.

### `doctor`

The checks run in this order: `config`, `provider`, `credential`,
`provider_cli`, `database_directory` (sqlite only), `ping`, `schema`. The shape
is `{"ok":…,"checks":[{"name":…,"ok":…,"detail":…}],"from":…,"to":…,"backup_path":"","steps":[…]}`.

The last four keys are the schema state, in the same spelling `migrate` uses:
`from` is the version the store is at (`0` when it could not be read), `to` the
version this binary writes, and `steps` the migrations `tdo migrate` would run.
A migration is pending when `from != to`. `backup_path` is always `""` here:
planning a migration takes the backup, and `doctor` writes nothing at all. `provider_cli` reports
non-secret facts only — whether the Turso CLI is installed and logged in, or
where Google credentials were found — and it never runs wrangler and never
prints a token. A failed check exits 1 and still prints the full report; it
does not print an error envelope.

`doctor` creates nothing. When the database's directory does not exist yet,
`database_directory` probes the nearest existing ancestor instead, and its
`detail` reads like:

```
/home/you is writable; `tdo init` will create /home/you/.local/share/todocloud
```

### `login`

The token is read from stdin and nowhere else: there is no flag that takes it.
On a terminal the prompt is not echoed; when stdin is a pipe, one line is read
with no prompt, which is what a script or an agent uses.

```json
{"provider":"turso","account":"turso.token","backend":"keychain","stored":true,"source":"turso-cli","database":"<name>","config_file":"/home/you/.config/todocloud/config.toml","config_written":true,"config_keys":["provider","turso.url"]}
```

The three `config_*` keys describe the config file `tdo login` maintained for
you, and are always present on the minting paths: `config_file` is the file it
wrote (empty when it wrote none), `config_written` says whether the file
changed, and `config_keys` names the keys that changed. They are absent from
the `--show` and `--remove` shapes, which write no configuration.

- minted by the Turso CLI: the shape above.
- pasted on stdin: the same without `database`, with `"source":"stdin"`.
- `--show`: `{"provider":"turso","account":"turso.token","backend":"keychain","present":true,"hint":"[REDACTED]…wxyz"}`
- `--remove`: the same keys with `"stored":false,"removed":true`.
- no keychain available: `{…,"backend":"none","stored":false,"instructions":"…"}`,
  exit 0 — nothing failed, the user has been told what to run.
- `--provider firestore`: the error envelope with code `usage` and exit 2.
  That provider was built and removed; the message says so and points at
  `docs/providers.md`.

`tdo login` for `sqlite` is a usage error (exit 2): a local file needs no
credential.

#### What `tdo login` writes to your config file

After minting a Turso token, `tdo login` writes `provider = "turso"` and the
`[turso] url` into your config file, so there is no line to paste. It never
writes a token: the token goes to the OS keychain, and the writer refuses a
key named `token` (or `api_token`, `secret`, `password`, `key`) outright.

It says on stderr which file it wrote and which keys changed; `--no-save`
skips the write and prints the lines instead. **A refused or failed write is
not a failed login**: the token is already stored, so `tdo login` warns, prints
the lines to paste and still exits **0**, with `"config_written":false`.

#### `config set`

```
tdo config set turso.url libsql://example.turso.io
tdo config set provider turso
```

A dotted key is `table.key`; a bare key is top level. The file is edited in
place — comments, blank lines, key order and spacing survive, and no table or
key you did not name is touched — and replaced atomically at mode `0600` in a
`0700` directory. It is created, with a comment header, when it does not exist.

Four things are refused rather than written:

- a key that holds a credential (`token`, `api_token`, `secret`, `password`,
  `key`) — **exit 2**, pointing at `tdo login`;
- a file inside a git repository — **exit 3**;
- any path that is neither `~/.config/todocloud/config.toml` nor the file named
  by `$TODOCLOUD_CONFIG`, which includes every `--config PATH` — **exit 3**;
- a file this reader cannot parse, since rewriting it would lose it — exit 3.

`tdo config` with no arguments is unchanged: it prints the resolved
configuration and writes nothing.

#### `--yes`, and the two paths that confirm

`--yes` ("skip the confirmation prompt") applies to exactly two paths, the same
way it does for `tdo rm --purge`: on a terminal they prompt, without a terminal
they refuse, and `--yes` is the explicit opt-in. **An agent driving `tdo login`
non-interactively must pass `--yes`.**

- **`--remove`** destroys a stored credential, which cannot be recovered. With
  no terminal and no `--yes` it exits **2** and deletes nothing:

  ```
  refusing to delete the stored turso token without a terminal to confirm at; pass --yes
  ```

  Declining at a prompt exits 0 and emits the `--remove` shape with
  `"removed":false`.
- **The delegated Turso mint** creates a new token on the user's Turso account,
  an outward-facing effect on a remote service. With no terminal and no `--yes`
  it exits **2**:

  ```
  refusing to mint a new turso token for database "example" without a terminal to confirm at; pass --yes
  ```

  In that case it does **not** fall back to reading a token from stdin, because
  that would store a different credential than the caller asked for. Declining
  at a prompt exits 0 with:

  ```json
  {"provider":"turso","account":"turso.token","backend":"…","stored":false,"source":"turso-cli","database":"<name>"}
  ```

Deliberately unguarded, because none of them creates or destroys anything:
`--show`, the stdin paste path (the caller supplies the token itself), D1, and
the fallback used when the Turso CLI is absent.

### `import`

An import file is hand-editable, so it is untrusted input and its ids are
checked rather than trusted. An id must be a real ULID: references resolve by
prefix, and listings rely on ids sorting into creation order.

- **The whole file is validated before the first write.** A file that is
  rejected leaves nothing stored, including when the bad task is the last one
  in it. An import is never partial.
- **An id that is not a ULID is refused with exit 2**, naming the position of
  the offending task in the file and pointing at `--new-ids`. A **lower-cased
  ULID is accepted and normalised** — base32 is case-insensitive, so it is the
  same id written differently — which means the task is addressable by its own
  id afterwards and re-importing the same file is a skip.
- **A `null` in the tasks array is a usage error** (exit 2) naming its position
  (`task 3 is null`), not a crash.
- **Every task needs `id`, `title`, `created_at` and `updated_at`.**
  `created_at` and `updated_at` are required even with `--new-ids`, which
  replaces the id and nothing else. `kind` defaults to `task` and `status` to
  `active`, so a hand-written file need not spell them out.
- **The tree is checked as the file is written.** Parents are stored before
  their children whatever order the file is in, and a `parent_id` that names
  nothing, or a placement the containment rules forbid, is a usage error
  (exit 2). The derived keys (`done`, `available`, `blocked_by`,
  `next_review_at`) are read and discarded; `status` is what decides
  completion.
- **`tdo import <file> --new-ids`** assigns fresh ids instead of keeping the
  file's. This is also how data from another tool gets in. User-defined fields
  survive re-identification.
- **A duplicate id is skipped**, whether it is repeated inside one file or
  already present in the store: it is counted in `skipped`, and it is never an
  error and never a driver message. An existing task is never overwritten.
- A file `tdo export` wrote imports with its ids intact, so re-importing an
  export into the same store is still a no-op.
- **The file's `perspectives` are restored, and a name already in use is
  skipped**, counted in `perspectives_skipped`. An import adds and never
  overwrites, for a saved query as for a task: silently replacing the query
  behind `tdo ls --perspective hot` would change what that command means with
  nothing on screen to say so. Names are compared case-insensitively, and a
  name repeated inside one file is a usage error. Perspectives are validated
  with the tasks, before the first write, so a bad one leaves nothing stored.
- **A stored filter carrying a key this binary does not know is refused**
  (exit 2), naming the key. Every field of a filter narrows a listing, so
  dropping one would run the saved query wider than it was saved — and a
  listing that matches too much is acted on rather than noticed.

## Your own fields, from an agent

Only the fields listed above are fixed. Anything else is a field you set, with
no schema change:

```sh
tdo add "Review the contract" --set client=acme --set estimate=3 --json
# {"count":1,"tasks":[{"id":"01J3…","kind":"task","title":"Review the contract",
#           "status":"active","done":false,"parent_id":null,"due_at":null,
#           "tags":[],"note":null,"priority":0,"available":true,
#           "blocked_by":null,"next_review_at":null,
#           "client":"acme","estimate":3, …}]}

tdo ls --where client=acme --json | jq -r '.tasks[].title'
```

`--set k=v` types the value the way it reads:

- `--set estimate=3` stores the number 3, while `--set ref=3.0.1` stores the
  string `"3.0.1"`. `true` and `false` store a boolean, and `null` removes the
  field.
- **A value that parses as a JSON array or object is stored as one**:
  `--set 'plan={"rounds":2}'` stores an object and `--set 'tags2=[1,2]'` an
  array. A value that merely looks like JSON but does not parse stays a string.
- **Any whole number that fits in a 64-bit integer is stored as an integer**,
  including one written `5.0`; a number beyond that range stays a float. This
  is what makes a value compare equal before and after a store round trip,
  since JSON cannot distinguish a whole float from an integer.
- `NaN`, `Inf` and their spellings are kept as **text**, because JSON cannot
  represent them.
- Setting a reserved name is a usage error (exit code 2). The reserved names
  are every key in the task shape above: the required fields of the model and
  the four derived ones (`done`, `available`, `blocked_by`,
  `next_review_at`). `priority` is **not** reserved — it is an ordinary
  user-defined field with a flag and a guaranteed key, kept because it
  predates the model.

One lossy step worth stating plainly: a title or a value containing **invalid
UTF-8 is replaced with U+FFFD** when it passes through JSON. NUL bytes survive.

## Credentials

An agent should never need to see a credential. A token comes from an
environment variable (`TODOCLOUD_TURSO_TOKEN`, `TODOCLOUD_D1_TOKEN`), else from
the OS keychain where `tdo login` put it, else — on POSIX systems only — from
the user's own config file under the guards in `SECURITY.md`; non-secret
settings come from
`~/.config/todocloud/config.toml`. The agent just runs the command.

There is no `--token` flag, and no command prints a token: `tdo config`,
`tdo doctor` and `tdo login --show` redact everything sensitive, which makes
them safe for an agent to run and paste: a configured token appears as
`[REDACTED]#1a2b3c4d`, the marker and a short fingerprint of the value, in
`--debug` output as much as in normal output. The fingerprint is stable for a
given token, so two runs can be compared to see whether the credential
changed; no part of the token itself is ever printed. A secret is never placed in a
subprocess's `argv` either, because `ps` shows `argv` to every user on the
machine.

`--config` can point at any file, and that file can name any SQLite path. That
is not an escalation — anyone who can run `tdo` can already write files — but
it does mean the store is only as trustworthy as the config file you were
pointed at. Use the user's own configuration unless they told you otherwise.

If you are an AI assistant working *on this repository* rather than using it,
read `CLAUDE.md` first.

## `tdo serve`

`tdo serve` puts a browser viewer on a local port: three panes — perspectives,
a list, an inspector — over the same store the commands write to.

```
tdo serve                  # http://127.0.0.1:7373/
tdo serve --port 8080
tdo serve --port 0         # any free port; the chosen one is printed
tdo serve --addr 0.0.0.0   # reachable from the network, with a warning
tdo serve --json           # one object naming the url, printed once listening
```

It is a front end and not a second implementation. Every read and every write
goes through the same internal layer `tdo ls` and `tdo done` go through, and a
task is rendered as the same object `--json` renders, derived keys included
(§ *JSON shapes*). Completing a repeating item through the viewer creates the
same successor `tdo done` creates, because it is the same call.

For an agent there is nothing here worth using: the CLI is the interface, the
JSON is the same, and a long-lived process is a liability where a command is
not. The notes below are about what the listener is, not an invitation to
drive it.

- **Loopback by default.** `--addr` is how a user asks for more, and when they
  do, the warning says what they have exposed.
- **A write needs a token.** One is minted per process and handed to the page
  it serves; mutating requests must carry it in `X-Tdo-Token` and be
  `application/json`. Another site open in the same browser can reach the port
  — browsers connect to localhost from anywhere — but it cannot read the page,
  cannot read a response (no CORS header is ever sent), and so cannot write.
  The token is a header and not a cookie for exactly that reason.
- **One request at a time.** A store is safe for one goroutine, so the server
  serializes requests. A local viewer has one user.
- **No purge.** `DELETE` writes a tombstone and takes the subtree with it,
  like `tdo rm`. The irreversible path stays at a terminal, where it can ask
  (§ *What `tdo` will not do unless you ask for it*).
- **Exit codes have status codes.** The same failure classes, named for the
  other front end: `400` for a bad request (including the tree rules of §3.1
  and a rejected field), `403` for a missing token, `404` for an unknown id,
  `409` ambiguous, `503` for a store that is not initialized or at the wrong
  schema version. The error body is the `--json` error envelope.

## MCP

Not implemented, and not required. An agent that can run shell commands already
has everything it needs. An MCP server is planned, later and only if asked
for, for clients that cannot run shell commands; it will be a `tdo mcp` subcommand
serving stdio and exposing the same operations as tools by calling the same
internal `Store` interface — not a second implementation, and not a network
listener by default.
