/**
 * Strategy module – pure decision logic, no side effects.
 *
 * Decides whether to rebalance and computes target ranges.
 */

import { computeNewTickRange, driftPct, isTickInRange, priceToTick, tickToPrice } from "./utils";
import { BotConfig } from "./config";

export interface PositionState {
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  unclaimedFeeA: bigint;
  unclaimedFeeB: bigint;
}

export interface PoolState {
  currentTick: number;
  currentPrice: number;  // decimal price (tokenB/tokenA)
  tickSpacing: number;
  sqrtPrice: bigint;
}

export type RebalanceTrigger = "price_out_of_range" | "drift_exceeded" | "none";

export interface StrategyDecision {
  shouldRebalance: boolean;
  trigger: RebalanceTrigger;
  currentDriftPct: number;
  newTickLower?: number;
  newTickUpper?: number;
  details: string;
}

/**
 * Pure strategy evaluation.
 * Returns whether to rebalance and the new tick range to use.
 */
export function evaluateStrategy(
  pool: PoolState,
  position: PositionState,
  config: Pick<BotConfig, "rebalanceMode" | "priceBandPct" | "driftTriggerPct">
): StrategyDecision {
  const { currentTick, currentPrice, tickSpacing } = pool;
  const { tickLower, tickUpper } = position;

  const drift = driftPct(currentPrice, tickLower, tickUpper);
  const inRange = isTickInRange(currentTick, tickLower, tickUpper);

  // Trigger 1: price is completely outside the current range
  if (!inRange) {
    const { tickLower: newLower, tickUpper: newUpper } = computeNewTickRange(
      currentPrice,
      config.priceBandPct,
      tickSpacing
    );
    return {
      shouldRebalance: true,
      trigger: "price_out_of_range",
      currentDriftPct: drift,
      newTickLower: newLower,
      newTickUpper: newUpper,
      details: `Current tick ${currentTick} is outside [${tickLower}, ${tickUpper}]`,
    };
  }

  // Trigger 2: drift exceeds threshold
  if (Math.abs(drift) > config.driftTriggerPct) {
    const { tickLower: newLower, tickUpper: newUpper } = computeNewTickRange(
      currentPrice,
      config.priceBandPct,
      tickSpacing
    );
    return {
      shouldRebalance: true,
      trigger: "drift_exceeded",
      currentDriftPct: drift,
      newTickLower: newLower,
      newTickUpper: newUpper,
      details: `Drift ${drift.toFixed(2)}% exceeds threshold ${config.driftTriggerPct}%`,
    };
  }

  return {
    shouldRebalance: false,
    trigger: "none",
    currentDriftPct: drift,
    details: `In range. Drift: ${drift.toFixed(2)}%`,
  };
}

/**
 * Compute the token amounts required for a given liquidity in a tick range.
 * This is a simplified approximation; exact amounts require sqrt price math.
 *
 * Uses the Uniswap v3 formula:
 *   amount0 = liquidity * (sqrt(upper) - sqrt(current)) / (sqrt(upper) * sqrt(current))
 *   amount1 = liquidity * (sqrt(current) - sqrt(lower))
 *
 * Here we work in price space since we don't have full uint128 math.
 */
export function computeTokenAmounts(
  liquidity: bigint,
  currentPrice: number,
  tickLower: number,
  tickUpper: number
): { amountA: number; amountB: number } {
  const sqrtCurrent = Math.sqrt(currentPrice);
  const sqrtLower = Math.sqrt(tickToPrice(tickLower));
  const sqrtUpper = Math.sqrt(tickToPrice(tickUpper));

  const L = Number(liquidity);

  let amountA = 0;
  let amountB = 0;

  if (currentPrice <= tickToPrice(tickLower)) {
    // All tokenA
    amountA = L * (1 / sqrtLower - 1 / sqrtUpper);
  } else if (currentPrice >= tickToPrice(tickUpper)) {
    // All tokenB
    amountB = L * (sqrtUpper - sqrtLower);
  } else {
    amountA = L * (1 / sqrtCurrent - 1 / sqrtUpper);
    amountB = L * (sqrtCurrent - sqrtLower);
  }

  return { amountA, amountB };
}

/**
 * Determine if a swap is needed to reach target token ratio and in which direction.
 * Returns { swapAtoB: boolean, swapAmount: bigint } or null if no swap needed.
 *
 * Math:
 *   Let x = amount of tokenA to swap away.
 *   After swap: newA = bA - x,  newB = bB + x * price
 *   Target:     (bA - x) / (bB + x * price) = targetRatioAtoB
 *   Solving for x:
 *     x = (bA - targetRatioAtoB * bB) / (1 + targetRatioAtoB * price)
 *   x > 0  →  swap A→B,  amount = x (tokenA units)
 *   x < 0  →  swap B→A,  amount = |x| * price (tokenB units)
 */
export function computeSwapNeeded(
  balanceA: bigint,
  balanceB: bigint,
  targetRatioAtoB: number, // amountA / amountB desired
  currentPrice: number,
  slippageBps: number
): { swapAtoB: boolean; swapAmount: bigint } | null {
  const bA = Number(balanceA);
  const bB = Number(balanceB);

  if (targetRatioAtoB <= 0 || bA + bB === 0) return null;

  const x = (bA - targetRatioAtoB * bB) / (1 + targetRatioAtoB * currentPrice);

  // Skip tiny swaps (< 5% of total value in A terms)
  const totalValueInA = bA + bB / currentPrice;
  const tolerance = 0.05;
  if (Math.abs(x) < tolerance * totalValueInA) return null;

  if (x > 0) {
    const swapAmount = BigInt(Math.floor(x));
    if (swapAmount === BigInt(0)) return null;
    return { swapAtoB: true, swapAmount };
  } else {
    const bAmount = Math.abs(x) * currentPrice;
    const swapAmount = BigInt(Math.floor(bAmount));
    if (swapAmount === BigInt(0)) return null;
    return { swapAtoB: false, swapAmount };
  }
}
