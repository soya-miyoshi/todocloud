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

# A staged TypeScript change that does not type-check is not ready to commit.
# Skipped when the dependencies are not installed, so a fresh clone can still
# commit before its first `npm ci`.
if git diff --cached --name-only --diff-filter=ACMR -- '*.ts' | grep -q . \
  && [ -d "$repo_root/node_modules/typescript" ]; then
  if ! (cd "$repo_root" && npx --no-install tsc --noEmit -p tsconfig.json); then
    printf 'tsc reported errors; fix them or commit without --no-verify at your peril.\n' >&2
    exit 1
  fi
fi
INNER

chmod +x "$hook"
echo "installed $hook"
