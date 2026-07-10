import { z } from 'zod'

const HEADER_LENGTH = 21
const TRANSPORT_TERMINATOR = '<![CDATA[]]>\n'
const COMPRESSED_RESPONSE_TYPES = new Set(['96'])
const FIELD_INDEX_BY_METHOD: Record<string, number> = {
  query_trade_dates: 9,
  query_all_stock: 8,
  query_stock_basic: 9,
  query_history_k_data_plus: 8,
  query_dividend_data: 10,
  query_adjust_factor: 10,
}

const recordsSchema = z.object({
  record: z.array(z.array(z.union([z.string(), z.number(), z.null()]))),
})

export type BaoStockFrame = {
  version: string
  messageType: string
  bodyLength: number
  errorCode: string
  errorMessage: string
  method: string
  page: number
  pageSize: number
  fields: string[]
  records: Array<Record<string, string | number | null>>
}

function stripTerminator(value: string): string {
  const withoutTerminator = value.endsWith(TRANSPORT_TERMINATOR)
    ? value.slice(0, -TRANSPORT_TERMINATOR.length)
    : value.replace(/\n$/, '')
  const checksumSeparator = withoutTerminator.lastIndexOf('\u0001')
  const checksum = withoutTerminator.slice(checksumSeparator + 1)
  return checksumSeparator >= 0 && /^\d+$/.test(checksum)
    ? withoutTerminator.slice(0, checksumSeparator)
    : withoutTerminator
}

export function parseBaoStockFrame(bytes: Uint8Array): BaoStockFrame {
  const text = new TextDecoder().decode(bytes)
  if (text.length < HEADER_LENGTH) {
    throw new Error('BaoStock frame is shorter than its 21-byte header')
  }

  const header = text.slice(0, HEADER_LENGTH).split('\u0001')
  if (header.length !== 3) {
    throw new Error('BaoStock frame header has an unexpected shape')
  }

  const bodyText = stripTerminator(text.slice(HEADER_LENGTH))
  const declaredBodyLength = Number(header[2])
  if (
    !COMPRESSED_RESPONSE_TYPES.has(header[1]) &&
    bodyText.length !== declaredBodyLength
  ) {
    throw new Error(
      `BaoStock frame body length is ${bodyText.length}, expected ${declaredBodyLength}`,
    )
  }

  const body = bodyText.split('\u0001')
  const method = body[2] ?? ''
  const fieldIndex = FIELD_INDEX_BY_METHOD[method]
  if (fieldIndex === undefined) {
    throw new Error(`Unsupported BaoStock response method: ${method || '(blank)'}`)
  }

  const recordText = body[6] ?? ''
  const payload = recordText.trim()
    ? recordsSchema.parse(JSON.parse(recordText))
    : { record: [] }
  const fields = (body[fieldIndex] ?? '')
    .split(',')
    .map((field) => field.trim())
    .filter(Boolean)

  const records = payload.record.map((row) => {
    if (row.length !== fields.length) {
      throw new Error(
        `BaoStock ${method} row has ${row.length} values for ${fields.length} fields`,
      )
    }
    return Object.fromEntries(fields.map((field, index) => [field, row[index]]))
  })

  return {
    version: header[0],
    messageType: header[1],
    bodyLength: declaredBodyLength,
    errorCode: body[0] ?? '',
    errorMessage: body[1] ?? '',
    method,
    page: Number(body[4]),
    pageSize: Number(body[5]),
    fields,
    records,
  }
}
