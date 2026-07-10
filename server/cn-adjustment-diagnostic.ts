import type { DuckDBConnection } from '@duckdb/node-api'
import { stageCnVendorAdjustmentFactors } from './facts-build-cn.ts'
import type { BuildOptions } from './facts-common.ts'

export type CnAdjustmentDiagnostic = {
  staged: { vendorFactorRows: number; invalidVendorFactorRows: number }
  coverage: Array<Record<string, unknown>>
  segments: Array<Record<string, unknown>>
  largestResiduals: Array<Record<string, unknown>>
  invalidVendorRows: Array<Record<string, unknown>>
}

export async function diagnoseCnAdjustments(
  connection: DuckDBConnection,
  options: BuildOptions = {},
): Promise<CnAdjustmentDiagnostic> {
  const staged = await stageCnVendorAdjustmentFactors(connection, options)

  await connection.run(`
    create or replace temp table t_cn_local_factor_events as
    with event_factors as (
      select
        af.instrument_id,
        af.event_date,
        product(af.price_factor) as local_price_factor,
        bool_or(af.action_type = 'cash_dividend') as has_cash,
        bool_or(af.action_type = 'stock_dividend') as has_stock
      from computed.adjustment_factor_events af
      join facts.instruments i using (instrument_id)
      where i.primary_market_scope = 'cn_stocks'
        and af.action_type in ('cash_dividend', 'stock_dividend')
      group by af.instrument_id, af.event_date
    )
    select
      e.*,
      id.identifier_value as vendor_code
    from event_factors e
    left join facts.instrument_identifiers id
      on id.instrument_id = e.instrument_id
     and id.identifier_type = 'baostock_code'
     and e.event_date >= id.valid_from
     and (id.valid_to is null or e.event_date < id.valid_to)
  `)

  await connection.run(`
    create or replace temp table t_cn_adjustment_diagnostic as
    with vendor as (
      select
        v.*,
        id.instrument_id
      from t_cn_vendor_factor_events v
      left join facts.instrument_identifiers id
        on id.identifier_type = 'baostock_code'
       and id.identifier_value = v.vendor_code
       and v.event_date >= id.valid_from
       and (id.valid_to is null or v.event_date < id.valid_to)
    )
    select
      coalesce(v.vendor_code, l.vendor_code, '(unresolved)') as vendor_code,
      coalesce(v.event_date, l.event_date) as event_date,
      v.cumulative_factor,
      v.vendor_price_factor,
      l.local_price_factor,
      l.has_cash,
      l.has_stock,
      case
        when v.vendor_code is null then 'no_vendor_event'
        when v.instrument_id is null then 'vendor_code_unresolved'
        when v.row_status = 'vendor_baseline' then 'vendor_baseline'
        when l.instrument_id is null then 'no_local_factor'
        else 'comparable'
      end as comparison_class,
      case
        when coalesce(l.has_cash, false) and coalesce(l.has_stock, false)
          then 'cash_plus_stock'
        when coalesce(l.has_stock, false) then 'stock_only'
        when coalesce(l.has_cash, false) then 'cash_only'
        else 'no_local_factor'
      end as action_segment,
      l.local_price_factor - v.vendor_price_factor as signed_residual,
      abs(l.local_price_factor - v.vendor_price_factor) as absolute_residual
    from vendor v
    full outer join t_cn_local_factor_events l
      on l.instrument_id = v.instrument_id and l.event_date = v.event_date
  `)

  const coverage = await connection.runAndReadAll(`
    select comparison_class, count(*) as events
    from t_cn_adjustment_diagnostic
    group by comparison_class
    order by comparison_class
  `)
  const segments = await connection.runAndReadAll(`
    select
      action_segment,
      count(*) as events,
      round(avg(signed_residual), 9) as mean_signed_residual,
      round(median(absolute_residual), 9) as median_absolute_residual,
      round(quantile_cont(absolute_residual, 0.95), 9)
        as p95_absolute_residual,
      round(max(absolute_residual), 9) as max_absolute_residual
    from t_cn_adjustment_diagnostic
    where comparison_class = 'comparable'
    group by action_segment
    order by action_segment
  `)
  const largestResiduals = await connection.runAndReadAll(`
    select
      vendor_code,
      cast(event_date as varchar) as event_date,
      action_segment,
      round(local_price_factor, 9) as local_price_factor,
      round(vendor_price_factor, 9) as vendor_price_factor,
      round(signed_residual, 9) as signed_residual,
      round(absolute_residual, 9) as absolute_residual
    from t_cn_adjustment_diagnostic
    where comparison_class = 'comparable'
    order by absolute_residual desc, vendor_code, event_date
    limit 15
  `)
  const invalidVendorRows = await connection.runAndReadAll(`
    select vendor_code, event_date_text, cumulative_factor_text, reason
    from t_cn_vendor_factor_invalid
    order by vendor_code, event_date_text
    limit 15
  `)

  return {
    staged,
    coverage: coverage.getRowObjectsJson() as Array<Record<string, unknown>>,
    segments: segments.getRowObjectsJson() as Array<Record<string, unknown>>,
    largestResiduals: largestResiduals.getRowObjectsJson() as Array<
      Record<string, unknown>
    >,
    invalidVendorRows: invalidVendorRows.getRowObjectsJson() as Array<
      Record<string, unknown>
    >,
  }
}
