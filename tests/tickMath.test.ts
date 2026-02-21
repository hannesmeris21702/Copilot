/**
 * Tests for tick math utilities (utils.ts)
 */

import {
  priceToTick,
  tickToPrice,
  computeNewTickRange,
  driftPct,
  isTickInRange,
  clampTick,
  centerTick,
  backoffMs,
  MIN_TICK,
  MAX_TICK,
} from "../src/utils";

describe("tickToPrice", () => {
  it("tick 0 → price 1", () => {
    expect(tickToPrice(0)).toBeCloseTo(1, 8);
  });

  it("tick 100 → price ≈ 1.01005", () => {
    expect(tickToPrice(100)).toBeCloseTo(1.01005, 4);
  });

  it("negative tick → price < 1", () => {
    const p = tickToPrice(-100);
    expect(p).toBeLessThan(1);
    expect(p).toBeCloseTo(1 / tickToPrice(100), 8);
  });
});

describe("priceToTick", () => {
  it("price 1 → tick 0 (nearest)", () => {
    expect(priceToTick(1, 1)).toBe(0);
  });

  it("round-trip: priceToTick(tickToPrice(x)) ≈ x", () => {
    for (const t of [-10000, -1, 0, 1, 100, 10000]) {
      const price = tickToPrice(t);
      const tick = priceToTick(price, 1);
      expect(tick).toBeCloseTo(t, 0);
    }
  });

  it("respects tickSpacing (60)", () => {
    const tick = priceToTick(1.5, 60);
    expect(tick % 60).toBe(0);
  });

  it("throws for non-positive price", () => {
    expect(() => priceToTick(0, 1)).toThrow();
    expect(() => priceToTick(-1, 1)).toThrow();
  });

  it("floor rounding", () => {
    const rawTick = Math.log(1.001) / Math.log(1.0001);
    const tickSpacing = 10;
    const tick = priceToTick(1.001, tickSpacing, "floor");
    expect(tick % tickSpacing).toBe(0);
    expect(tick).toBeLessThanOrEqual(rawTick);
  });

  it("ceil rounding", () => {
    const rawTick = Math.log(1.001) / Math.log(1.0001);
    const tickSpacing = 10;
    const tick = priceToTick(1.001, tickSpacing, "ceil");
    expect(tick % tickSpacing).toBe(0);
    expect(tick).toBeGreaterThanOrEqual(rawTick);
  });
});

describe("computeNewTickRange", () => {
  it("returns a valid range for 1.5% band", () => {
    const { tickLower, tickUpper } = computeNewTickRange(1.0, 1.5, 10);
    expect(tickLower).toBeLessThan(0);
    expect(tickUpper).toBeGreaterThan(0);
    expect(tickUpper).toBeGreaterThan(tickLower);
  });

  it("tick range is aligned to tickSpacing", () => {
    const tickSpacing = 60;
    const { tickLower, tickUpper } = computeNewTickRange(2500, 1.5, tickSpacing);
    expect(tickLower % tickSpacing).toBe(0);
    expect(tickUpper % tickSpacing).toBe(0);
  });

  it("even a very tiny band produces a valid range", () => {
    // A tiny band won't throw; it will produce a range at least 2 tick spacings wide
    const { tickLower, tickUpper } = computeNewTickRange(1.0, 0.00001, 1);
    expect(tickUpper).toBeGreaterThan(tickLower);
  });

  it("wider band → larger range", () => {
    const narrow = computeNewTickRange(1.0, 0.5, 1);
    const wide = computeNewTickRange(1.0, 5.0, 1);
    const narrowRange = narrow.tickUpper - narrow.tickLower;
    const wideRange = wide.tickUpper - wide.tickLower;
    expect(wideRange).toBeGreaterThan(narrowRange);
  });
});

describe("clampTick", () => {
  it("clamps to valid tick range", () => {
    expect(clampTick(MIN_TICK - 1000, 1)).toBeGreaterThanOrEqual(MIN_TICK);
    expect(clampTick(MAX_TICK + 1000, 1)).toBeLessThanOrEqual(MAX_TICK);
  });

  it("does not change valid tick", () => {
    expect(clampTick(100, 1)).toBe(100);
  });
});

describe("driftPct", () => {
  it("zero drift when price is at center", () => {
    const tickLower = -100;
    const tickUpper = 100;
    const center = centerTick(tickLower, tickUpper);
    const centerPrice = tickToPrice(center);
    expect(driftPct(centerPrice, tickLower, tickUpper)).toBeCloseTo(0, 3);
  });

  it("positive drift when above center", () => {
    const tickLower = -100;
    const tickUpper = 100;
    const aboveCenter = tickToPrice(50); // above center (0)
    expect(driftPct(aboveCenter, tickLower, tickUpper)).toBeGreaterThan(0);
  });

  it("negative drift when below center", () => {
    const tickLower = -100;
    const tickUpper = 100;
    const belowCenter = tickToPrice(-50);
    expect(driftPct(belowCenter, tickLower, tickUpper)).toBeLessThan(0);
  });
});

describe("isTickInRange", () => {
  it("returns true when tick is in range", () => {
    expect(isTickInRange(50, -100, 100)).toBe(true);
    expect(isTickInRange(-100, -100, 100)).toBe(true); // boundary
    expect(isTickInRange(100, -100, 100)).toBe(true);  // boundary
  });

  it("returns false when tick is outside range", () => {
    expect(isTickInRange(101, -100, 100)).toBe(false);
    expect(isTickInRange(-101, -100, 100)).toBe(false);
  });
});

describe("backoffMs", () => {
  it("doubles with each attempt", () => {
    expect(backoffMs(0)).toBe(1000);
    expect(backoffMs(1)).toBe(2000);
    expect(backoffMs(2)).toBe(4000);
  });

  it("caps at maxMs", () => {
    expect(backoffMs(100)).toBe(30000);
  });
});
