/**
 * Tick math utilities for Cetus CLMM (Uniswap-v3 style).
 *
 * Price ↔ tick:
 *   price = 1.0001 ^ tick
 *   tick  = floor( log(price) / log(1.0001) )
 *
 * Prices here are expressed as (tokenB / tokenA) in raw decimal terms.
 */

export const TICK_BASE = 1.0001;
export const LOG_TICK_BASE = Math.log(TICK_BASE);
export const MIN_TICK = -443636;
export const MAX_TICK = 443636;

/**
 * Convert a decimal price to the nearest valid tick.
 * @param price  tokenB/tokenA price ratio (decimal)
 * @param tickSpacing  pool tick spacing
 * @param round  "floor" | "ceil" | "nearest" (default "nearest")
 */
export function priceToTick(
  price: number,
  tickSpacing: number,
  round: "floor" | "ceil" | "nearest" = "nearest"
): number {
  if (price <= 0) throw new RangeError("price must be positive");
  const rawTick = Math.log(price) / LOG_TICK_BASE;

  let tick: number;
  if (round === "floor") {
    tick = Math.floor(rawTick / tickSpacing) * tickSpacing;
  } else if (round === "ceil") {
    tick = Math.ceil(rawTick / tickSpacing) * tickSpacing;
  } else {
    tick = Math.round(rawTick / tickSpacing) * tickSpacing;
  }

  return clampTick(tick, tickSpacing);
}

/**
 * Convert a tick index to a decimal price.
 */
export function tickToPrice(tick: number): number {
  return Math.pow(TICK_BASE, tick);
}

/**
 * Clamp tick to [MIN_TICK, MAX_TICK] aligned to tickSpacing.
 */
export function clampTick(tick: number, tickSpacing: number): number {
  const minAligned = Math.ceil(MIN_TICK / tickSpacing) * tickSpacing;
  const maxAligned = Math.floor(MAX_TICK / tickSpacing) * tickSpacing;
  return Math.max(minAligned, Math.min(maxAligned, tick));
}

/**
 * Compute new lower/upper ticks centered on currentPrice with ±priceBandPct.
 */
export function computeNewTickRange(
  currentPrice: number,
  priceBandPct: number,
  tickSpacing: number
): { tickLower: number; tickUpper: number } {
  const factor = priceBandPct / 100;
  const lowerPrice = currentPrice * (1 - factor);
  const upperPrice = currentPrice * (1 + factor);

  const tickLower = priceToTick(lowerPrice, tickSpacing, "floor");
  const tickUpper = priceToTick(upperPrice, tickSpacing, "ceil");

  if (tickLower >= tickUpper) {
    throw new Error(
      `Invalid tick range: lower=${tickLower} >= upper=${tickUpper}`
    );
  }

  return { tickLower, tickUpper };
}

/**
 * Center tick of a range.
 */
export function centerTick(tickLower: number, tickUpper: number): number {
  return Math.round((tickLower + tickUpper) / 2);
}

/**
 * Drift of current price from range center, as a percentage of center price.
 * Returns a signed value (positive = above center, negative = below center).
 */
export function driftPct(
  currentPrice: number,
  tickLower: number,
  tickUpper: number
): number {
  const centerPrice = tickToPrice(centerTick(tickLower, tickUpper));
  return ((currentPrice - centerPrice) / centerPrice) * 100;
}

/**
 * Check if a tick is within [tickLower, tickUpper] inclusive.
 */
export function isTickInRange(
  tick: number,
  tickLower: number,
  tickUpper: number
): boolean {
  return tick >= tickLower && tick <= tickUpper;
}

/**
 * Sleep helper.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Exponential backoff delay in ms.
 * attempt starts at 0.
 */
export function backoffMs(attempt: number, baseMs = 1000, maxMs = 30000): number {
  return Math.min(baseMs * Math.pow(2, attempt), maxMs);
}
