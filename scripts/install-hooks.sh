#!/usr/bin/env bash
# Install the repository's git hooks. Run once after cloning: `make hooks`.
set -euo pipefail
repo_root="$(git rev-parse --show-toplevel)"
hook="$repo_root/.git/hooks/pre-commit"

cat > "$hook" <<'INNER'
#!/usr/bin/env bash
# todocloud pre-commit hook: block credentials, keep the tree formatted.
set -euo pipefail
repo_root="$(git rev-parse --show-toplevel)"

"$repo_root/scripts/scan-secrets.sh" --staged

if command -v gofmt >/dev/null 2>&1; then
  unformatted=$(git diff --cached --name-only --diff-filter=ACMR -- '*.go' \
    | xargs -r gofmt -l)
  if [ -n "$unformatted" ]; then
    printf 'gofmt needed:\n%s\n' "$unformatted" >&2
    exit 1
  fi
fi
INNER

chmod +x "$hook"
echo "installed $hook"
