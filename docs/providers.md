# Provider setup

Read [SECURITY.md](../SECURITY.md) first: how tightly you can scope the
credential you hand to `tdo` differs sharply between these providers, and that
is the most important difference between them.

Two providers work today: **local SQLite** and **Turso / libSQL**. Cloudflare
D1 is planned and not written; a provider name that is known but not built
exits 3 and says so rather than failing obscurely. A Firestore provider was
built and then removed — see [below](#firestore-removed).

**Turso is the provider to choose if you want the narrowest possible
credential**, because its tokens are issued per database.

## Choosing the store

Three things can decide which provider a command talks to. Highest priority
first:

1. `--provider NAME` — a one-off override, for that command only.
2. `TODOCLOUD_PROVIDER` — the ambient choice, what a shell session, a container
   or a CI job uses.
3. `provider = "..."` in your config file — the normal way, and the one to
   prefer. The config file is the answer to "which store am I using", much as
   `kubectl`'s current context is.

With none of them set, the provider is `sqlite`.

```sh
tdo config                 # resolved provider, plus where that answer came from
tdo config --json          # the same, with an `origins` map
```

`origins` names the source of each resolved value: `flag:--provider`,
`env:TODOCLOUD_PROVIDER`, `file:<path>` or `default`. Run it whenever you are
unsure which database you are about to write to.

### Writing to the wrong store

The thing worth guarding against is not a leaked credential but a write that
lands in the wrong database. Nothing is lost, but the tasks are somewhere you
are not looking — and a stale `TODOCLOUD_PROVIDER` left in a shell, or a
mistyped `--provider`, is exactly how that happens. Five guards:

- **A write announces an unexpected store.** `add`, `edit`, `done`, `undone`,
  `rm`, `init`, `migrate` and `import` print one line on **stderr** naming the
  store, whenever the provider did not come from your config file:

  ```
  tdo: warning: writing to sqlite: /path/to/tasks.db: TODOCLOUD_PROVIDER
  overrides the "turso" named in /path/to/config.toml
  ```

  or `… : --provider selected it for this command only`. It is never on stdout,
  so `--json` output stays parseable. The read-only commands (`ls`, `show`,
  `export`, `config`, `doctor`) stay quiet: an unexpected list is self-evident.
- **No noise when there is nothing to warn about.** A `TODOCLOUD_PROVIDER` that
  agrees with your config file is silent, and so is a machine with no config
  file at all — there the environment *is* the configuration. Only a real
  disagreement, or `--provider`, is announced.
- **The short numbers never cross stores.** The cache behind the numbers
  `tdo ls` prints is keyed by the store that produced it, so a number from one
  provider is never applied to another: it misses, and tells you to run
  `tdo ls`.
- **A store with no schema refuses writes.** Pointing `tdo` at a provider that
  has never been initialised exits 3 and tells you to run `tdo init`, so a
  mistyped provider name cannot quietly grow a second, parallel task list.
- **Only `tdo init` creates a store.** Every other command, `tdo doctor`
  included, opens an existing one and creates neither the database file nor any
  directory above it. `tdo init` reports whether it created the store or found
  it already initialised.

`tdo rm --purge` also names the store in its confirmation prompt, and in its
refusal when there is no terminal to prompt on
(`refusing to purge 2 task(s) from sqlite: /path … pass --yes`).

## Where a token comes from

In this order: the environment variable, then the OS keychain (written by
`tdo login`), then your config file — and a config-file token is loaded only
when the file sits outside every git repository, is
`~/.config/todocloud/config.toml` or `$TODOCLOUD_CONFIG`, and is not group- or
world-readable. A refused token is reported loudly on stderr, with the file and
the line but never the value. `SECURITY.md` has the detail and the reasoning.

```sh
tdo login                  # store this provider's token in the OS keychain
tdo login --show           # is one stored? (presence and a hint, never a value)
tdo login --remove         # delete it (confirms first; --yes skips the prompt)
```

The token is read from stdin only — a non-echoed prompt on a terminal, one line
with no prompt when stdin is a pipe. There is no flag that takes a token, and
there never will be: `argv` is world-readable through `ps` and lands in your
shell history. There is no keychain backend on Windows, where the environment
variable or the config file is used instead.

## Local SQLite (no credentials)

```sh
tdo init                       # creates ~/.local/share/todocloud/tasks.db
TODOCLOUD_SQLITE_PATH=/path/to/tasks.db tdo ls
```

`tdo init` is what creates the file, and the directory above it. No other
command does: a `TODOCLOUD_SQLITE_PATH` pointing somewhere that does not exist
yet exits 3 and tells you to run `tdo init`, so a typo cannot turn into an
empty second task list. A path pointing at a file that is not a database is
refused (exit 4) and that file is left alone.

The database file and the WAL files beside it are kept at mode 0600, and the
directory `tdo init` creates for them at 0700, whatever your umask says; an
existing database with looser modes is tightened when it is opened.

Your tasks are a file on your disk. Nothing is sent anywhere. Back it up
yourself (it is a plain SQLite database, so `sqlite3` and `litestream` work).

## Turso / libSQL (recommended for the narrowest credential)

Tokens can be scoped to a single database, so the credential `tdo` holds cannot
reach anything else you own.

With the `turso` CLI installed and logged in, no token is pasted at all:

```sh
turso auth login
turso db create my-tasks

tdo login --provider turso --database my-tasks
# -> mints a token for THIS database only with `turso db tokens create`,
#    stores it in the OS keychain, and prints the [turso] url line to add
#    to your config file. The token is never shown.

export TODOCLOUD_PROVIDER=turso
tdo init
```

`--database` is optional: `tdo login` takes the database from the configured
Turso URL, or from `turso db list` when it lists exactly one database, and asks
for `--database` (exit 2) rather than guessing. If `turso` is installed but not
logged in, it exits 3 and tells you to run `turso auth login`. If `turso` is
not installed, it says how to install it and falls back to reading a token from
stdin. If a minted token cannot be stored in a keychain, it is discarded rather
than printed, and you are told to run `turso db tokens create` yourself.

Minting creates a token on your Turso account, so it is confirmed first:
`tdo login` prompts on a terminal, and with no terminal and no `--yes` it exits
2 (`refusing to mint a new turso token for database "example" without a
terminal to confirm at; pass --yes`) without minting anything. It does not fall
back to stdin in that case — that would store a credential other than the one
you asked for. A script or an agent that means to mint passes `--yes`.
`tdo login --remove` is guarded the same way.

Without the CLI, by hand:

```sh
turso db show my-tasks --url              # -> libsql://my-tasks-<org>.turso.io
turso db tokens create my-tasks           # token for THIS database only

export TODOCLOUD_PROVIDER=turso
export TODOCLOUD_TURSO_URL=libsql://example.turso.io
export TODOCLOUD_TURSO_TOKEN=TOKEN_GOES_HERE
tdo init
```

Put the URL in `~/.config/todocloud/config.toml` if you like. For the token,
prefer the keychain; the environment variable overrides it, and a `token` key
in the config file is a last resort, loaded only under the guards above.

`https://` is accepted as the same thing as `libsql://`, and an `http://` URL
reaches a self-hosted `sqld`. The provider speaks the libSQL `/v2/pipeline`
HTTP API against that one URL and nothing else: it never calls the Turso
platform API, so no code path in it can create, rename or destroy a database.

A remote store cannot be copied aside, so `tdo migrate` against Turso asks
before it changes anything — see [Upgrading the schema](#upgrading-the-schema).

## Cloudflare D1 — later

Not implemented yet: `provider = "d1"` exits 3 and says so. The setup below is
what it will take, and the warning applies whenever you decide to create the
token.

> **Warning.** A Cloudflare API token cannot be restricted to a single D1
> database. The minimum permission that allows writes, `Account → D1 → Edit`,
> grants read and write access to **every** D1 database in that account — the
> specific database is selected only by the UUID in the request URL. The token
> you give `tdo` can therefore read and modify all of your D1 databases.
>
> If that matters to you, use an account whose only D1 database is this one, or
> use Turso instead. This is a property of Cloudflare's token model and nothing
> `tdo` does can narrow it.

```sh
wrangler d1 create my-tasks                # note the database UUID
# Dashboard -> My Profile -> API Tokens -> Create Token -> Custom token
#   Permissions: Account / D1 / Edit

export TODOCLOUD_PROVIDER=d1
export TODOCLOUD_D1_ACCOUNT_ID=00000000-0000-0000-0000-000000000000
export TODOCLOUD_D1_DATABASE_ID=00000000-0000-0000-0000-000000000000
export TODOCLOUD_D1_TOKEN=TOKEN_GOES_HERE
tdo init
```

`tdo login --provider d1` already works: it reads the token from stdin and
prints the account-wide-token warning above before you paste. There is no
delegation for D1 — `wrangler`'s OAuth token cannot be used from another tool,
so `tdo` neither runs nor detects wrangler.

D1 will use the HTTP API
(`POST /accounts/{account_id}/d1/database/{database_id}/query`).

## Firestore — removed

A Firestore provider was built, tested and working, and then deleted. It is not
planned, not deferred and not coming back. `provider = "firestore"` is still a
recognised name purely so that a config file which names it gets told what
happened rather than "unknown provider": the error (exit 3) points here, and
`tdo login --provider firestore` is a usage error (exit 2) that says the same.

The reason is the data model. The GTD tree landed after Firestore did:
folders, projects and the inbox are one tree, and deciding whether an item is
available needs the ancestors of every candidate, not just the candidate. The
implementation already read the whole collection for every listing, to avoid
demanding hand-built composite indexes; walking a tree on top of that would
have meant downloading the database to list a day's work. Rather than leave it
rotting against an interface it no longer satisfied, it was removed.

One result of it survives: the Firestore REST value converter and both auth
flows (a service-account RS256 JWT, and an ADC refresh token) were written with
no dependency beyond the standard library, which settles the question of
whether a Google auth library would ever be needed here. It would not.

If you have tasks in a Firestore store written by an older build, the path off
it is the same as between any two providers: `tdo export` there, `tdo import`
on a `sqlite` or `turso` store — which means doing it with a build that still
had the provider.

## Upgrading the schema

Every store records its schema version, and every command checks it first, so
no command can answer from a schema it does not understand. A store older than
the binary exits 3 and says to run `tdo migrate`; one newer than the binary
exits 3 and says to upgrade `tdo`. There is no downgrade.

```sh
tdo migrate                # upgrade the configured store in place
tdo migrate --json         # {"from":1,"to":1,"migrated":false,"backup_path":"","steps":[]}
```

- **A local SQLite store is copied aside first**, to `<db>.backup-v<N>` where
  `N` is the version being left, before any statement runs; the path is printed
  as soon as the copy exists, and an existing backup is never overwritten. The
  copy is made with `VACUUM INTO`, so it includes what is still in the
  write-ahead log, and it is mode 0600 like the database itself.
- **A remote store cannot be backed up by `tdo`**, and a migration cannot be
  undone, so `tdo migrate` asks first: it prompts on a terminal, and with no
  terminal and no `--yes` it refuses with exit 2 and changes nothing. Take your
  provider's own snapshot first if you want one.
- **An interrupted migration is finished by running `tdo migrate` again.**
  Every step is idempotent and the version is recorded after the step, in a
  separate round trip, so a connection lost halfway leaves a store whose
  statements ran but whose version did not move. The next run replays the step
  and it succeeds.

## Moving between providers

Switching providers moves no data. There is no automatic migration and no
background sync: a store you switch to holds whatever you put there. The path
is an export followed by an import, which is lossless — timestamps, tags,
notes and the fields you invented with `--set` all survive.

```sh
tdo export --all > tasks.json                    # from the configured store
TODOCLOUD_PROVIDER=turso tdo init                # prepare the new one
TODOCLOUD_PROVIDER=turso tdo import tasks.json   # announces the store on stderr
```

Ids are ULIDs generated client-side, so they survive the move. The export
envelope records which store it came from in its `store` key, so an archive is
never anonymous — see [`agents.md`](agents.md) for the shape. Delete
`tasks.json` afterwards if your tasks are sensitive.

Once the new store has what you want, move `provider` in your config file over
to it, so that the answer to "which store am I using" is in the file rather
than in a shell variable you will forget about.
