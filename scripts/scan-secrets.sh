#!/usr/bin/env bash
# Scan for credentials before they reach the repository.
#
#   scripts/scan-secrets.sh --staged   # staged changes only (pre-commit hook)
#   scripts/scan-secrets.sh --tree     # every tracked file (default)
#   scripts/scan-secrets.sh --history  # full git history (CI)
#
# Uses gitleaks when available, and otherwise falls back to a dependency-free
# pattern scan so the check still runs on a machine without it. Exits non-zero
# on any finding. See CLAUDE.md §1 and SECURITY.md.
set -euo pipefail

mode="${1:---tree}"
repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

red() { printf '\033[31m%s\033[0m\n' "$*" >&2; }
note() { printf '%s\n' "$*" >&2; }

# ---------------------------------------------------------------------------
# Layer 1: filenames that must never be tracked, whatever their contents.
# ---------------------------------------------------------------------------
forbidden_name='(^|/)(\.env($|\.)|\.dev\.vars|config\.toml|.*credentials?.*\.json|service[-_]account.*\.json|client_secret.*\.json|\.netrc|.*\.(pem|key|p12|pfx)$|id_rsa)'

case "$mode" in
  --staged)  files=$(git diff --cached --name-only --diff-filter=ACMR) ;;
  --tree)    files=$(git ls-files) ;;
  --history) files=$(git log --all --pretty=format: --name-only | sort -u | sed '/^$/d') ;;
  *) red "unknown mode: $mode"; exit 2 ;;
esac

name_hits=$(printf '%s\n' "$files" | grep -Ei "$forbidden_name" || true)
if [ -n "$name_hits" ]; then
  red "BLOCKED: these paths look like credential files and must not be in the repo:"
  printf '%s\n' "$name_hits" >&2
  note ""
  note "If this is a real credential file: move it out of the repository"
  note "(e.g. to ~/.config/todocloud/config.toml) and revoke the token if it was"
  note "ever committed or pushed. Do not bypass this with --no-verify."
  exit 1
fi

# ---------------------------------------------------------------------------
# Layer 2: content scan.
# ---------------------------------------------------------------------------
if command -v gitleaks >/dev/null 2>&1; then
  case "$mode" in
    --staged)  exec gitleaks protect --staged --redact --config .gitleaks.toml ;;
    --tree)    exec gitleaks detect --no-git --redact --config .gitleaks.toml ;;
    --history) exec gitleaks detect --redact --config .gitleaks.toml ;;
  esac
fi

note "gitleaks not installed; using the built-in pattern scan."
note "Install it for better coverage: brew install gitleaks"

# Patterns deliberately kept narrow enough to avoid false positives on prose.
patterns=(
  'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'  # JWT (Turso/libSQL token)
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'                             # any private key
  '"private_key"[[:space:]]*:'                                     # GCP service account JSON
  'AIza[0-9A-Za-z_-]{35}'                                          # Google API key
  'gh[pousr]_[A-Za-z0-9]{36}'                                      # GitHub token
  'sk-[A-Za-z0-9]{20,}'                                            # OpenAI-style key
  'sk-ant-[A-Za-z0-9_-]{20,}'                                      # Anthropic key
  '(TODOCLOUD_[A-Z_]*TOKEN|CLOUDFLARE_API_TOKEN|TURSO_AUTH_TOKEN)[[:space:]]*=[[:space:]]*["'"'"']?[A-Za-z0-9_.-]{20,}'
)
allow='TOKEN_GOES_HERE|example\.turso\.io|00000000-0000-0000-0000-000000000000|REDACTED|PLACEHOLDER|placeholder'

# Findings report the FILE only, never the matched text: this output can end up
# in a terminal transcript, a CI log or an AI assistant's context.
found=0
for f in $files; do
  if [ "$mode" = "--staged" ]; then
    content=$(git diff --cached -U0 -- "$f" | grep '^+' || true)
  else
    [ -f "$f" ] || continue
    content=$(cat "$f")
  fi
  [ -n "$content" ] || continue
  for p in "${patterns[@]}"; do
    if printf '%s\n' "$content" | grep -Ev "$allow" | grep -Eq -e "$p"; then
      found=1
      red "BLOCKED: $f contains something shaped like a credential"
      note "  pattern: /$p/   (the matched value is deliberately not printed)"
    fi
  done
done

if [ "$found" -ne 0 ]; then
  note ""
  note "Nothing in this repository needs a real credential: tests use local"
  note "SQLite and fake HTTP servers, and examples use obvious placeholders."
  note "If the credential is real, revoke it at the provider now — that, not"
  note "deleting the file, is what ends the exposure."
  note "If this is a false positive, add a narrow allowlist entry to"
  note ".gitleaks.toml and say why in the commit message."
  exit 1
fi

note "secret scan: clean ($mode)"
