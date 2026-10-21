# todocloud (`tdo`)

A todo list in a database **you** own.

`tdo` is a single-binary CLI. You point it at your own database with your own
credentials, and it talks to that database directly — a local file for SQLite,
HTTPS for Turso. There is no todocloud server, no account to sign up for, and
no telemetry — your tasks go to your database and nowhere else.

> **Status: pre-1.0.** The schema, the `--json` shapes and the command surface
> are still free to change until 1.0. `PLAN.md` is the design and the
> reasoning behind it.

## Why

Most todo CLIs either keep data in a local file you then have to sync yourself,
or they put it in someone else's cloud. This one takes the third option: bring
your own database, keep the CLI ergonomics.

The model is GTD as OmniFocus implements it, not a flat checklist — because the
useful question is not "what do I have to do" but "what can I do right now",
and answering it needs projects, deferral and sequencing.

## Install

```sh
brew install soya-miyoshi/tap/tdo

# or, from a clone, with Node and Bun (see mise.toml):
make install
```

`tdo` is one file with no runtime to install: the executable is compiled with
`bun build --compile`, so it carries its own JavaScript engine. Node and Bun
are needed to *build* it, not to run it.

Archives are published for Linux and macOS on both Intel and Apple Silicon /
arm64, and for Windows on amd64. Homebrew covers macOS and Linux; everything
else downloads an archive.

### From an archive

Download the one for your platform from the
[releases page](https://github.com/soya-miyoshi/todocloud/releases) —
`tdo_<version>_<os>_<arch>.tar.gz`, or `.zip` for Windows — and check it
against the `SHA256SUMS` file published beside it before unpacking:

```sh
sha256sum --check --ignore-missing SHA256SUMS   # shasum -a 256 -c on macOS
tar -xzf tdo_<version>_<os>_<arch>.tar.gz
mv tdo ~/.local/bin/                            # anywhere on your PATH
```

Each archive holds one static binary with nothing to install alongside it, so
installing is moving that file somewhere on your `PATH`, and uninstalling is
deleting it.

**On Windows** there is no package manager route: Homebrew does not cover
Windows, so download `tdo_<version>_windows_amd64.zip` from the releases page,
check it against `SHA256SUMS` the same way, and put `tdo.exe` wherever your
`PATH` can find it. Windows on arm64 has no archive yet.

The tap carries the latest `vX.Y.Z` tag. A prerelease (`-rc.1` and the like)
is on the releases page only, deliberately: `brew upgrade` should not move
anyone onto one.

Releases are cut by pushing a `vX.Y.Z` tag: the workflow runs the tests on both
runtimes, cross-compiles linux amd64 and arm64, darwin amd64 and arm64 and
windows amd64 from one machine, publishes the GitHub release with its
checksums, and pushes the formula to the `soya-miyoshi/homebrew-tap`
repository. The tap update needs a `HOMEBREW_TAP_TOKEN` secret and is skipped
when it is absent — a missing token costs a `brew upgrade`, not a release —
and a prerelease tag (one containing a `-`) never touches the tap. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the full procedure.

## First run

Local SQLite needs no credential at all:

```sh
tdo init                           # creates ~/.local/share/todocloud/tasks.db
tdo add "Pay the invoice" --due 2026-11-01
tdo ls
```

`tdo init` is the one command that creates the database; no other command
creates the file or the directory holding it. Point `tdo` at the wrong path and
you get an error telling you to run `tdo init` — not a second, empty task list.

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
tdo show 3                   # one item in full, with the reason it is blocked
tdo next                     # the single first action
```

This is why putting a project on hold empties it from every list — which is the
whole point of putting a project on hold. A **tag** can be put on hold the same
way, and then everything filed under it steps out of the way: the errands that
cannot happen until the car is back are a context, not a date. `--json` output carries `available`
and, when it is false, `blocked_by` naming the rule and the item responsible,
so nothing has to recompute it.

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

## A browser viewer

`tdo serve` serves a small read-write viewer for your list on a local port:
perspectives on the left, the items in the middle, one item's details on the
right.

```sh
tdo serve                  # http://127.0.0.1:7373/
tdo serve --port 8080      # somewhere else
tdo serve --port 0         # any free port; it prints the one it got
```

It reads and writes through the same code the commands do, so completing
something in the browser is `tdo done`, repeat and all. Four things worth
knowing:

- **It installs on a phone.** The page is a progressive web app: open it from
  your phone and use the browser's *Add to Home Screen* to get a full-screen
  viewer with an icon. It is a window onto the machine running `tdo serve`,
  not a copy of your list: nothing is cached, so there is no offline mode and
  nothing stale to mistake for the truth. Out of range it is simply a page
  that cannot load.
- It listens on `127.0.0.1`. `tdo serve --addr 0.0.0.0` makes it reachable
  from your network, and says so when you do — anyone who can load the page
  can edit the list.
- Writes carry a token minted when the server starts and handed to the page,
  so another site open in the same browser cannot change your list. Restarting
  the server invalidates it; reload the page.
- Reaching it from a phone means exposing it beyond loopback. The safe way is
  a private network rather than the open one: with
  [Tailscale](https://tailscale.com), `tailscale serve --bg 7373` puts it
  behind your tailnet's own HTTPS name, visible to your devices only — and
  the `https://` is also what makes it installable on Android, since a
  browser only accepts a service worker over TLS or loopback. Both MagicDNS and HTTPS
  certificates have to be on for your tailnet
  ([admin console → DNS](https://login.tailscale.com/admin/dns)); without
  them there is no name to serve under and the command hangs rather than
  saying so.

There is no purge button. `tdo rm --purge` stays at the terminal, where it can
ask you first.

## Providers

| Provider | Credential | Can the credential be scoped to just this database? | State |
|---|---|---|---|
| Local SQLite | none — a file path | n/a | works |
| Turso / libSQL | database URL + token | **Yes, per database.** Recommended for narrow credentials. | works |
| Cloudflare D1 | account ID + API token | **No — the token covers every D1 database in the account.** See [SECURITY.md](SECURITY.md) | later |

A Firestore provider was built and then removed; it is not coming back. The
reasoning is in [`docs/providers.md`](docs/providers.md) and in PLAN.md §2.

Turso is the provider to choose if you want the narrowest possible credential,
because its tokens are issued per database — and `tdo login` mints one for you
with the `turso` CLI, so nothing is ever pasted. See
[`docs/providers.md`](docs/providers.md) for the setup of each.

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
[`docs/providers.md`](docs/providers.md).

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
(see [`config.example.toml`](config.example.toml)). `tdo` maintains that file
for you: `tdo config set turso.url libsql://example.turso.io` edits it in
place — your comments, blank lines, key order and spacing survive, and nothing
you did not name is touched — and `tdo login` writes the `provider` and the
`[turso] url` it just learned, saying on stderr what it wrote (`--no-save`
skips it). It never writes a credential: a key named `token` is refused, as is
any file inside a git repository or outside
`~/.config/todocloud/config.toml` / `$TODOCLOUD_CONFIG`. A token comes from an
environment variable, from the OS keychain where `tdo login` put it, or — as a
last resort, and only outside every git repository, at mode 0600 — from that
file; see [SECURITY.md](SECURITY.md). On Windows that last resort is not
available: mode 0600 is a POSIX notion, so a token in the file is never
loaded there and the environment variable is the way to hold one. There is
deliberately no `--token` flag,
because command-line arguments are visible to other processes and land in your
shell history.

## Use from an AI agent or a script

Every command takes `--json`, writes machine output to stdout and everything
else to stderr, uses documented exit codes (`0` ok, `1` error, `2` usage, `3`
config or credential, `4` provider or network, `5` not found, `6` ambiguous
id), and never prompts except where it would destroy data or mint a credential.
That is the whole integration surface — start at [`AGENTS.md`](AGENTS.md),
which routes you to [`docs/agents.md`](docs/agents.md) for the contract.

Backgrounding is your shell's job: `tdo` is a plain foreground process with no
daemon and no listener, and running several at once is safe — the SQLite store
uses WAL with a busy timeout, so parallel writers queue instead of failing.
Give each backgrounded process its own file or pipe, though: a large `--json`
document is past the size a pipe writes atomically, so two of them sharing one
stdout can interleave. An MCP server (`tdo mcp`) is planned only for clients
that cannot run shell commands.

## Contributing

Two toolchains, both pinned in `mise.toml`, so `mise install` gets you the
right ones. Node runs the sources directly and runs the tests; Bun compiles
the shipped executable. Node 24 or newer is enough to develop and test
against — the old "official Node 25.5 or newer" requirement was Node's own
single-executable build looking for a sentinel string Homebrew's node does not
carry, and that build is gone.

There are no runtime dependencies at all, and `typescript` is the only
devDependency.

```sh
npm ci
make hooks     # install the pre-commit secret scan — do this first
make check     # type-check, test, secret scan
make binary    # compile the single executable into ./dist-bin/tdo
make binary ARGS=--all   # ...and every other platform's, from this machine
```

Nothing in this repository needs a real credential: tests run against local
SQLite and fake HTTP servers. See [CONTRIBUTING.md](CONTRIBUTING.md) and, if you
use an AI assistant here, [CLAUDE.md](CLAUDE.md).

## License

MIT
