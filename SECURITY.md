# Security

## Reporting a vulnerability

Open a GitHub security advisory on this repository (Security → Report a
vulnerability). Please do not open a public issue for a vulnerability. Expect an
acknowledgement within a week.

## What this tool does with your credentials

`tdo` is a client. It reads the credentials you provide and uses them to talk to
the database you configured. Specifically:

- **A token comes from one of three places**, in this order of precedence:
  1. **An environment variable** — `TODOCLOUD_TURSO_TOKEN`, `TODOCLOUD_D1_TOKEN`.
     It wins outright; when it is set, the keychain is not even consulted. This
     is what CI and scripts use.
  2. **The OS keychain** — written by `tdo login`, read automatically from then
     on. macOS Keychain, or Linux libsecret through `secret-tool`. It is
     consulted only for the token of the provider actually in use, with a
     two-second timeout, and a keychain failure is never fatal: `tdo` warns and
     falls through to the config file. There is no keychain backend on Windows,
     where the environment variable or the config file is used instead. This is
     the recommended place for an interactive user.
  3. **The config file**, under the guards below.
- They are never accepted as command-line flags, because `argv` is readable by
  other processes on the machine (`ps`) and is written to your shell history.
  There is no `--token` flag and there must never be one. For the same reason a
  secret is never passed to a subprocess in `argv` either — when `tdo` talks to
  the keychain binary or to a provider's CLI, the token travels on stdin.
- `tdo` writes a credential to the OS keychain when you run `tdo login`, and
  nowhere else. It never writes a credential into a file it manages, and never
  writes one to disk in plaintext. This holds even though `tdo` now maintains
  your config file — see *What `tdo` writes into your config file* below.
- `tdo` never prints credentials. Tokens are held in a type whose string,
  formatting and JSON representations are `[REDACTED]`; this applies to
  `--debug` output as well. `tdo config` shows the resolved configuration with
  every secret redacted, and `tdo login --show` reports presence plus a short
  fingerprint — never any part of the value.
- `tdo` makes network requests to exactly one host: the provider endpoint you
  configured. There is no telemetry, no update check and no crash reporting.
- Your task data is sent only to your own database.

### When a token in the config file is loaded

A token under `[turso]` or `[d1]` is loaded only when all three guards pass.
The supported spelling is exactly `token`; any other secret-shaped key
(`api_token`, `secret`, `password`, `key`) is never loaded and always warns.

1. **The file is not inside a git repository.** If a `.git` is found walking up
   from it, the token is refused: move the file out of every repository, and
   treat that token as exposed and rotate it.
2. **The file is `~/.config/todocloud/config.toml`** (XDG) **or the file named
   by `$TODOCLOUD_CONFIG`.** A token in a file passed with `--config` is
   refused, because an arbitrary path is too easily one inside a repository.
3. **The file is not group- or world-readable.** Otherwise the token is
   refused, with `chmod 600 <path>`.

A refused token produces a loud warning on **stderr** naming the file, the line
and what to do instead — never the value. A config file that holds no token
produces no warning at all, whatever its mode or location.

### What `tdo` writes into your config file

`tdo config set <key> <value>` and `tdo login` write to the config file. What
goes in it is only ever non-secret configuration:

- **What is written**: `provider`, `[turso] url`, `[sqlite] path`, the D1
  account and database ids — the keys you could paste in by hand. A database
  URL is not a credential.
- **What is never written**: any credential. The writer refuses a key named
  `token`, `api_token`, `secret`, `password` or `key` — the reader's own list —
  before it touches the disk, so no future code path can put a token in the
  file by mistake. `tdo config set turso.token …` exits 2 and tells you to run
  `tdo login`, which stores the token in the OS keychain instead.
- **Where it is written**: `~/.config/todocloud/config.toml` or the file named
  by `$TODOCLOUD_CONFIG`, and nowhere else — exactly the two locations a token
  may be *read* from. A `--config PATH` is refused for writing for the same
  reason it is refused for a token: an arbitrary path is too easily one inside
  a repository.
- **Never inside a git repository**: if a `.git` is found walking up from the
  target, the write is refused. That guard is what keeps a maintained config
  file out of a dotfiles repo that gets pushed.
- **How it is written**: in place, so your comments, blank lines, key order and
  spacing survive and no table or key you did not name is touched; and
  atomically, through a temporary file in the same directory renamed over the
  target, at mode `0600` in a `0700` directory whatever your umask — so an
  interrupted write cannot truncate your configuration, and a file `tdo`
  creates is never group- or world-readable. A directory that already exists is
  tightened if it is group- or world-readable and otherwise left as you set it.
  A file `tdo` cannot parse is refused rather than rewritten.
- **Never silently**: `tdo login` says on stderr which file it wrote and which
  keys changed, and `--no-save` skips the write entirely. A refused write does
  not fail the login — the token is already in the keychain — so it warns,
  prints the lines to paste and exits 0.

### Why a config file is allowed at all

Forbidding it outright does not remove the credential; it pushes people into
`~/.zshrc` — frequently a dotfiles repository that gets pushed — or into a
project `.envrc`, which is *inside* the repository. Both are worse than a
mode-0600 file under `~/.config`. The AWS CLI, gcloud and the Firebase CLI all
keep credentials in a file under `$HOME` for the same reason. The guards above
target the actual failure mode, which is a credential file sitting inside a
repository.

## What this tool creates, and what it spends

`tdo` is meant to be driven by scripts and AI agents, so the question is not
only what it discloses but what it can bring into existence on your behalf.
These are facts about the current implementation, not aspirations.

- **`tdo init` is the only command that creates a store.** Every other command
  opens an existing one: it creates neither the database file nor any parent
  directory, and `tdo doctor` creates nothing either — when the database's
  directory does not exist yet, `doctor` probes the nearest existing ancestor
  and reports what `tdo init` would create. A missing or schema-less store is
  reported as `store is not initialized; run `tdo init`` with exit 3. So a
  mistyped path fails; it does not quietly become a second, empty task list.
- **`tdo init` says which of the two things happened**, in its `created` key
  and in its human output, so a caller can tell a store it just made from one
  that was already there.
- **A store path that points at an existing non-database file is refused** with
  exit 4, and **the file is not modified**.
- **`tdo import` never overwrites an existing task.** An id already present in
  the store is skipped and counted in `skipped`. An id in the file that is not
  a valid ULID is refused (exit 2) rather than stored; `--new-ids` is the way
  to bring in data whose ids are not ULIDs. The whole file is validated before
  the first write, so a rejected file leaves nothing stored.
- **`tdo migrate` copies a local store aside before it changes it**, to
  `<db>.backup-v<N>` at mode 0600, and never overwrites a backup that is
  already there. A remote store cannot be copied aside, so migrating one
  prompts on a terminal and refuses with exit 2 when there is no terminal and
  no `--yes`. An interrupted migration is finished by running `tdo migrate`
  again: every step is idempotent and the version is recorded only after the
  step succeeds.
- **The two `tdo login` paths with consequences confirm first.** `--remove`
  destroys a credential that cannot be recovered, and the delegated Turso mint
  creates a new token on your Turso account. Both prompt on a terminal, and
  both refuse with exit 2 when there is no terminal and no `--yes` — the mint
  does not fall back to reading a token from stdin in that case, because that
  would store a credential other than the one asked for. `--show` and the
  paste-on-stdin path are unguarded, because they create and destroy nothing.
- **Neither `--debug` output nor `tdo config --json` discloses a token.** A
  configured token appears as `[REDACTED]#1a2b3c4d`: the marker and a short
  fingerprint, so you can tell whether the token changed — after rotating one,
  say — without any character of it being printed. The fingerprint is a hash,
  so the same token always prints the same one and two different tokens do
  not.
- **The short numbers from `tdo ls` are cached per store**, so a number
  produced by one provider is never applied to another, and machine output
  (`--json`) does not update that cache at all.
- **Control characters are escaped in human output.** A title, tag or field
  value is data, so the table and `tdo show` render C0, C1 and DEL characters
  as `\e`, `\r`, `\xNN` or `\uNNNN`: a stored value cannot colour your
  terminal, overwrite a row or make the output disagree with the store. The
  stored value and `--json` output are unchanged — JSON escapes these
  characters itself.
- **What `tdo` writes, and with what permissions.** The database file and the
  WAL files beside it are kept at mode `0600`, and the directory `tdo` creates
  for them at `0700`, whatever umask the process inherited; an existing
  database whose mode is looser is tightened when it is opened. The short-number
  cache is `0600` in a `0700` directory, and it is written through a temporary
  file and a rename, so it is never half-written. The one other file `tdo`
  creates is the pre-migration backup above, also `0600`. Nothing else is
  written anywhere: no logs, no temporary copies of task data, no telemetry.
- **`--config` can point at any file, and that file can name any SQLite path.**
  This is not an escalation — anyone who can run `tdo` can already write files
  — but it does mean the store is only as trustworthy as the config file a
  script or an agent was pointed at. What removes the accident is that reads
  create nothing: a config file naming a path that is not there produces an
  error, not a new database.

## Provider credential scoping — read this before choosing a provider

How tightly you can scope the credential you hand to `tdo` differs sharply by
provider. This is the main security difference between them.

### Turso / libSQL — recommended

Tokens can be issued **per database**. A token created for your todo database
cannot touch anything else you own. This is why Turso is the recommended cloud
provider.

With the Turso CLI installed and logged in, `tdo login` mints that token for
you (`turso db tokens create <database>`) and puts it straight in the OS
keychain, so no token is ever pasted or shown. Because minting creates a token
on your account, it asks first: `tdo login` prompts on a terminal and refuses
without one unless you pass `--yes`.

The provider itself talks to exactly one URL, the libSQL pipeline endpoint of
the database you configured. It never calls the Turso platform API, so no code
path in it can create, rename or destroy a database.

### Firestore — removed

A Firestore provider was built and then deleted; it is not planned and not
coming back. The reason is the data model rather than security, and it is in
[`docs/providers.md`](docs/providers.md). `provider = "firestore"` is still a
recognised name only so that an old config file is told what happened: it
exits 3 with a message pointing at that document, and `tdo login --provider
firestore` is a usage error (exit 2) saying the same. Nothing in this tool
reads a Google credential any more.

### Cloudflare D1 — account-wide token, by design

**A Cloudflare API token cannot be restricted to a single D1 database.** The
minimum permission that allows writes is `Account → D1 → Edit`, and it grants
read and write access to *every* D1 database in that account. The specific
database is selected only by the UUID in the request URL, not by the token.

So the token you give `tdo` can read and modify all of your D1 databases. If
that matters to you, use a Cloudflare account whose only D1 database is this
one, or choose Turso instead. Nothing `tdo` does can narrow this; it is a
property of Cloudflare's token model.

There is no delegation for D1: `wrangler`'s OAuth token cannot be used from
another tool, and `tdo` neither runs nor detects wrangler. The token is pasted
on stdin, and `tdo login` prints the warning above before you paste.

### Local SQLite

No credential at all. Your tasks are a file on your disk. Back it up yourself.

## If you leak a credential

Revoke it at the provider first — rotating the token is what actually ends the
exposure. Removing the file or rewriting git history does not, because anything
pushed to a public repository must be assumed to have been copied already.
