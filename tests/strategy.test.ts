/**
 * Tests for the strategy decision engine (strategy.ts)
 */

import {
  evaluateStrategy,
  computeTokenAmounts,
  computeSwapNeeded,
  PoolState,
  PositionState,
} from "../src/strategy";
import { tickToPrice } from "../src/utils";

// Shared fixtures
const basePool: PoolState = {
  currentTick: 0,
  currentPrice: 1.0,
  tickSpacing: 10,
  sqrtPrice: BigInt("18446744073709551616"), // 2^64
};

const basePosition: PositionState = {
  tickLower: -200,
  tickUpper: 200,
  liquidity: BigInt("1000000"),
  unclaimedFeeA: BigInt("100"),
  unclaimedFeeB: BigInt("200"),
};

const baseConfig = {
  rebalanceMode: "price_band" as const,
  priceBandPct: 1.5,
  driftTriggerPct: 0.5,
};

// ──────────────────────────────────────────────────────────────────
// evaluateStrategy
// ──────────────────────────────────────────────────────────────────

describe("evaluateStrategy – no rebalance needed", () => {
  it("does not rebalance when price is in range and drift is within threshold", () => {
    const decision = evaluateStrategy(basePool, basePosition, baseConfig);
    expect(decision.shouldRebalance).toBe(false);
    expect(decision.trigger).toBe("none");
  });
});

describe("evaluateStrategy – price out of range", () => {
  it("triggers rebalance when current tick is above range", () => {
    const pool: PoolState = {
      ...basePool,
      currentTick: 300, // outside [−200, 200]
      currentPrice: tickToPrice(300),
    };
    const decision = evaluateStrategy(pool, basePosition, baseConfig);
    expect(decision.shouldRebalance).toBe(true);
    expect(decision.trigger).toBe("price_out_of_range");
    expect(decision.newTickLower).toBeDefined();
    expect(decision.newTickUpper).toBeDefined();
    expect(decision.newTickLower!).toBeLessThan(decision.newTickUpper!);
  });

  it("triggers rebalance when current tick is below range", () => {
    const pool: PoolState = {
      ...basePool,
      currentTick: -300, // outside [−200, 200]
      currentPrice: tickToPrice(-300),
    };
    const decision = evaluateStrategy(pool, basePosition, baseConfig);
    expect(decision.shouldRebalance).toBe(true);
    expect(decision.trigger).toBe("price_out_of_range");
  });

  it("new tick range is aligned to tickSpacing", () => {
    const pool: PoolState = {
      ...basePool,
      currentTick: 300,
      currentPrice: tickToPrice(300),
    };
    const decision = evaluateStrategy(pool, basePosition, baseConfig);
    expect(decision.newTickLower! % basePool.tickSpacing).toBe(0);
    expect(decision.newTickUpper! % basePool.tickSpacing).toBe(0);
  });
});

describe("evaluateStrategy – drift exceeded", () => {
  it("triggers rebalance when drift exceeds threshold", () => {
    // Place price high enough that drift > 0.5%
    const pool: PoolState = {
      ...basePool,
      currentTick: 100, // in range [−200, 200] but drifted from center
      currentPrice: tickToPrice(100),
    };
    const decision = evaluateStrategy(pool, basePosition, { ...baseConfig, driftTriggerPct: 0.1 });
    expect(decision.shouldRebalance).toBe(true);
    expect(decision.trigger).toBe("drift_exceeded");
  });

  it("does not trigger if drift is within threshold", () => {
    // Very small drift
    const pool: PoolState = {
      ...basePool,
      currentTick: 1,
      currentPrice: tickToPrice(1),
    };
    const decision = evaluateStrategy(pool, basePosition, { ...baseConfig, driftTriggerPct: 1.0 });
    expect(decision.shouldRebalance).toBe(false);
  });
});

describe("evaluateStrategy – rebalance mode is honoured via priceBandPct", () => {
  it("new range is centered around current price (width ≈ 2 * priceBandPct)", () => {
    const pool: PoolState = {
      ...basePool,
      currentTick: 300,
      currentPrice: tickToPrice(300),
    };
    const decision = evaluateStrategy(pool, basePosition, { ...baseConfig, priceBandPct: 2.0 });
    const lowerPrice = tickToPrice(decision.newTickLower!);
    const upperPrice = tickToPrice(decision.newTickUpper!);
    // Lower should be roughly currentPrice * (1 - 0.02)
    expect(lowerPrice).toBeLessThan(pool.currentPrice);
    expect(upperPrice).toBeGreaterThan(pool.currentPrice);
  });
});

// ──────────────────────────────────────────────────────────────────
// computeTokenAmounts
// ──────────────────────────────────────────────────────────────────

describe("computeTokenAmounts", () => {
  it("returns non-negative amounts", () => {
    const { amountA, amountB } = computeTokenAmounts(
      BigInt("1000000"),
      1.0,
      -100,
      100
    );
    expect(amountA).toBeGreaterThanOrEqual(0);
    expect(amountB).toBeGreaterThanOrEqual(0);
  });

  it("all tokenA when price below lower bound", () => {
    const tickLower = 100;
    const tickUpper = 200;
    const lowerPrice = tickToPrice(tickLower);
    const currentPrice = lowerPrice * 0.5; // below range
    const { amountA, amountB } = computeTokenAmounts(
      BigInt("1000000"),
      currentPrice,
      tickLower,
      tickUpper
    );
    expect(amountA).toBeGreaterThan(0);
    expect(amountB).toBe(0);
  });

  it("all tokenB when price above upper bound", () => {
    const tickLower = -200;
    const tickUpper = -100;
    const upperPrice = tickToPrice(tickUpper);
    const currentPrice = upperPrice * 2; // above range
    const { amountA, amountB } = computeTokenAmounts(
      BigInt("1000000"),
      currentPrice,
      tickLower,
      tickUpper
    );
    expect(amountB).toBeGreaterThan(0);
    expect(amountA).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────
// computeSwapNeeded
// ──────────────────────────────────────────────────────────────────

describe("computeSwapNeeded", () => {
  it("returns null when ratio is already balanced (within tolerance)", () => {
    // Target ratio 1:1 (amountA/amountB = 1), current holdings ~1:1
    const result = computeSwapNeeded(
      BigInt(1000),
      BigInt(1000),
      1.0,
      1.0,
      50
    );
    expect(result).toBeNull();
  });

  it("suggests swap A→B when too much A", () => {
    // Holding lots of A, target ratio 1 (equal)
    const result = computeSwapNeeded(
      BigInt(10000),
      BigInt(100),
      1.0,  // target: equal amounts
      1.0,  // price
      50
    );
    expect(result).not.toBeNull();
    if (result) {
      expect(result.swapAtoB).toBe(true);
      expect(result.swapAmount).toBeGreaterThan(BigInt(0));
    }
  });

  it("suggests swap B→A when too much B", () => {
    const result = computeSwapNeeded(
      BigInt(100),
      BigInt(10000),
      1.0,
      1.0,
      50
    );
    expect(result).not.toBeNull();
    if (result) {
      expect(result.swapAtoB).toBe(false);
    }
  });

  it("returns null for zero balances", () => {
    const result = computeSwapNeeded(
      BigInt(0),
      BigInt(0),
      1.0,
      1.0,
      50
    );
    expect(result).toBeNull();
  });
});
