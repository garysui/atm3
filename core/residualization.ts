export type DatedClose = { date: string; close: number }

export type ResidualizationResult = {
  bars_available: number
  beta_63: number
  corr_63: number
  resid_ret_21: number
  resid_ret_63: number
  idio_vol_63: number
  relative_ret_21: number
  relative_ret_63: number
  // Today's residual in units of YESTERDAY's residual sigma: beta and sigma
  // are estimated on the 63 aligned pairs ending at T-1, so today's move
  // cannot contaminate its own denominator. Null until 64 pairs exist.
  resid_z: number | null
}

export type ResidualizationOutcome = {
  result: ResidualizationResult | null
  bars_available: number
  reason: 'insufficient_window' | 'undefined_input' | null
}

type DatedReturn = { date: string; value: number }

function logReturns(series: readonly DatedClose[]): DatedReturn[] {
  const sorted = [...series].sort((a, b) => a.date.localeCompare(b.date))
  const returns: DatedReturn[] = []
  for (let index = 1; index < sorted.length; index++) {
    const previous = sorted[index - 1]
    const current = sorted[index]
    if (previous.close > 0 && current.close > 0) {
      returns.push({
        date: current.date,
        value: Math.log(current.close / previous.close),
      })
    }
  }
  return returns
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function sampleStd(values: readonly number[]): number {
  const average = mean(values)
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
      (values.length - 1),
  )
}

export function residualize(
  stock: readonly DatedClose[],
  baseline: readonly DatedClose[],
): ResidualizationOutcome {
  const stockReturns = new Map(
    logReturns(stock).map((row) => [row.date, row.value]),
  )
  const alignedAll = logReturns(baseline)
    .flatMap((row) => {
      const stockReturn = stockReturns.get(row.date)
      return stockReturn === undefined
        ? []
        : [{ date: row.date, stock: stockReturn, baseline: row.value }]
    })
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 64)
  const aligned = alignedAll.slice(0, 63)

  const barsAvailable = aligned.length === 0 ? 0 : aligned.length + 1
  if (aligned.length < 63) {
    return {
      result: null,
      bars_available: barsAvailable,
      reason: 'insufficient_window',
    }
  }

  const stockValues = aligned.map((row) => row.stock)
  const baselineValues = aligned.map((row) => row.baseline)
  const stockMean = mean(stockValues)
  const baselineMean = mean(baselineValues)
  const covarianceNumerator = aligned.reduce(
    (sum, row) =>
      sum + (row.stock - stockMean) * (row.baseline - baselineMean),
    0,
  )
  const baselineVarianceNumerator = baselineValues.reduce(
    (sum, value) => sum + (value - baselineMean) ** 2,
    0,
  )
  const stockVarianceNumerator = stockValues.reduce(
    (sum, value) => sum + (value - stockMean) ** 2,
    0,
  )
  if (baselineVarianceNumerator === 0 || stockVarianceNumerator === 0) {
    return {
      result: null,
      bars_available: barsAvailable,
      reason: 'undefined_input',
    }
  }

  const beta = covarianceNumerator / baselineVarianceNumerator
  const correlation = covarianceNumerator /
    Math.sqrt(baselineVarianceNumerator * stockVarianceNumerator)
  const residuals = aligned.map(
    (row) => row.stock - beta * row.baseline,
  )
  const compound = (values: readonly number[]) =>
    Math.exp(values.reduce((sum, value) => sum + value, 0)) - 1
  const relative = (count: number) =>
    compound(stockValues.slice(0, count)) -
    compound(baselineValues.slice(0, count))

  // Yesterday-anchored surprise: estimate beta and residual sigma on pairs
  // 1..63 (a full window ending the day BEFORE T), then score today's pair.
  let residZ: number | null = null
  if (alignedAll.length === 64) {
    const previous = alignedAll.slice(1)
    const previousStock = previous.map((row) => row.stock)
    const previousBaseline = previous.map((row) => row.baseline)
    const previousStockMean = mean(previousStock)
    const previousBaselineMean = mean(previousBaseline)
    const previousCovariance = previous.reduce(
      (sum, row) =>
        sum +
        (row.stock - previousStockMean) *
        (row.baseline - previousBaselineMean),
      0,
    )
    const previousBaselineVariance = previousBaseline.reduce(
      (sum, value) => sum + (value - previousBaselineMean) ** 2,
      0,
    )
    if (previousBaselineVariance > 0) {
      const previousBeta = previousCovariance / previousBaselineVariance
      const previousResiduals = previous.map(
        (row) => row.stock - previousBeta * row.baseline,
      )
      const previousSigma = sampleStd(previousResiduals)
      if (previousSigma > 0) {
        const today = alignedAll[0]
        residZ = (today.stock - previousBeta * today.baseline) / previousSigma
      }
    }
  }

  return {
    result: {
      bars_available: barsAvailable,
      beta_63: beta,
      corr_63: correlation,
      resid_ret_21: compound(residuals.slice(0, 21)),
      resid_ret_63: compound(residuals),
      idio_vol_63: sampleStd(residuals) * Math.sqrt(252),
      relative_ret_21: relative(21),
      relative_ret_63: relative(63),
      resid_z: residZ,
    },
    bars_available: barsAvailable,
    reason: null,
  }
}
