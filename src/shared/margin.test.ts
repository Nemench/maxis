import { describe, it, expect } from "vitest";
import { calcMargin, weightedMarginPct } from "./margin";

describe("calcMargin", () => {
  it("computes margin as profit / revenue (margin, not markup)", () => {
    // Sell R100, cost R60 -> R40 profit -> 40% margin (not 66.7% markup)
    const { marginRand, marginPct } = calcMargin(100, 60);
    expect(marginRand).toBe(40);
    expect(marginPct).toBeCloseTo(0.4);
  });

  it("handles a loss (sell price below cost) as a negative margin", () => {
    const { marginRand, marginPct } = calcMargin(50, 70);
    expect(marginRand).toBe(-20);
    expect(marginPct).toBeCloseTo(-0.4);
  });

  it("returns 0% (not NaN/Infinity) when revenue is 0", () => {
    expect(calcMargin(0, 0).marginPct).toBe(0);
    expect(calcMargin(0, 10).marginPct).toBe(0);
  });
});

describe("weightedMarginPct", () => {
  it("weights by total rand, not an unweighted average of per-sale percentages", () => {
    // Sale A: R10 revenue, R1 cost -> 90% margin
    // Sale B: R990 revenue, R693 cost -> 30% margin
    // Unweighted average would be 60%; weighted (correct) is (9+297)/1000 = 30.6%
    const totalRevenue = 10 + 990;
    const totalCost = 1 + 693;
    expect(weightedMarginPct(totalRevenue, totalCost)).toBeCloseTo((1000 - 694) / 1000);
    expect(weightedMarginPct(totalRevenue, totalCost)).not.toBeCloseTo(0.6, 1);
  });
});
