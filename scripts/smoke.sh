#!/usr/bin/env bash
# Drive a tdo binary against a throwaway store, and make it impossible for the
# run to reach the user's own data.
#
#   scripts/smoke.sh ./dist-bin/tdo
#   scripts/smoke.sh node packages/cli/src/main.ts
#
# This exists because of two incidents during the TypeScript migration. Both
# had the same shape: a smoke test exported TODOCLOUD_* in one command of a
# `&&` chain, an earlier command failed, the export never ran, and `tdo` did
# what it is designed to do — fall back to the configured provider, which was
# the maintainer's real Turso account. One run created and purged a task
# there; another refreshed the real short-reference cache.
#
# The lesson is not "be careful with &&". It is that a smoke test must not be
# able to fail *open*. So every variable is set here, before anything runs,
# and HOME and the XDG paths are redirected too, so that even a command that
# ignores TODOCLOUD_PROVIDER cannot find the real config file at
# ~/.config/todocloud/config.toml.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <tdo command...>" >&2
  exit 2
fi

dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT

export HOME="$dir/home"
export XDG_CONFIG_HOME="$dir/config"
export XDG_STATE_HOME="$dir/state"
export XDG_CACHE_HOME="$dir/cache"
export TODOCLOUD_PROVIDER=sqlite
export TODOCLOUD_SQLITE_PATH="$dir/tasks.db"
export TODOCLOUD_STATE_DIR="$dir/state/todocloud"
# A credential must not reach a smoke test even by accident.
unset TODOCLOUD_TURSO_URL TODOCLOUD_TURSO_TOKEN TODOCLOUD_D1_TOKEN \
      TODOCLOUD_D1_ACCOUNT_ID TODOCLOUD_D1_DATABASE_ID TODOCLOUD_CONFIG
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME"

run() { echo "+ $*" >&2; "$@"; }

run "$@" --help > /dev/null
run "$@" version --json
run "$@" init
run "$@" add "a task the smoke test added" --tag smoke
run "$@" ls
run "$@" ls --json > /dev/null
run "$@" tag ls
run "$@" done 1 > /dev/null
echo "smoke ok: $dir was used and is being removed" >&2
