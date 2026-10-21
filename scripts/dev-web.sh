#!/usr/bin/env bash
# Run the browser viewer from source, against a throwaway store, so the page
# can be edited with a browser open on it.
#
#   scripts/dev-web.sh            # a fresh store, seeded with a few tasks
#   scripts/dev-web.sh --keep     # reuse the store from the last run
#
# Why a script rather than a command to type: `tdo serve` with no environment
# set finds the real config at ~/.config/todocloud/config.toml and serves the
# maintainer's own provider. Editing the page while it is pointed at real data
# is how a stray click deletes something. So, exactly as scripts/smoke.sh
# does, every variable is set here before anything runs, and HOME and the XDG
# paths are redirected as well, so a command that ignores TODOCLOUD_PROVIDER
# still cannot reach the real store.
#
# The edit loop: `packages/cli/assets/app.js` and `app.css` are read per
# request (`asset` in packages/cli/src/web/web.ts), so saving either one and
# reloading the browser is enough. `index.html` is read once in `New`, so a
# change there needs this script restarted.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
dir="${TMPDIR:-/tmp}/todocloud-dev-web"
keep=
for arg in "$@"; do
  case "$arg" in
    --keep) keep=1 ;;
    *) echo "usage: $0 [--keep]" >&2; exit 2 ;;
  esac
done
[ -n "$keep" ] || rm -rf "$dir"

export HOME="$dir/home"
export XDG_CONFIG_HOME="$dir/config"
export XDG_STATE_HOME="$dir/state"
export XDG_CACHE_HOME="$dir/cache"
export TODOCLOUD_PROVIDER=sqlite
export TODOCLOUD_SQLITE_PATH="$dir/tasks.db"
export TODOCLOUD_STATE_DIR="$dir/state/todocloud"
# A credential must not reach a development run even by accident.
unset TODOCLOUD_TURSO_URL TODOCLOUD_TURSO_TOKEN TODOCLOUD_D1_TOKEN \
      TODOCLOUD_D1_ACCOUNT_ID TODOCLOUD_D1_DATABASE_ID TODOCLOUD_CONFIG
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME"

tdo() { node --experimental-strip-types "$root/packages/cli/src/main.ts" "$@"; }

# ref adds an item and prints its id, so later commands can refer to it. Every
# `tdo` command that takes a reference wants an id or a short number, never a
# title, and short numbers depend on the last listing — which is exactly the
# state a seed must not rely on.
ref() { tdo "$@" --json | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1; }

# seed builds a store that exercises the shapes the viewer has to lay out. It
# is not a realistic todo list; it is one of everything. A UI change that
# looks right on five inbox tasks and breaks on a sequential project whose
# first child is deferred is the kind this is here to catch.
seed() {
  tdo init >/dev/null

  # --- folders, including a nested one -------------------------------------
  work="$(ref folder add "Work" --review 1w --note "reviewed every Monday")"
  tdo folder add "Personal" >/dev/null
  clients="$(ref folder add "Clients" --folder "$work")"
  tdo folder add "Someday" --folder "$work" --tag someday >/dev/null

  # --- a sequential project: only the first child is available -------------
  ship="$(ref project add "Ship 0.2.0" --folder "$work" --sequential \
    --due 2026-10-31 --review 2w --tag release --priority 3 --estimate 6h)"
  tdo add "write the release notes" --parent "$ship" --tag docs --estimate 45m >/dev/null
  tdo add "tag the release" --parent "$ship" --tag release >/dev/null
  tdo add "update the Homebrew formula" --parent "$ship" --tag release --flag >/dev/null
  shipdone="$(ref add "cut the release branch" --parent "$ship")"
  tdo done "$shipdone" >/dev/null

  # --- a parallel project that closes itself when the last child is done ---
  site="$(ref project add "Website redesign" --folder "$clients" --parallel \
    --complete-with-last --tag client --note "waiting on copy from the client")"
  tdo add "redraw the landing page" --parent "$site" --estimate 3h --priority 2 >/dev/null
  tdo add "rewrite the pricing copy" --parent "$site" --defer 2026-11-15 >/dev/null
  tdo add "replace the screenshots" --parent "$site" --tag design,client >/dev/null

  # --- a project on hold: it and everything in it are blocked -------------
  taxes="$(ref project add "Taxes 2026" --folder "$work" --due 2027-03-15 --tag admin)"
  tdo add "collect the receipts" --parent "$taxes" >/dev/null
  tdo add "book the accountant" --parent "$taxes" >/dev/null
  tdo hold "$taxes" >/dev/null

  # --- a project decided against, which must not read as done -------------
  dropped="$(ref project add "Rewrite in Rust" --folder "$work" --tag someday)"
  tdo add "benchmark the parser" --parent "$dropped" >/dev/null
  tdo drop "$dropped" >/dev/null

  # --- an action group: a task with children, not a project ---------------
  trip="$(ref add "plan the trip to Kyoto" --tag travel --note "late November")"
  tdo add "book the flight" --parent "$trip" --due 2026-10-22 --flag >/dev/null
  tdo add "book the ryokan" --parent "$trip" >/dev/null

  # --- the inbox, one of each edge ----------------------------------------
  tdo add "reply to the issue about Windows" --tag support --flag --priority 3 >/dev/null
  tdo add "overdue on purpose" --due 2026-10-10 --tag docs >/dev/null
  tdo add "not available until mid-November" --defer 2026-11-15 >/dev/null
  tdo add "a two-minute thing" --estimate 2m >/dev/null
  tdo add "no tags, no dates, nothing" >/dev/null
  tdo add "a task with a note long enough to wrap in a narrow column, which is where a viewer's layout usually gives up" --note "$(printf 'first line\nsecond line\nthird line, to prove a multi-line note survives the round trip')" >/dev/null
  tdo add "タイトルに日本語と emoji 🎉 が入っている" --tag i18n >/dev/null
  tdo add "<script>alert(1)</script> & \"quotes\"" --tag i18n --note '<b>not bold</b>' >/dev/null
  tdo add "user-defined fields" --set energy=low --set context=@phone --tag admin >/dev/null

  # --- a repeating task with one completed instance, so a series exists ---
  water="$(ref add "water the plants" --repeat 1w --tag home)"
  tdo done "$water" >/dev/null
  tdo add "pay the rent" --repeat 1mo:last-friday:fixed --tag home --due 2026-10-30 >/dev/null

  # --- a tombstone, for the --deleted view --------------------------------
  gone="$(ref add "deleted, but not purged")"
  tdo rm "$gone" >/dev/null

  # --- a completed plain task and a dropped plain task --------------------
  milk="$(ref add "buy milk" --tag home)"
  tdo done "$milk" >/dev/null
  nope="$(ref add "learn to juggle" --tag someday)"
  tdo drop "$nope" >/dev/null

  # --- saved queries ------------------------------------------------------
  # Only the flags the store can evaluate may be saved: `tdo perspective save`
  # refuses --where, --priority, --untagged, --estimate-under and
  # --sort title, and --tree is a rendering flag rather than a filter.
  tdo perspective save today -- --available --due-before 2026-10-22 >/dev/null
  tdo perspective save flagged -- --flagged >/dev/null
  tdo perspective save overdue -- --due-before 2026-10-21 >/dev/null
  tdo perspective save loose-ends -- --inbox >/dev/null
  tdo perspective save work-tree -- --under "$work" --all >/dev/null
  tdo perspective save on-hold -- --status on_hold >/dev/null
  tdo perspective save blocked -- --blocked >/dev/null
  tdo perspective save waiting -- --deferred >/dev/null
  tdo perspective save home -- --tag home --all >/dev/null
  tdo perspective save projects -- --kind project --all >/dev/null
}

if [ ! -f "$TODOCLOUD_SQLITE_PATH" ]; then
  seed
fi

echo "store: $TODOCLOUD_SQLITE_PATH" >&2
exec node --experimental-strip-types "$root/packages/cli/src/main.ts" serve
