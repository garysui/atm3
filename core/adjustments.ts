// Adjustment math. Per-event factors only — computed from corporate-action
// facts and our own raw closes, never from vendor adjustment factors
// (Polygon's dividend `historical_adjustment_factor` is CUMULATIVE; treating
// it as per-event and compounding destroyed multi-dividend histories in the
// predecessor project, 2026-07-06).
//
// Back-adjustment convention: bars on/after an event's ex date are true to
// tape; every bar strictly before the ex date is multiplied by the factor.
// A bar's cumulative factor is the product over all events with
// ex_date > bar date.

export const adjustmentPolicies = ['none', 'split', 'split_dividend'] as const

export type AdjustmentPolicy = (typeof adjustmentPolicies)[number]

// Bump when the adjustment computation changes meaning; cached computed rows
// with a different version are invalid.
// v2 (two lessons from real vendor data):
// - Vendors state one action under BOTH tickers around a rename (MULN/BINI
//   2025-06-02); duplicate same-day statements collapse to one factor
//   instead of compounding.
// - Vendors publish actions before they execute (SOXS 10:1 announced for a
//   future ex date) and after an instrument stops trading (FOXO 3000:1 after
//   going dark). An event applies to a series only when the series has bars
//   after it: factors apply only where ex_date <= the instrument's last bar
//   date, anchoring each series to its own latest tape.
// v3: stock dividends/conversions are structure events, and cash dividends
// are accepted in the instrument's own currency instead of USD only.
export const ADJUSTMENT_COMPUTATION_VERSION = 'adjust_v3'

// 2-for-1 split (from=1, to=2): earlier prices halve, earlier volumes double.
export function splitPriceFactor(splitFrom: number, splitTo: number): number {
  return splitFrom / splitTo
}

export function splitVolumeFactor(splitFrom: number, splitTo: number): number {
  return splitTo / splitFrom
}

// Bonus and reserve-conversion shares are stated per existing share. A total
// ratio of 0.5 makes each old share become 1.5 shares: prior prices divide by
// 1.5 and prior volumes multiply by 1.5.
export function stockDividendFactor(
  bonusRatio: number,
  conversionRatio: number,
): number {
  return 1 / (1 + bonusRatio + conversionRatio)
}

export function stockDividendVolumeFactor(
  bonusRatio: number,
  conversionRatio: number,
): number {
  return 1 + bonusRatio + conversionRatio
}

// Cash dividend: earlier prices scale by 1 - cash/prevRawClose, where
// prevRawClose is the last UNADJUSTED close strictly before the ex date —
// both sides are in the same era's price units, so factors compose across
// later splits. Same-day distributions must be summed into one cash amount
// BEFORE calling this (two same-day dividends reduce the same prev close
// once; multiplying two factors would double-count it).
export function dividendPriceFactor(
  cashAmount: number,
  prevRawClose: number,
): number {
  return 1 - cashAmount / prevRawClose
}
