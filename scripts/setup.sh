#!/usr/bin/env bash
# setup.sh – one-time setup for the cetus-liquidity-rebalance-bot
set -euo pipefail

echo "==> Checking Node.js version..."
NODE_VERSION=$(node --version | tr -d 'v' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  echo "ERROR: Node.js 20+ required (found $(node --version))"
  exit 1
fi
echo "    Node.js $(node --version) ✓"

echo "==> Installing dependencies..."
npm install

echo "==> Building TypeScript..."
npm run build

echo "==> Copying example config..."
if [ ! -f config/config.yaml ]; then
  cp config/config.example.yaml config/config.yaml
  echo "    Created config/config.yaml – please edit it."
fi

if [ ! -f .env ]; then
  cp config/.env.example .env
  echo "    Created .env – please fill in your secrets."
fi

echo ""
echo "✅  Setup complete!"
echo ""
echo "Next steps:"
echo "  1. Edit config/config.yaml with your pool ID and strategy settings."
echo "  2. Edit .env with your wallet mnemonic/keystore and RPC URL."
echo "  3. Run './scripts/run.sh --dry-run' to test without broadcasting transactions."
echo "  4. Run './scripts/run.sh' to start the bot in live mode (requires CONFIRM=true)."
