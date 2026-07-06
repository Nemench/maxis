// Shared profit-margin math — used by the margins statistics endpoint and
// by the "sell price below cost" warning on the product edit form, so the
// definition of "margin" (profit as a % of sell price, not of cost — i.e.
// margin, not markup) lives in exactly one place.

export interface MarginResult {
  marginRand: number;
  marginPct: number;
}

// margin_pct = profit / revenue (margin, not markup — profit as a % of
// what it sold for, not as a % of what it cost). 0 revenue -> 0%, not
// NaN/Infinity, since there's nothing to express a percentage of.
export function calcMargin(revenue: number, cost: number): MarginResult {
  const marginRand = revenue - cost;
  const marginPct = revenue > 0 ? marginRand / revenue : 0;
  return { marginRand, marginPct };
}

// Weighted average margin across a group (e.g. all sales of one product,
// or a whole category) — total profit over total revenue, NOT an
// unweighted mean of each sale's margin_pct. A handful of small
// high-margin sales must not outweigh the bulk of actual revenue.
export function weightedMarginPct(totalRevenue: number, totalCost: number): number {
  return calcMargin(totalRevenue, totalCost).marginPct;
}
