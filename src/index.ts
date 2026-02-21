/**
 * Main bot entry point.
 *
 * Orchestrates:
 *  1. Config loading
 *  2. Wallet init
 *  3. Price polling loop
 *  4. Strategy evaluation
 *  5. Rebalance execution (or dry-run simulation)
 *  6. Persistence, locking, notifications
 */

import { loadConfig } from "./config";
import { createLogger, getLogger } from "./logger";
import { initWallet, executeTransaction } from "./suiWallet";
import { CetusClient } from "./cetusClient";
import { evaluateStrategy, computeSwapNeeded, computeTokenAmounts } from "./strategy";
import { loadState, saveState, updateStateAfterRebalance } from "./persistence";
import { validateWalletAddress, validateIds, acquireLock, releaseLock } from "./riskChecks";
import { notify } from "./notifications";
import { sleep, backoffMs } from "./utils";
import * as path from "path";

const LOCK_FILE = path.resolve(process.cwd(), "bot.lock");
const STATE_FILE = path.resolve(process.cwd(), "state.json");

async function runRebalance(
  cetusClient: CetusClient,
  wallet: ReturnType<typeof initWallet>,
  config: ReturnType<typeof loadConfig>,
  positionId: string,
  tickLower: number,
  tickUpper: number,
  newTickLower: number,
  newTickUpper: number,
  liquidity: bigint
): Promise<string> {
  const log = getLogger();

  // 1. Collect fees
  log.info({ positionId }, "Building collect-fee transaction");
  const collectTx = await cetusClient.buildCollectFeeTx(positionId);
  const collectResult = await executeTransaction(wallet, collectTx, config);
  log.info({ digest: collectResult.digest }, "Fees collected");

  // 2. Remove liquidity
  log.info({ positionId, liquidity: liquidity.toString() }, "Building remove-liquidity transaction");
  const removeTx = await cetusClient.buildRemoveLiquidityTx(positionId, liquidity, config.slippageBps);
  const removeResult = await executeTransaction(wallet, removeTx, config);
  log.info({ digest: removeResult.digest }, "Liquidity removed");

  // 3. Check if swap is needed
  const poolState = await cetusClient.fetchPoolState();
  const { balanceA, balanceB } = await cetusClient.getTokenBalances();

  const { amountA: targetA, amountB: targetB } = computeTokenAmounts(
    liquidity,
    poolState.currentPrice,
    newTickLower,
    newTickUpper
  );

  const targetRatio = targetB > 0 ? targetA / targetB : 1;
  const swapInfo = computeSwapNeeded(balanceA, balanceB, targetRatio, poolState.currentPrice, config.slippageBps);

  let lastDigest = removeResult.digest;

  if (swapInfo) {
    log.info(
      { swapAtoB: swapInfo.swapAtoB, amount: swapInfo.swapAmount.toString() },
      "Swap needed to reach target ratio"
    );
    const swapTx = await cetusClient.buildSwapTx(swapInfo.swapAtoB, swapInfo.swapAmount, config.slippageBps);
    const swapResult = await executeTransaction(wallet, swapTx, config);
    log.info({ digest: swapResult.digest }, "Swap executed");
    lastDigest = swapResult.digest;
  } else {
    log.info("No swap needed – token ratio is close to target");
  }

  // 4. Add liquidity at new range
  const { balanceA: newBalA, balanceB: newBalB } = await cetusClient.getTokenBalances();
  log.info(
    { newTickLower, newTickUpper, balanceA: newBalA.toString(), balanceB: newBalB.toString() },
    "Building add-liquidity transaction"
  );
  const addTx = await cetusClient.buildAddLiquidityTx(
    positionId,
    newTickLower,
    newTickUpper,
    newBalA,
    newBalB,
    config.slippageBps
  );
  const addResult = await executeTransaction(wallet, addTx, config);
  log.info({ digest: addResult.digest }, "Liquidity added at new range");

  return addResult.digest;
}

async function runLoop(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config);

  log.info({ dryRun: config.dryRun, confirm: config.confirm }, "Bot starting");

  // Validate config
  validateWalletAddress(config.walletAddress);
  validateIds(config.poolId, config.positionId);

  const wallet = initWallet(config);
  const cetusClient = new CetusClient(config, wallet.client);

  let state = loadState(STATE_FILE);
  log.info({ totalRebalances: state.totalRebalances }, "State loaded");

  // Acquire lock (prevents concurrent runs)
  acquireLock(LOCK_FILE);

  const handleShutdown = () => {
    releaseLock(LOCK_FILE);
    log.info("Lock released. Exiting.");
    process.exit(0);
  };
  process.on("SIGINT", handleShutdown);
  process.on("SIGTERM", handleShutdown);

  try {
    while (true) {
      const loopStart = Date.now();

      try {
        // Rate-limit by MIN_INTERVAL_SECONDS
        const elapsed = loopStart - (state.lastRebalanceTime || 0);
        const remaining = config.minIntervalSeconds * 1000 - elapsed;
        if (remaining > 0 && state.lastRebalanceTime) {
          log.debug({ remainingMs: remaining }, "Waiting for next interval");
          await sleep(remaining);
        }

        // Fetch pool + position state
        log.info("Fetching pool state...");
        const poolState = await cetusClient.fetchPoolState();
        log.info(
          { currentTick: poolState.currentTick, currentPrice: poolState.currentPrice },
          "Pool state"
        );

        const positionData = await cetusClient.fetchPositionState();
        const { positionId, ...position } = positionData;
        log.info(
          { positionId, tickLower: position.tickLower, tickUpper: position.tickUpper, liquidity: position.liquidity.toString() },
          "Position state"
        );

        // Evaluate strategy
        const decision = evaluateStrategy(poolState, position, config);
        log.info(
          { trigger: decision.trigger, drift: decision.currentDriftPct, shouldRebalance: decision.shouldRebalance },
          `Strategy: ${decision.details}`
        );

        if (decision.shouldRebalance && decision.newTickLower !== undefined && decision.newTickUpper !== undefined) {
          log.info({ trigger: decision.trigger }, "Rebalance triggered");

          await notify(config.telegramWebhook, {
            type: "rebalance_start",
            message: `Rebalance triggered: ${decision.trigger}\nDrift: ${decision.currentDriftPct.toFixed(2)}%\nNew range: [${decision.newTickLower}, ${decision.newTickUpper}]`,
            network: config.suiRpcUrl.includes("testnet") ? "testnet" : "mainnet",
          });

          if (config.dryRun) {
            log.info(
              {
                newTickLower: decision.newTickLower,
                newTickUpper: decision.newTickUpper,
                DRY_RUN: true,
              },
              "[DRY-RUN] Would rebalance – no transactions broadcast"
            );
          } else {
            const txDigest = await runRebalance(
              cetusClient,
              wallet,
              config,
              positionId,
              position.tickLower,
              position.tickUpper,
              decision.newTickLower,
              decision.newTickUpper,
              position.liquidity
            );

            state = updateStateAfterRebalance(
              state,
              positionId,
              decision.newTickLower,
              decision.newTickUpper,
              position.liquidity,
              txDigest
            );
            saveState(STATE_FILE, state);

            await notify(config.telegramWebhook, {
              type: "rebalance_success",
              message: `Rebalance complete! New range: [${decision.newTickLower}, ${decision.newTickUpper}]`,
              txDigest,
              network: config.suiRpcUrl.includes("testnet") ? "testnet" : "mainnet",
            });
          }
        }
      } catch (err) {
        log.error({ err }, "Error in bot loop");
        await notify(config.telegramWebhook, {
          type: "rebalance_failure",
          message: `Bot error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      // Sleep until next interval
      const elapsed = Date.now() - loopStart;
      const wait = Math.max(0, config.minIntervalSeconds * 1000 - elapsed);
      log.debug({ waitMs: wait }, "Sleeping until next poll");
      await sleep(wait);
    }
  } finally {
    releaseLock(LOCK_FILE);
  }
}

// Entrypoint
runLoop().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
