/**
 * Risk checks – abort conditions before broadcasting transactions.
 */

import { BotConfig } from "./config";
import { getLogger } from "./logger";

export interface GasEstimate {
  computationCost: bigint;
  storageCost: bigint;
  storageRebate: bigint;
}

/**
 * Throws if estimated gas exceeds the configured budget.
 */
export function checkGasBudget(
  estimate: GasEstimate,
  config: Pick<BotConfig, "gasBudget">
): void {
  const total = estimate.computationCost + estimate.storageCost - estimate.storageRebate;
  if (total > config.gasBudget) {
    throw new Error(
      `Gas estimate ${total} exceeds budget ${config.gasBudget}. Aborting.`
    );
  }
  getLogger().info({ gasEstimate: String(total), gasBudget: String(config.gasBudget) }, "Gas check passed");
}

/**
 * Check that we are not in a concurrent rebalance.
 */
export function checkConcurrency(lockPath: string): void {
  const fs = require("fs") as typeof import("fs");
  if (fs.existsSync(lockPath)) {
    const content = fs.readFileSync(lockPath, "utf8").trim();
    const pid = parseInt(content);
    if (!isNaN(pid) && pid !== process.pid) {
      // Check if that PID is still running
      try {
        process.kill(pid, 0); // signal 0 = check existence
        throw new Error(`Another rebalance process is running (PID ${pid}). Lock file: ${lockPath}`);
      } catch (e: unknown) {
        if (e instanceof Error && (e as NodeJS.ErrnoException).code === "ESRCH") {
          // Process gone – stale lock, remove it
          fs.unlinkSync(lockPath);
          getLogger().warn({ lockPath }, "Removed stale lock file");
        } else {
          throw e;
        }
      }
    }
  }
}

/**
 * Acquire a lock file.
 */
export function acquireLock(lockPath: string): void {
  const fs = require("fs") as typeof import("fs");
  checkConcurrency(lockPath);
  fs.writeFileSync(lockPath, String(process.pid), "utf8");
}

/**
 * Release a lock file.
 */
export function releaseLock(lockPath: string): void {
  const fs = require("fs") as typeof import("fs");
  if (fs.existsSync(lockPath)) {
    fs.unlinkSync(lockPath);
  }
}

/**
 * Validate that the wallet address is set and looks like a Sui address.
 */
export function validateWalletAddress(address: string): void {
  if (!address || !address.startsWith("0x") || address.length < 10) {
    throw new Error(`Invalid wallet address: "${address}"`);
  }
}

/**
 * Validate pool and position IDs.
 */
export function validateIds(poolId: string, positionId?: string): void {
  if (!poolId || !poolId.startsWith("0x")) {
    throw new Error(`Invalid pool ID: "${poolId}"`);
  }
  if (positionId && !positionId.startsWith("0x")) {
    throw new Error(`Invalid position ID: "${positionId}"`);
  }
}
