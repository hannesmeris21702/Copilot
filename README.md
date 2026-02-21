# cetus-liquidity-rebalance-bot

A production-ready automated liquidity rebalance bot for [Cetus CLMM](https://www.cetus.zone/) positions on the [Sui](https://sui.io/) network.

## Overview

The bot monitors a Cetus Concentrated Liquidity Market Maker (CLMM) position and automatically rebalances liquidity when:
- The current price moves **outside** the configured tick range, or
- The price **drifts** more than a threshold percentage from the center of the current range.

When a rebalance is triggered the bot:
1. Collects any outstanding fees.
2. Removes all liquidity from the position.
3. Optionally swaps tokens to restore the target ratio.
4. Adds liquidity back at a new tick range centered around the current price.

**Default mode is `DRY_RUN=true`** – the bot simulates all decisions and prints intended transactions without broadcasting anything.

---

## Repository Structure

```
cetus-liquidity-rebalance-bot/
├── src/
│   ├── index.ts          # Bot loop entry point
│   ├── config.ts         # Config loading (.env + config.yaml)
│   ├── logger.ts         # Structured JSON logger (pino)
│   ├── utils.ts          # Tick math, sleep, backoff helpers
│   ├── strategy.ts       # Pure decision/strategy module
│   ├── riskChecks.ts     # Safety checks (gas, concurrency, validation)
│   ├── persistence.ts    # JSON state file for crash recovery
│   ├── notifications.ts  # Telegram / generic webhook alerts
│   ├── cetusClient.ts    # Cetus CLMM SDK wrapper
│   └── suiWallet.ts      # Sui wallet / signing
├── config/
│   ├── config.example.yaml   # Example config (copy to config.yaml)
│   └── .env.example          # Example env vars (copy to .env)
├── scripts/
│   ├── setup.sh          # One-time setup
│   └── run.sh            # Run the bot
├── tests/
│   ├── tickMath.test.ts  # Unit tests for tick/price math
│   └── strategy.test.ts  # Unit tests for strategy decision logic
├── package.json
├── tsconfig.json
└── README.md
```

---

## Prerequisites

- **Node.js ≥ 20** (`node --version`)
- **npm ≥ 9**
- A Sui wallet with:
  - A 24-word mnemonic **or** a Sui CLI keystore file
  - SUI tokens for gas
  - Token A and Token B for the pool you want to manage

---

## Installation

```bash
# 1. Clone / download the repository
git clone <repo-url>
cd cetus-liquidity-rebalance-bot

# 2. Run the setup script (installs deps, copies example config)
chmod +x scripts/setup.sh
./scripts/setup.sh
```

Or manually:

```bash
npm install
npm run build
cp config/config.example.yaml config/config.yaml
cp config/.env.example .env
```

---

## Configuration

### 1. `.env` (secrets – never commit)

```bash
SUI_RPC_URL=https://fullnode.mainnet.sui.io:443
MNEMONIC="word1 word2 ... word24"
WALLET_ADDRESS=0xYourAddress
POOL_ID=0xPoolObjectId
TOKEN_A_TYPE=0x2::sui::SUI
TOKEN_B_TYPE=0x...::coin::COIN
DRY_RUN=true
CONFIRM=false
```

### 2. `config/config.yaml` (strategy settings)

```yaml
rebalanceMode: "price_band"
priceBandPct: 1.5       # ±1.5% band around current price
driftTriggerPct: 0.5    # rebalance if drifts >0.5% from center
minIntervalSeconds: 60
slippageBps: 50         # 0.5% slippage
gasBudget: 500000000    # 0.5 SUI
dryRun: true
confirm: false
logLevel: info
```

All config values can also be set as environment variables (env vars take precedence).

---

## Running

### Dry-run (simulate only, safe)

```bash
./scripts/run.sh --dry-run
```

### Live mode (broadcasts real transactions)

```bash
# Set in .env first:
DRY_RUN=false
CONFIRM=true

./scripts/run.sh --live --confirm
```

### With npm

```bash
# Build and run
npm run build
DRY_RUN=true node dist/index.js

# Development (no build step)
npm run dev
```

---

## Tests

```bash
# Run all tests
npm test

# With coverage
npm run test:coverage
```

Tests cover:
- Tick ↔ price conversion math
- `computeNewTickRange` with various price bands and tick spacings
- Strategy decision engine (rebalance triggers, drift thresholds)
- Swap computation logic

---

## How It Works

### Tick Math

Cetus CLMM uses Uniswap v3-style concentrated liquidity:

```
price = 1.0001 ^ tick
tick  = floor( log(price) / log(1.0001) )
```

Tick ranges must be multiples of `tickSpacing` (pool-dependent, e.g. 10, 60, 200).

### Strategy Modes

| Mode | Trigger |
|------|---------|
| `price_band` | Rebalance when current tick exits `[tickLower, tickUpper]` |
| `drift` | Rebalance when price drifts >N% from range center |

Both triggers are always active; the first to fire wins.

### Rebalance Flow

```
Poll price (every MIN_INTERVAL_SECONDS)
  └─ fetchPoolState()  ← Cetus CLMM RPC
  └─ fetchPositionState()
  └─ evaluateStrategy()
       ├─ No trigger → sleep
       └─ Trigger →
            collectFees()
            removeLiquidity()
            computeSwapNeeded() → swap() if needed
            addLiquidity(newTickLower, newTickUpper)
            persistState()
            sendNotification()
```

### Safety Features

- **Dry-run by default** – must opt into live mode with `CONFIRM=true`.
- **Gas budget check** – aborts if estimated gas exceeds `gasBudget`.
- **Lock file** – prevents concurrent rebalance runs.
- **Exponential backoff** – retries failed transactions up to `MAX_RETRIES`.
- **State persistence** – survives restarts without double-rebalancing.

---

## Finding Cetus & Sui Package IDs

### Mainnet Pool IDs

Use the [Cetus app](https://app.cetus.zone/) to find a pool. Click on a pool and copy the pool object ID from the URL or the pool details page.

Alternatively, query via Sui RPC:

```bash
# Example: find SUI/USDC pool
curl https://fullnode.mainnet.sui.io:443 \
  -H 'Content-Type: application/json' \
  -d '{
    "jsonrpc":"2.0","id":1,"method":"suix_getOwnedObjects",
    "params":["<CETUS_GLOBAL_CONFIG_ADDRESS>",{"filter":{"StructType":"<POOL_TYPE>"}},null,null]
  }'
```

The Cetus SDK automatically resolves its own package IDs from the official registry. You only need to override `cetusPackageIds` in config if you are connecting to a fork or private deployment.

### Testnet

Set `SUI_RPC_URL=https://fullnode.testnet.sui.io:443` and use testnet pool IDs from [Cetus testnet app](https://testnet.app.cetus.zone/).

---

## Observability

### Logs

Structured JSON logs via [pino](https://getpino.io/). Set `LOG_LEVEL` to `debug`, `info`, `warn`, or `error`.

Pretty-print in development:
```bash
node dist/index.js | npx pino-pretty
```

### Telegram Notifications

Set `TELEGRAM_WEBHOOK` to receive alerts:

```
https://api.telegram.org/bot<BOT_TOKEN>/sendMessage?chat_id=<CHAT_ID>
```

The bot sends messages on:
- 🔄 Rebalance triggered
- ✅ Rebalance success (with Suiscan TX link)
- ❌ Error

---

## Risks & Disclaimer

> **This software is provided as-is for educational and automation purposes. Use at your own risk. Always test on testnet first.**

Key risks:
1. **Smart contract risk** – Cetus contracts may have vulnerabilities.
2. **Price manipulation** – CLMM prices can be manipulated within a block.
3. **Gas cost** – Frequent rebalances on volatile assets may consume significant SUI in gas.
4. **Impermanent loss** – Concentrated liquidity amplifies impermanent loss.
5. **Slippage** – Large rebalances may execute at worse prices than expected.
6. **RPC failures** – Stale price data may delay or misfire rebalance decisions.

**Recommended settings for new users:**
- Start with `DRY_RUN=true` for at least 24 hours.
- Set `priceBandPct` ≥ 1.5% to avoid excessive churn.
- Set `minIntervalSeconds` ≥ 300 (5 minutes) to reduce gas costs.
- Monitor via Telegram notifications.

---

## License

MIT
