#!/usr/bin/env bash
# Deploys bob with the secrets in .dev.vars (or the file given), after checking
# which Cloudflare login wrangler is using. A new Worker cannot have secrets set
# before its first deploy, so they go with the deploy; on an existing Worker
# they are added and the ones left out stay as they are.
#
#   scripts/push-secrets.sh [--with-discord] [file]
#
# DISCORD_TOKEN is left out unless --with-discord is given: with it, the cron
# opens the gateway within five minutes, and a second bot on the same token
# answers every mention twice.
set -euo pipefail
cd "$(dirname "$0")/.."

EXPECTED="${CLOUDFLARE_EMAIL:-admin@ranqia.com}"
SECRETS=(
  GITHUB_APP_ID GITHUB_APP_PRIVATE_KEY GITHUB_WEBHOOK_SECRET OPENAI_API_KEY
  DISCORD_PUBLIC_KEY DISCORD_APPLICATION_ID DISCORD_GUILD_ID
  SLACK_BOT_TOKEN SLACK_SIGNING_SECRET LINEAR_API_KEY SAURON_TOKEN
)

file=.dev.vars
for arg in "$@"; do
  case "$arg" in
    --with-discord) SECRETS+=(DISCORD_TOKEN) ;;
    -*) echo "unknown flag $arg" >&2; exit 2 ;;
    *) file="$arg" ;;
  esac
done
[ -f "$file" ] || { echo "$file not found" >&2; exit 1; }

whoami=$(bunx wrangler whoami 2>&1)
if ! grep -q "associated with the email $EXPECTED" <<<"$whoami"; then
  echo "wrangler is not logged in as $EXPECTED. Run: bunx wrangler login" >&2
  grep -i "associated with the email" <<<"$whoami" >&2 || true
  exit 1
fi

umask 077
selected=$(mktemp)
trap 'rm -f "$selected"' EXIT
pattern="^($(IFS='|'; echo "${SECRETS[*]}"))="
# One KEY=value per line, empty values dropped.
grep -E "$pattern" "$file" | grep -vE '^[A-Z_]+=("")?$' >"$selected" || true

for required in GITHUB_APP_ID GITHUB_APP_PRIVATE_KEY GITHUB_WEBHOOK_SECRET; do
  grep -q "^$required=" "$selected" || { echo "$file has no $required" >&2; exit 1; }
done

echo "Account: $(grep -oE '│ [^│]+ │ [0-9a-f]{32} │' <<<"$whoami" | head -1)"
echo "Secrets to send (values not shown):"
cut -d= -f1 "$selected" | sed 's/^/  /'
read -r -p "Deploy bob with these? [y/N] " answer
[ "$answer" = y ] || { echo "Nothing sent."; exit 0; }

bunx wrangler deploy --secrets-file "$selected"
