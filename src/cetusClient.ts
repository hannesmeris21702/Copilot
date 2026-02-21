/**
 * Cetus CLMM client wrapper.
 *
 * Provides read/write abstractions over the Cetus SDK and Sui RPC.
 *
 * The Cetus SDK (@cetusprotocol/cetus-sui-clmm-sdk) exposes:
 *   - CetusClmmSDK – main entry point
 *   - Pool, Position objects
 *   - Transaction builders for add/remove/collect/swap
 *
 * This module wraps those calls and provides a clean interface
 * consumed by the bot loop and strategy module.
 */

import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { BotConfig } from "./config";
import { PoolState, PositionState } from "./strategy";
import { getLogger } from "./logger";
import { tickToPrice } from "./utils";

// ──────────────────────────────────────────────────────────────────
// Cetus SDK type stubs – the SDK exports these but the exact shapes
// depend on the installed version.  We use a light wrapper so the
// bot compiles even when the SDK is not yet installed (CI/test env).
// ──────────────────────────────────────────────────────────────────

interface CetusPool {
  poolAddress: string;
  coinTypeA: string;
  coinTypeB: string;
  current_tick_index: number;   // signed integer
  current_sqrt_price: string;   // u128 as string
  tick_spacing: number;
  liquidity: string;
  fee_rate: number;
}

interface CetusPosition {
  pos_object_id: string;
  tick_lower_index: number;
  tick_upper_index: number;
  liquidity: string;
  fee_owed_a: string;
  fee_owed_b: string;
}

// Dynamic import so tests can mock the module without installing the SDK.
async function getCetusSDK(config: BotConfig) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { CetusClmmSDK, SdkOptions } = require("@cetusprotocol/cetus-sui-clmm-sdk");

  const isMainnet = !config.suiRpcUrl.includes("testnet") &&
    !config.suiRpcUrl.includes("devnet");

  const sdkOptions: Record<string, unknown> = {
    fullRpcUrl: config.suiRpcUrl,
    simulationAccount: { address: config.walletAddress },
  };

  // Allow overriding package IDs from config
  if (config.cetusPackageIds) {
    Object.assign(sdkOptions, config.cetusPackageIds);
  }

  const sdk = new CetusClmmSDK(sdkOptions);
  return sdk;
}

// ──────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────

export class CetusClient {
  private config: BotConfig;
  private suiClient: SuiClient;

  constructor(config: BotConfig, suiClient: SuiClient) {
    this.config = config;
    this.suiClient = suiClient;
  }

  /**
   * Fetch the on-chain pool state.
   */
  async fetchPoolState(): Promise<PoolState> {
    const log = getLogger();
    log.debug({ poolId: this.config.poolId }, "Fetching pool state");

    const sdk = await getCetusSDK(this.config);
    const pool: CetusPool = await sdk.Pool.getPool(this.config.poolId);

    const currentTick = pool.current_tick_index;
    const sqrtPrice = BigInt(pool.current_sqrt_price);

    // Compute decimal price from sqrt price (Q64.64 fixed point)
    // price = (sqrtPrice / 2^64)^2
    const TWO64 = BigInt(2) ** BigInt(64);
    const sqrtPriceFloat = Number(sqrtPrice) / Number(TWO64);
    const currentPrice = sqrtPriceFloat * sqrtPriceFloat;

    log.debug({ currentTick, currentPrice, tickSpacing: pool.tick_spacing }, "Pool state fetched");

    return {
      currentTick,
      currentPrice,
      tickSpacing: pool.tick_spacing,
      sqrtPrice,
    };
  }

  /**
   * Fetch the current position state.
   * If positionId is configured, fetch that specific position.
   * Otherwise fetch the first open position in the pool owned by walletAddress.
   */
  async fetchPositionState(): Promise<PositionState & { positionId: string }> {
    const log = getLogger();
    const sdk = await getCetusSDK(this.config);

    let positionId = this.config.positionId;

    if (!positionId) {
      // Discover positions owned by wallet for this pool
      const positions: CetusPosition[] = await sdk.Position.getPositionList(
        this.config.walletAddress,
        [this.config.poolId]
      );
      if (positions.length === 0) {
        throw new Error(
          `No open positions found for wallet ${this.config.walletAddress} in pool ${this.config.poolId}`
        );
      }
      positionId = positions[0].pos_object_id;
      log.info({ positionId }, "Auto-discovered position");
    }

    const pos: CetusPosition = await sdk.Position.getPosition(positionId);

    return {
      positionId,
      tickLower: pos.tick_lower_index,
      tickUpper: pos.tick_upper_index,
      liquidity: BigInt(pos.liquidity),
      unclaimedFeeA: BigInt(pos.fee_owed_a),
      unclaimedFeeB: BigInt(pos.fee_owed_b),
    };
  }

  /**
   * Build a transaction to collect fees from a position.
   */
  async buildCollectFeeTx(positionId: string): Promise<Transaction> {
    const sdk = await getCetusSDK(this.config);
    const tx = new Transaction();
    await sdk.Rewarder.collectFeePayload(
      tx,
      {
        pool_id: this.config.poolId,
        pos_id: positionId,
        collect_fee: true,
      }
    );
    return tx;
  }

  /**
   * Build a transaction to remove all liquidity from a position.
   */
  async buildRemoveLiquidityTx(
    positionId: string,
    liquidity: bigint,
    slippageBps: number
  ): Promise<Transaction> {
    const sdk = await getCetusSDK(this.config);
    const tx = new Transaction();
    const slippage = slippageBps / 10000;

    await sdk.Position.removeLiquidityPayload(
      tx,
      {
        pool_id: this.config.poolId,
        pos_id: positionId,
        liquidity: liquidity.toString(),
        min_amount_a: "0",
        min_amount_b: "0",
        collect_fee: false,
      },
      slippage
    );
    return tx;
  }

  /**
   * Build a transaction to add liquidity to a position.
   */
  async buildAddLiquidityTx(
    positionId: string,
    tickLower: number,
    tickUpper: number,
    amountA: bigint,
    amountB: bigint,
    slippageBps: number
  ): Promise<Transaction> {
    const sdk = await getCetusSDK(this.config);
    const tx = new Transaction();
    const slippage = slippageBps / 10000;

    await sdk.Position.addLiquidityFixTokenPayload(
      tx,
      {
        pool_id: this.config.poolId,
        coin_type_a: this.config.tokenAType,
        coin_type_b: this.config.tokenBType,
        tick_lower: tickLower,
        tick_upper: tickUpper,
        amount_a: amountA.toString(),
        amount_b: amountB.toString(),
        is_open: !this.config.positionId, // open new if no existing positionId
        pos_id: positionId,
        fix_amount_a: true,
        slippage,
      }
    );
    return tx;
  }

  /**
   * Build a swap transaction via Cetus router.
   * swapAtoB = true → spend tokenA, receive tokenB.
   */
  async buildSwapTx(
    swapAtoB: boolean,
    amount: bigint,
    slippageBps: number
  ): Promise<Transaction> {
    const sdk = await getCetusSDK(this.config);
    const tx = new Transaction();
    const slippage = slippageBps / 10000;

    await sdk.Swap.swapPayload(
      tx,
      {
        pool_id: this.config.poolId,
        a2b: swapAtoB,
        by_amount_in: true,
        amount: amount.toString(),
        amount_limit: "0",
        coin_type_a: this.config.tokenAType,
        coin_type_b: this.config.tokenBType,
      },
      slippage
    );
    return tx;
  }

  /**
   * Get token balances for the wallet.
   */
  async getTokenBalances(): Promise<{ balanceA: bigint; balanceB: bigint }> {
    const [a, b] = await Promise.all([
      this.suiClient.getBalance({
        owner: this.config.walletAddress,
        coinType: this.config.tokenAType,
      }),
      this.suiClient.getBalance({
        owner: this.config.walletAddress,
        coinType: this.config.tokenBType,
      }),
    ]);
    return {
      balanceA: BigInt(a.totalBalance),
      balanceB: BigInt(b.totalBalance),
    };
  }
}
