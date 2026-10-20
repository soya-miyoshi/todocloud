#!/usr/bin/env bash
# Build tdo from this working tree and install it for the current user.
#
# This is the "I want to use it on this machine" path, not the release path:
# it builds whatever is checked out right now, stamps the version from `git
# describe` so `tdo version` tells you which tree you are running, and puts
# the binary somewhere on your PATH without sudo.
#
#   ./scripts/install-local.sh              build, install, create the store
#   ./scripts/install-local.sh --no-init    install only; create nothing
#   ./scripts/install-local.sh --uninstall  remove the binary (never the data)
#
# The store is never deleted by this script. Removing your tasks is something
# you do deliberately, with a path in front of you.
set -euo pipefail

binary="tdo"
prefix="${TDO_PREFIX:-$HOME/.local/bin}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
do_init=1

for arg in "$@"; do
  case "$arg" in
    --no-init)   do_init=0 ;;
    --uninstall) do_init=-1 ;;
    -h|--help)   sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'unknown option: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

if [ "$do_init" = "-1" ]; then
  if [ -e "$prefix/$binary" ]; then
    rm "$prefix/$binary"
    printf 'Removed %s\n' "$prefix/$binary"
  else
    printf 'Nothing to remove at %s\n' "$prefix/$binary"
  fi
  printf 'Your tasks were not touched. Run `%s config` on another copy to find them.\n' "$binary"
  exit 0
fi

# This repository pins its Go version with mise. Prefer a go that is already
# on PATH — if you have one, it is the one you meant — and fall back to
# asking mise where its go is. The shim directory is not hardcoded: it moves
# with XDG_DATA_HOME, so guessing the path is how this breaks on a machine
# that is not the author's.
if ! command -v go >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then
  if mise_go="$(cd "$repo_root" && mise which go 2>/dev/null)" && [ -x "$mise_go" ]; then
    PATH="$(dirname "$mise_go"):$PATH"
    export PATH
  fi
fi
command -v go >/dev/null 2>&1 || {
  printf 'go is not on PATH. Install it, or run `mise install` in %s.\n' "$repo_root" >&2
  exit 1
}

# A dirty tree is worth saying out loud: the binary you are about to install
# does not correspond to any commit.
version="$(git -C "$repo_root" describe --tags --always --dirty 2>/dev/null || echo "dev")"
commit="$(git -C "$repo_root" rev-parse --short HEAD 2>/dev/null || echo "")"
pkg="github.com/soya-miyoshi/todocloud/internal/cli"

printf 'Building %s %s\n' "$binary" "$version"
mkdir -p "$prefix"
CGO_ENABLED=0 go build -C "$repo_root" -trimpath \
  -ldflags "-X ${pkg}.version=${version} -X ${pkg}.commit=${commit}" \
  -o "$prefix/$binary" ./cmd/tdo

printf 'Installed %s\n' "$prefix/$binary"

case ":$PATH:" in
  *":$prefix:"*) ;;
  *)
    printf '\n%s is not on your PATH. Add this to your shell profile:\n' "$prefix"
    printf '    export PATH="%s:$PATH"\n' "$prefix"
    ;;
esac

# `tdo init` is the only command that creates a store, so it is the only
# thing here that writes outside the binary. It is idempotent: running this
# script again does not disturb an existing list.
if [ "$do_init" = "1" ]; then
  printf '\n'
  "$prefix/$binary" init
fi

printf '\nTry it:\n'
printf '    %s add "buy milk"\n' "$binary"
printf '    %s project add "Kitchen remodel" --sequential\n' "$binary"
printf '    %s add "measure the counters" --project "Kitchen remodel"\n' "$binary"
printf '    %s ls\n' "$binary"
printf '    %s ls --tree --all\n' "$binary"
printf '\nWhere things are:   %s config\n' "$binary"
printf 'What is wrong:      %s doctor\n' "$binary"
printf 'Everything else:    %s --help\n' "$binary"
