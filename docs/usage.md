# Using `tdo`

The model, the commands that reach it, and the settings around them. The
[README](../README.md) is the short version.

## The model

Folders, projects and tasks are **one tree**, the way OmniFocus has them: a
folder holds folders and projects, a project holds tasks, and a task can hold
tasks (an action group). Containment is a single parent link, and a cycle is
refused.

```sh
tdo folder add Work
tdo project add "Launch the site" --folder Work --sequential --review 1w
tdo add "Write the copy" --project "Launch the site" --estimate 45m --tag writing
tdo add "Call the plumber"                   # no parent: this is the inbox
tdo inbox                                    # what has not been filed
tdo inbox process 1 --project "Launch the site"
tdo ls --tree
```

**The inbox is the absence of a parent**, not a container: nothing has to
create it and it cannot be deleted. `tdo add` with no `--project` and no
`--parent` captures there, because the cost of filing must not be charged at
the moment of capture.

**Four statuses**, not a done flag: `active`, `on_hold`, `done` and `dropped`.
GTD needs *not now* and *decided against, but remember I decided it* to be
different things from *finished*. `tdo hold`, `tdo done`, `tdo drop` and
`tdo undone` move between them.

**`tdo ls` shows what is available, not everything.** An item is available when
it is active, its defer date has passed, every ancestor is active and
undeferred, and — for it and for every ancestor — it is not queued behind an
unfinished sibling in a sequential container. Folders are never available
(they are organisation, not work). Anything else is *blocked*:

```sh
tdo ls                       # what can be worked on now
tdo ls --blocked             # what cannot, and why
tdo ls --deferred            # what is waiting for a date
tdo ls --all                 # everything except tombstones
tdo ls --deleted             # the tombstones
tdo ls --watch               # the same list, redrawing until Ctrl-C
tdo show 3                   # one item in full, with the reason it is blocked
tdo next                     # the single first action
```

This is why putting a project on hold empties it from every list — which is the
whole point of putting a project on hold. A **tag** can be put on hold the same
way, and then everything filed under it steps out of the way: the errands that
cannot happen until the car is back are a context, not a date. `--json` output carries `available`
and, when it is false, `blocked_by` naming the rule and the item responsible,
so nothing has to recompute it.

**`tdo forecast` is the dated work**, which is a different question from what
is available: a task waiting on its defer date is here although `tdo ls` hides
it. It is the same view the browser viewer opens on, from the same code.

```sh
tdo forecast                 # everything dated, by defer date
tdo forecast --sort due      # by deadline instead
tdo forecast --day today     # today — which carries whatever was due before it
tdo forecast --week          # the next seven days, under their own headings
tdo forecast --days 30       # a month of them; --compact skips the empty days
tdo forecast --overdue       # only what was due on an earlier day
tdo forecast --week --watch  # the week, on a screen of its own
```

`--watch` is on `ls`, `next` and `forecast`. It redraws into the alternate
screen until Ctrl-C, every two seconds against a local store and every ten
over the network — `--interval 30s` to pick the pace yourself. It is not
`watch tdo ls`: each frame rewrites the row numbers, so the `3` on screen is
still the `3` that `tdo done 3` means in another window. It needs a terminal
and refuses `--json`, where polling the command is the right answer.

There is no "past" day: an overdue item is today's problem, so it is listed
under today, and the count on stderr says how many of today's rows arrived
from an earlier day.

The rest of the model, in the commands that reach it:

```sh
tdo defer 3 2026-11-01             # and tdo due 3 2026-11-05, tdo due 3 --clear
tdo flag 3                         # and tdo unflag 3
tdo edit 3 --tag home,errand --estimate 25m   # --tag replaces; --untag removes one
tdo mv 3 7                         # reparent under ref 7; --inbox and --top also work
tdo mv 3 --after 7                 # and --before 7: the order among its siblings
tdo tag ls                         # every tag, its status and how many tasks carry it
tdo tag hold errand                # a tag on hold takes its tasks out of every list
tdo tag unhold errand              # and tdo tag drop / rename / rm
tdo repeat 3 1w:from_completion    # fixed | from_completion | defer_another
tdo series 3                       # every instance of one repeating item
tdo review                         # the folders and projects due for review
tdo review 3 --interval 2w         # mark one reviewed
tdo perspective save hot -- --flagged --due-before 2026-12-01
tdo ls --perspective hot
```

A repeating item gets its successor **only from an explicit `tdo done`** —
nothing is generated in the background, on a timer, or while something is being
read. A perspective is a saved query and nothing else: it stores no results and
pins no ids, so running one is exactly the same as typing its filter.

A `<ref>` is the small number the last `tdo ls` printed, or an unambiguous id
prefix (`tdo done 01M5C`). The numbers come from a cache of the last *human*
listing; `--json` output never refreshes it.


## Which store are you using?

The `provider` line in `~/.config/todocloud/config.toml` is the normal way to
choose the store, and it is the answer to "which database are my tasks in".
`TODOCLOUD_PROVIDER` overrides it for a shell session or a CI job, and
`--provider NAME` overrides both for a single command.

```sh
tdo config                         # resolved provider, and where it came from
tdo config set provider turso      # write it into your config file
```

When the provider did *not* come from your config file, every command that
writes — `add`, `edit`, `done`, `undone`, `rm`, `init`, `migrate`, `import` —
says so on stderr, naming the store it is writing to. Reading says nothing; an
unexpected list speaks for itself. The short numbers `tdo ls` prints belong to
the store that produced them and are never applied to another, and a store with
no schema yet refuses writes and tells you to run `tdo init` — so a mistyped
provider name cannot quietly start a second task list.

Switching providers does **not** move your tasks. There is no automatic
migration: `tdo export` from the old store and `tdo import` into the new one,
which keeps everything including your own fields. See
[`providers.md`](providers.md).


## Upgrading the schema

Every store records the schema version it was created with, and every command
checks it before doing anything, so no command can answer from a schema it does
not understand. Two things can be wrong, and both exit 3:

- **The store is older than the binary.** The message ends with "run
  `tdo migrate` to upgrade it".
- **The store is newer than the binary.** The message ends with "upgrade tdo".
  There is no downgrade.

`tdo migrate` upgrades a store in place. A **local** database is copied aside
first, to `<db>.backup-v<N>` where `N` is the version being left, and the path
is printed before anything changes; an existing backup is never overwritten. A
**remote** database cannot be backed up by `tdo`, so a migration of one asks
first: it prompts on a terminal and refuses with exit 2 when there is no
terminal and no `--yes`. Take your provider's own snapshot if you want one.

Each step is idempotent and the version is recorded after it, so a migration
interrupted halfway — a dropped connection to a remote store — is finished by
running `tdo migrate` again.


## Fields you decide on

The fields the model needs are real columns; anything else you need is just a
field you set — no schema change, no migration:

```sh
tdo add "Review the contract" --set client=acme --set estimate_pages=12
tdo ls --where client=acme
```

A value is typed the way it reads: `--set pages=3` stores the number 3,
`--set ref=3.0.1` stores the string. Your own fields appear as top-level keys
in `--json` output and survive `tdo export` / `tdo import` unchanged. The names
the model uses are reserved and cannot be redefined.

Configuration lives in `~/.config/todocloud/config.toml`
(see [`config.example.toml`](../config.example.toml)). `tdo` maintains that file
for you: `tdo config set turso.url libsql://example.turso.io` edits it in
place — your comments, blank lines, key order and spacing survive, and nothing
you did not name is touched — and `tdo login` writes the `provider` and the
`[turso] url` it just learned, saying on stderr what it wrote (`--no-save`
skips it). It never writes a credential: a key named `token` is refused, as is
any file inside a git repository or outside
`~/.config/todocloud/config.toml` / `$TODOCLOUD_CONFIG`. A token comes from an
environment variable, from the OS keychain where `tdo login` put it, or — as a
last resort, and only outside every git repository, at mode 0600 — from that
file; see [SECURITY.md](../SECURITY.md). On Windows that last resort is not
available: mode 0600 is a POSIX notion, so a token in the file is never
loaded there and the environment variable is the way to hold one. There is
deliberately no `--token` flag,
because command-line arguments are visible to other processes and land in your
shell history.
