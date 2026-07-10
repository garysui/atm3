import type { DuckDBConnection } from '@duckdb/node-api'

// Cross-sectional unusual-movement ranking at T (VT-P7): one SQL pass over
// the verified adjusted-bars cache, computing each name's surprise against
// its OWN trailing distribution, then ranking those surprises across the
// day's qualifying universe. Sort keys are the beta-removed residual z
// (default where a market baseline exists) or the raw return z.
export const rankSortKeys = ['resid_z', 'ret_z', 'ret_z_vadj', 'range_surprise'] as const
export type RankSortKey = (typeof rankSortKeys)[number]

export type RankAtRow = {
  instrument_id: string
  symbol: string
  name: string
  ret_1d: number | null
  resid_z: number | null
  ret_z: number | null
  ret_z_vadj: number | null
  range_surprise: number | null
  rvol_21d: number | null
  ret_pctile_252d: number | null
  dollar_adv21: number | null
  xs_rank: number
}

export type RankAtResult = {
  t: string
  scope: string
  baseline: 'SPY' | null
  sort: RankSortKey
  min_dollar_adv: number
  universe: {
    traded_at_t: number
    qualifying: number
    excluded_liquidity: number
    excluded_window: number
  }
  gauges: {
    median_abs_ret_z: number | null
    share_abs_ret_z_gt2: number | null
  }
  rows: RankAtRow[]
}

export class RankAtDateError extends Error {
  readonly previousDate: string | null
  readonly nextDate: string | null

  constructor(t: string, previousDate: string | null, nextDate: string | null) {
    super(
      `${t} has no bars in this scope` +
        ` (previous: ${previousDate ?? 'none'}, next: ${nextDate ?? 'none'})`,
    )
    this.name = 'RankAtDateError'
    this.previousDate = previousDate
    this.nextDate = nextDate
  }
}

export async function rankAt(
  connection: DuckDBConnection,
  options: {
    // Omitted t resolves to the scope's data frontier (latest bar date).
    t?: string
    scope: string
    sort?: RankSortKey
    minDollarAdv?: number
    limit?: number
  },
): Promise<RankAtResult> {
  let t = options.t
  if (t === undefined) {
    const frontier = await connection.runAndReadAll(
      `select cast(max(market_date) as varchar) as last_date
       from facts.bars_daily where market_scope = $scope`,
      { scope: options.scope },
    )
    const lastDate = frontier.getRowObjectsJson()[0]?.last_date
    if (lastDate === null || lastDate === undefined) {
      throw new Error(`no bars in ${options.scope}`)
    }
    t = String(lastDate)
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    throw new Error('t must be YYYY-MM-DD')
  }
  const minDollarAdv = options.minDollarAdv ?? 0
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 500)

  // Baseline: SPY resolved through symbol validity at T; scopes without one
  // rank by raw z and say so.
  const spyResult = await connection.runAndReadAll(
    `
      select cast(s.instrument_id as varchar) as instrument_id
      from facts.symbols s
      where s.market_scope = $scope and s.symbol = 'SPY'
        and (s.valid_from is null or s.valid_from <= cast($t as date))
        and (s.valid_to is null or s.valid_to > cast($t as date))
      order by s.is_primary desc, s.valid_from desc
      limit 1
    `,
    { scope: options.scope, t },
  )
  const spyId = spyResult.getRowObjectsJson()[0]?.instrument_id
  const baseline = spyId === undefined ? null : 'SPY'
  const sort = options.sort ?? (baseline ? 'resid_z' : 'ret_z')
  if (sort === 'resid_z' && baseline === null) {
    throw new Error(
      `no market baseline in ${options.scope}: sort by ret_z instead`,
    )
  }

  const dateGate = await connection.runAndReadAll(
    `
      with scoped as (
        select b.market_date
        from computed.bars_daily_adjusted_cache b
        join facts.instruments i using (instrument_id)
        where i.primary_market_scope = $scope
          and b.adjustment_policy = 'split_dividend'
      )
      select
        exists(select 1 from scoped where market_date = cast($t as date)) as has_t,
        cast(max(market_date) filter (where market_date < cast($t as date)) as varchar)
          as previous_date,
        cast(min(market_date) filter (where market_date > cast($t as date)) as varchar)
          as next_date
      from scoped
    `,
    { scope: options.scope, t },
  )
  const gate = dateGate.getRowObjectsJson()[0]
  if (gate?.has_t !== true) {
    throw new RankAtDateError(
      t,
      gate?.previous_date === null || gate?.previous_date === undefined
        ? null
        : String(gate.previous_date),
      gate?.next_date === null || gate?.next_date === undefined
        ? null
        : String(gate.next_date),
    )
  }

  const result = await connection.runAndReadAll(
    `
      with base as (
        select
          b.instrument_id,
          b.market_date,
          b.high, b.low, b.close,
          -- Raw (split-invariant) dollar volume recovered from the cache.
          (b.close / b.cum_price_factor)
            * (b.volume / nullif(b.cum_volume_factor, 0)) as dv,
          row_number() over (
            partition by b.instrument_id order by b.market_date desc
          ) - 1 as idx,
          ln(b.close / nullif(lead(b.close) over (
            partition by b.instrument_id order by b.market_date desc
          ), 0)) as lr,
          (b.high - b.low) / nullif(lead(b.close) over (
            partition by b.instrument_id order by b.market_date desc
          ), 0) as rel_range,
          power(ln(b.high / nullif(b.low, 0)), 2) as park_term
        from computed.bars_daily_adjusted_cache b
        join facts.instruments i using (instrument_id)
        where i.primary_market_scope = $scope
          and b.adjustment_policy = 'split_dividend'
          and b.market_date <= cast($t as date)
          and b.market_date > cast($t as date) - interval 500 days
      ),
      spy as (
        select market_date, lr as lr_spy from base
        where cast(instrument_id as varchar) = coalesce($spy_id, '')
      ),
      traded as (
        select instrument_id from base
        where idx = 0 and market_date = cast($t as date)
      ),
      agg as (
        select
          b.instrument_id,
          max(b.lr) filter (where b.idx = 0) as lr0,
          exp(max(b.lr) filter (where b.idx = 0)) - 1 as ret_1d,
          max(b.dv) filter (where b.idx = 0) as dv0,
          avg(b.dv) filter (where b.idx between 1 and 21) as adv_prev,
          count(b.dv) filter (where b.idx between 1 and 21) as adv_count,
          sqrt(avg(b.park_term) filter (where b.idx between 1 and 21)
               / (4 * ln(2))) as park_prev,
          count(b.park_term) filter (where b.idx between 1 and 21)
            as park_count,
          max(b.rel_range) filter (where b.idx = 0) as rel_range_0,
          median(b.rel_range) filter (where b.idx between 1 and 21)
            as range_med,
          count(b.rel_range) filter (where b.idx between 1 and 21)
            as range_count,
          count(b.lr) filter (where b.idx between 1 and 252) as prev252
        from base b
        join traded using (instrument_id)
        group by b.instrument_id
      ),
      pairs as (
        select
          b.instrument_id,
          b.lr,
          s.lr_spy,
          row_number() over (
            partition by b.instrument_id order by b.market_date desc
          ) - 1 as pair_idx
        from base b
        join traded using (instrument_id)
        join spy s using (market_date)
        where b.lr is not null and s.lr_spy is not null
      ),
      resid as (
        select
          instrument_id,
          count(*) filter (where pair_idx between 1 and 63) as pair_count,
          max(lr) filter (where pair_idx = 0) as pair_lr0,
          max(lr_spy) filter (where pair_idx = 0) as pair_spy0,
          regr_slope(lr, lr_spy) filter (where pair_idx between 1 and 63)
            as beta_prev,
          var_samp(lr) filter (where pair_idx between 1 and 63) as var_stock,
          var_samp(lr_spy) filter (where pair_idx between 1 and 63) as var_spy,
          covar_samp(lr, lr_spy) filter (where pair_idx between 1 and 63)
            as cov_prev
        from pairs
        group by instrument_id
      ),
      pct as (
        select
          b.instrument_id,
          count(*) filter (where b.idx between 1 and 252 and b.lr < a.lr0)
            as below,
          count(*) filter (where b.idx between 1 and 252 and b.lr = a.lr0)
            as equal
        from base b
        join agg a using (instrument_id)
        group by b.instrument_id
      ),
      scored as (
        select
          a.instrument_id,
          a.ret_1d,
          case when a.park_count = 21 and a.park_prev > 0
            then a.lr0 / a.park_prev end as ret_z,
          case when a.park_count = 21 and a.park_prev > 0
                and a.adv_count = 21 and a.adv_prev > 0 and a.dv0 > 0
            then (a.lr0 / a.park_prev) / sqrt(a.dv0 / a.adv_prev)
          end as ret_z_vadj,
          case when a.range_count = 21 and a.range_med > 0
            then a.rel_range_0 / a.range_med end as range_surprise,
          case when a.adv_count = 21 and a.adv_prev > 0
            then a.dv0 / a.adv_prev end as rvol_21d,
          case when a.prev252 = 252
            then (p.below + 0.5 * p.equal) / 252.0 end as ret_pctile_252d,
          case when a.adv_count = 21 then a.adv_prev end as dollar_adv21,
          case
            when r.pair_count = 63 and r.var_spy > 0
              and (r.var_stock + r.beta_prev * r.beta_prev * r.var_spy
                   - 2 * r.beta_prev * r.cov_prev) > 0
            then (r.pair_lr0 - r.beta_prev * r.pair_spy0)
                 / sqrt(r.var_stock
                        + r.beta_prev * r.beta_prev * r.var_spy
                        - 2 * r.beta_prev * r.cov_prev)
          end as resid_z
        from agg a
        left join pct p using (instrument_id)
        left join resid r using (instrument_id)
      ),
      qualified as (
        select *,
          (${sort === 'resid_z' ? 'resid_z' : sort} is not null) as has_sort,
          coalesce(dollar_adv21, 0) >= $min_adv as liquid
        from scored
      )
      select
        (select count(*) from traded) as traded_at_t,
        count(*) filter (where has_sort and liquid) as qualifying,
        count(*) filter (where has_sort and not liquid) as excluded_liquidity,
        count(*) filter (where not has_sort) as excluded_window,
        median(abs(ret_z)) filter (where has_sort and liquid)
          as median_abs_ret_z,
        avg(case when abs(ret_z) > 2 then 1.0 else 0.0 end)
          filter (where has_sort and liquid and ret_z is not null)
          as share_abs_ret_z_gt2,
        list(
          {
            instrument_id: cast(instrument_id as varchar),
            ret_1d: ret_1d,
            resid_z: resid_z,
            ret_z: ret_z,
            ret_z_vadj: ret_z_vadj,
            range_surprise: range_surprise,
            rvol_21d: rvol_21d,
            ret_pctile_252d: ret_pctile_252d,
            dollar_adv21: dollar_adv21
          }
          order by abs(${sort === 'resid_z' ? 'resid_z' : sort}) desc,
                   instrument_id
        ) filter (where has_sort and liquid) as ranked
      from qualified
    `,
    {
      scope: options.scope,
      t,
      spy_id: spyId === undefined ? null : String(spyId),
      min_adv: minDollarAdv,
    },
  )

  const summary = result.getRowObjectsJson()[0] as Record<string, unknown>
  const num = (value: unknown): number | null =>
    value === null || value === undefined ? null : Number(value)
  const ranked = ((summary.ranked ?? []) as Array<Record<string, unknown>>)
    .slice(0, limit)

  // Names/symbols only for the returned page, not the whole universe.
  const ids = ranked.map((row) => String(row.instrument_id))
  const labels = new Map<string, { symbol: string; name: string }>()
  if (ids.length > 0) {
    const labelResult = await connection.runAndReadAll(
      `
        select
          cast(i.instrument_id as varchar) as instrument_id,
          coalesce(s.symbol, '?') as symbol,
          i.name
        from facts.instruments i
        left join facts.symbols s
          on s.instrument_id = i.instrument_id
         and s.market_scope = $scope
         and (s.valid_from is null or s.valid_from <= cast($t as date))
         and (s.valid_to is null or s.valid_to > cast($t as date))
        where cast(i.instrument_id as varchar) in (
          ${ids.map((_, index) => `$id_${index}`).join(', ')}
        )
        qualify row_number() over (
          partition by i.instrument_id
          order by s.is_primary desc nulls last, s.valid_from desc nulls last
        ) = 1
      `,
      {
        scope: options.scope,
        t,
        ...Object.fromEntries(ids.map((id, index) => [`id_${index}`, id])),
      },
    )
    for (const row of labelResult.getRowObjectsJson()) {
      labels.set(String(row.instrument_id), {
        symbol: String(row.symbol),
        name: String(row.name),
      })
    }
  }

  return {
    t,
    scope: options.scope,
    baseline,
    sort,
    min_dollar_adv: minDollarAdv,
    universe: {
      traded_at_t: Number(summary.traded_at_t ?? 0),
      qualifying: Number(summary.qualifying ?? 0),
      excluded_liquidity: Number(summary.excluded_liquidity ?? 0),
      excluded_window: Number(summary.excluded_window ?? 0),
    },
    gauges: {
      median_abs_ret_z: num(summary.median_abs_ret_z),
      share_abs_ret_z_gt2: num(summary.share_abs_ret_z_gt2),
    },
    rows: ranked.map((row, index) => ({
      instrument_id: String(row.instrument_id),
      symbol: labels.get(String(row.instrument_id))?.symbol ?? '?',
      name: labels.get(String(row.instrument_id))?.name ?? '?',
      ret_1d: num(row.ret_1d),
      resid_z: num(row.resid_z),
      ret_z: num(row.ret_z),
      ret_z_vadj: num(row.ret_z_vadj),
      range_surprise: num(row.range_surprise),
      rvol_21d: num(row.rvol_21d),
      ret_pctile_252d: num(row.ret_pctile_252d),
      dollar_adv21: num(row.dollar_adv21),
      xs_rank: index + 1,
    })),
  }
}
