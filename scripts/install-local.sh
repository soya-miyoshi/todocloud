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

# This repository pins node and bun with mise. Prefer the ones already on
# PATH — if you have them, they are the ones you meant — and otherwise ask
# mise. The shim directory is not hardcoded: it moves with XDG_DATA_HOME, so
# guessing the path is how this breaks on a machine that is not the author's.
#
# node runs the build script; bun compiles the executable. Say which one is
# missing here rather than let the build fail further in.
for tool in node bun; do
  if ! command -v "$tool" >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then
    if found="$(cd "$repo_root" && mise which "$tool" 2>/dev/null)" && [ -x "$found" ]; then
      PATH="$(dirname "$found"):$PATH"
      export PATH
    fi
  fi
  command -v "$tool" >/dev/null 2>&1 || {
    printf '%s is not on PATH. Install it, or run `mise install` in %s.\n' \
      "$tool" "$repo_root" >&2
    exit 1
  }
done

# A dirty tree is worth saying out loud: the binary you are about to install
# does not correspond to any commit.
version="$(git -C "$repo_root" describe --tags --always --dirty 2>/dev/null || echo "dev")"
commit="$(git -C "$repo_root" rev-parse --short HEAD 2>/dev/null || echo "")"

printf 'Building %s %s\n' "$binary" "$version"
mkdir -p "$prefix"

# `tdo version` reads the version out of the manifest embedded in the
# executable, so the only way to stamp it is to put it there before the build.
# An earlier version of this script exported TODOCLOUD_VERSION for the build
# process, which did nothing at all: that variable is read at run time, by
# whoever runs the installed binary, not at build time.
#
# The manifests are tracked files, so they are restored afterwards — through a
# trap, so an interrupted build does not leave the tree dirty. Copies rather
# than `git checkout` because the latter would also discard any edit you had
# in progress there.
manifests=()
for pkg in core cli store-sqlite store-turso; do
  manifests+=("$repo_root/packages/$pkg/package.json")
done
backup="$(mktemp -d)"
restore() {
  local f
  for f in "${manifests[@]}"; do
    [ -f "$backup/$(basename "$(dirname "$f")").json" ] &&
      cp "$backup/$(basename "$(dirname "$f")").json" "$f"
  done
  rm -rf "$backup"
}
trap restore EXIT
for f in "${manifests[@]}"; do
  cp "$f" "$backup/$(basename "$(dirname "$f")").json"
done

# `git describe` gives things like 0.1.0-rc.2-2-g5058515, which is a valid
# semver prerelease, so set-version accepts it as is. With no tags in the
# repository it gives a bare SHA instead, which is not semver and which
# set-version rightly refuses — so that case becomes an obviously-not-a-release
# version that still carries the SHA.
stamp="${version#v}"
case "$stamp" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) stamp="0.0.0-$(printf '%s' "$stamp" | tr -c '[:alnum:].-' '-')" ;;
esac
node "$repo_root/scripts/set-version.mjs" "$stamp" >/dev/null

# --no-smoke: the smoke test runs the binary against a throwaway store, which
# is worth it in a build but is not what the user asked this script for.
# dist-bin is cleared first, and the binary is taken from the versioned
# directory the build just wrote rather than from the `dist-bin/tdo`
# convenience symlink. The symlink survives across builds, so installing
# through it once installed a stale binary from an earlier version while the
# freshly stamped one sat beside it.
rm -rf "$repo_root/dist-bin"
node "$repo_root/scripts/build-binary.mjs" --no-smoke
built="$repo_root/dist-bin/${binary}_${stamp}_$(uname -s | tr 'A-Z' 'a-z' |
  sed 's/^darwin$/darwin/;s/^linux$/linux/')_$(uname -m |
  sed 's/^x86_64$/amd64/;s/^aarch64$/arm64/;s/^arm64$/arm64/')/$binary"
[ -f "$built" ] || {
  printf 'the build did not produce %s\n' "$built" >&2
  printf 'what it produced:\n' >&2
  ls -1 "$repo_root/dist-bin" >&2
  exit 1
}
install -m 0755 "$built" "$prefix/$binary"

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
