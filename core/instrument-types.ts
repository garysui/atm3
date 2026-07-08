// Classification of Polygon ticker `type` codes. This map is the single
// source of truth: the facts builder compiles it into a SQL CASE expression,
// so SQL and any future TS callers can never disagree.
//
// v1 rule: is_clean_common_stock is true only for plain common stock (CS).
// Name-based refinements (blank-check detection etc.) are a later, separate
// computation.

export type InstrumentClassification = {
  instrumentType: string
  securityForm: string
  isCleanCommonStock: boolean
}

export const polygonTypeClassification: Record<
  string,
  InstrumentClassification
> = {
  CS: {
    instrumentType: 'common_stock',
    securityForm: 'common_stock',
    isCleanCommonStock: true,
  },
  OS: {
    instrumentType: 'ordinary_shares',
    securityForm: 'common_stock_like',
    isCleanCommonStock: false,
  },
  PFD: {
    instrumentType: 'preferred_stock',
    securityForm: 'preferred',
    isCleanCommonStock: false,
  },
  ETF: { instrumentType: 'etf', securityForm: 'fund', isCleanCommonStock: false },
  ETN: { instrumentType: 'etn', securityForm: 'note', isCleanCommonStock: false },
  ETV: { instrumentType: 'etv', securityForm: 'fund', isCleanCommonStock: false },
  ETS: { instrumentType: 'ets', securityForm: 'fund', isCleanCommonStock: false },
  FUND: {
    instrumentType: 'closed_end_fund',
    securityForm: 'fund',
    isCleanCommonStock: false,
  },
  BASKET: {
    instrumentType: 'basket',
    securityForm: 'fund',
    isCleanCommonStock: false,
  },
  UNIT: {
    instrumentType: 'unit',
    securityForm: 'unit',
    isCleanCommonStock: false,
  },
  RIGHT: {
    instrumentType: 'right',
    securityForm: 'right',
    isCleanCommonStock: false,
  },
  WARRANT: {
    instrumentType: 'warrant',
    securityForm: 'warrant',
    isCleanCommonStock: false,
  },
  ADRC: {
    instrumentType: 'adr_common',
    securityForm: 'adr',
    isCleanCommonStock: false,
  },
  ADRP: {
    instrumentType: 'adr_preferred',
    securityForm: 'adr',
    isCleanCommonStock: false,
  },
  ADRR: {
    instrumentType: 'adr_right',
    securityForm: 'adr',
    isCleanCommonStock: false,
  },
  ADRW: {
    instrumentType: 'adr_warrant',
    securityForm: 'adr',
    isCleanCommonStock: false,
  },
  GDR: { instrumentType: 'gdr', securityForm: 'adr', isCleanCommonStock: false },
  NYRS: {
    instrumentType: 'ny_registry_shares',
    securityForm: 'adr',
    isCleanCommonStock: false,
  },
  SP: {
    instrumentType: 'structured_product',
    securityForm: 'structured_product',
    isCleanCommonStock: false,
  },
  BOND: {
    instrumentType: 'bond',
    securityForm: 'bond',
    isCleanCommonStock: false,
  },
  AGEN: {
    instrumentType: 'agency_bond',
    securityForm: 'bond',
    isCleanCommonStock: false,
  },
  EQLK: {
    instrumentType: 'equity_linked_bond',
    securityForm: 'bond',
    isCleanCommonStock: false,
  },
  LT: {
    instrumentType: 'liquidating_trust',
    securityForm: 'trust',
    isCleanCommonStock: false,
  },
}

const fallback: InstrumentClassification = {
  instrumentType: 'unknown_stock_like',
  securityForm: 'unknown_stock_like',
  isCleanCommonStock: false,
}

export function classifyPolygonType(
  typeCode: string | null,
): InstrumentClassification {
  if (!typeCode) {
    return fallback
  }

  return polygonTypeClassification[typeCode.toUpperCase()] ?? fallback
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

// Compile the map into `case upper(<expr>) when 'CS' then ... end` so the
// facts builder applies exactly this classification inside DuckDB.
export function classificationCaseSql(
  typeExpr: string,
  field: keyof InstrumentClassification,
): string {
  const arms = Object.entries(polygonTypeClassification)
    .map(([code, classification]) => {
      const value =
        field === 'isCleanCommonStock'
          ? String(classification[field])
          : sqlLiteral(classification[field])
      return `when ${sqlLiteral(code)} then ${value}`
    })
    .join(' ')
  const elseValue =
    field === 'isCleanCommonStock'
      ? String(fallback[field])
      : sqlLiteral(fallback[field])

  return `case upper(coalesce(${typeExpr}, '')) ${arms} else ${elseValue} end`
}
