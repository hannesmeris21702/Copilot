/**
 * Sui wallet / signing utilities.
 *
 * Supports two modes:
 *  1. KEYSTORE_PATH: read a Sui keystore JSON file (array of Base64 keypairs)
 *  2. MNEMONIC: derive keypair from 24-word mnemonic (BIP39 / Ed25519)
 */

import * as fs from "fs";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { BotConfig } from "./config";
import { getLogger } from "./logger";

export interface WalletContext {
  keypair: Ed25519Keypair;
  address: string;
  client: SuiClient;
}

/**
 * Initialise the Sui client and load the keypair.
 */
export function initWallet(config: BotConfig): WalletContext {
  const client = new SuiClient({ url: config.suiRpcUrl });

  let keypair: Ed25519Keypair;

  if (config.mnemonic) {
    keypair = Ed25519Keypair.deriveKeypair(config.mnemonic);
    getLogger().info("Loaded keypair from mnemonic");
  } else if (config.keystorePath) {
    keypair = loadFromKeystore(config.keystorePath);
    getLogger().info({ keystorePath: config.keystorePath }, "Loaded keypair from keystore");
  } else {
    // No signing keys – read-only / dry-run mode
    getLogger().warn("No MNEMONIC or KEYSTORE_PATH provided. Running in read-only mode.");
    keypair = new Ed25519Keypair(); // ephemeral
  }

  const address = config.walletAddress || keypair.getPublicKey().toSuiAddress();

  return { keypair, address, client };
}

/**
 * Load the first key from a Sui CLI keystore file.
 * The keystore is a JSON array of Base64-encoded 33-byte items:
 *   byte[0] = flag (0 = Ed25519)
 *   bytes[1..32] = private key
 */
function loadFromKeystore(keystorePath: string): Ed25519Keypair {
  const raw = fs.readFileSync(keystorePath, "utf8");
  const keys: string[] = JSON.parse(raw);
  if (keys.length === 0) throw new Error("Keystore is empty");

  const bytes = Buffer.from(keys[0], "base64");
  // Skip flag byte
  const privateKey = bytes.slice(1, 33);
  return Ed25519Keypair.fromSecretKey(privateKey);
}

/**
 * Execute a transaction block with retry + gas check.
 * In dry-run mode, dryRunTransactionBlock is called instead.
 */
export async function executeTransaction(
  ctx: WalletContext,
  tx: Transaction,
  config: Pick<BotConfig, "gasBudget" | "dryRun" | "confirm" | "maxRetries">
): Promise<{ digest: string; dryRun: boolean }> {
  const log = getLogger();

  // Set gas budget
  tx.setGasBudget(config.gasBudget);

  if (config.dryRun) {
    const bytes = await tx.build({ client: ctx.client });
    const result = await ctx.client.dryRunTransactionBlock({ transactionBlock: bytes });
    log.info({ status: result.effects.status }, "[DRY-RUN] Transaction simulated");
    return { digest: "dry-run", dryRun: true };
  }

  if (!config.confirm) {
    log.warn("Live mode requires CONFIRM=true. Aborting transaction.");
    return { digest: "aborted-no-confirm", dryRun: false };
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      const result = await ctx.client.signAndExecuteTransaction({
        signer: ctx.keypair,
        transaction: tx,
        options: {
          showEffects: true,
          showEvents: true,
        },
      });

      if (result.effects?.status?.status !== "success") {
        throw new Error(
          `Transaction failed: ${result.effects?.status?.error || "unknown"}`
        );
      }

      log.info({ digest: result.digest }, "Transaction executed successfully");
      return { digest: result.digest, dryRun: false };
    } catch (err) {
      lastErr = err;
      const { backoffMs, sleep } = await import("./utils");
      const delay = backoffMs(attempt);
      log.warn({ err, attempt, delay }, "Transaction attempt failed – retrying");
      await sleep(delay);
    }
  }

  throw lastErr;
}
