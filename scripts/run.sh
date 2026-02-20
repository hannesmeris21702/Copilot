#!/usr/bin/env bash
# run.sh – start the rebalance bot
set -euo pipefail

DRY_RUN="${DRY_RUN:-true}"
CONFIRM="${CONFIRM:-false}"

# Parse flags
for arg in "$@"; do
  case $arg in
    --dry-run)
      DRY_RUN=true
      ;;
    --live)
      DRY_RUN=false
      ;;
    --confirm)
      CONFIRM=true
      ;;
    *)
      echo "Unknown argument: $arg"
      echo "Usage: $0 [--dry-run] [--live] [--confirm]"
      exit 1
      ;;
  esac
done

export DRY_RUN
export CONFIRM

if [ "$DRY_RUN" = "true" ]; then
  echo "==> Starting bot in DRY-RUN mode (no transactions will be broadcast)"
else
  if [ "$CONFIRM" != "true" ]; then
    echo "ERROR: Live mode requires --confirm flag or CONFIRM=true env var."
    exit 1
  fi
  echo "==> Starting bot in LIVE mode"
  echo "    WARNING: Real transactions will be broadcast!"
fi

echo ""

# Load .env if present
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

# Build if dist doesn't exist
if [ ! -f dist/index.js ]; then
  echo "==> Building..."
  npm run build
fi

node dist/index.js
