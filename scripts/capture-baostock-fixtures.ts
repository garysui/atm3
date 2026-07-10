import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  runBaoStockRelay,
  type BaoStockJob,
} from '../connectors/baostock.ts'
import { parseBaoStockFrame } from '../server/baostock-frame.ts'

const outputDir = fileURLToPath(
  new URL('../tests/fixtures/baostock', import.meta.url),
)

const jobs: Array<{ dataset: string; job: BaoStockJob; stable?: boolean }> = [
  {
    dataset: 'trade_cal',
    job: {
      api: 'query_trade_dates',
      params: { start_date: '2025-01-01', end_date: '2025-01-10' },
    },
    stable: true,
  },
  {
    dataset: 'universe',
    job: { api: 'query_all_stock', params: { day: '2025-01-02' } },
  },
  {
    dataset: 'stock_basic',
    job: { api: 'query_stock_basic', params: { code: 'sh.600519' } },
  },
  {
    dataset: 'daily_k',
    job: {
      api: 'query_history_k_data_plus',
      params: {
        code: 'sh.600519',
        fields:
          'date,code,open,high,low,close,preclose,volume,amount,adjustflag,turn,tradestatus,pctChg,isST',
        start_date: '2024-07-01',
        end_date: '2024-07-10',
        frequency: 'd',
        adjustflag: '3',
      },
    },
    stable: true,
  },
  {
    dataset: 'dividend',
    job: {
      api: 'query_dividend_data',
      params: { code: 'sh.600519', year: '2024', yearType: 'report' },
    },
  },
  {
    dataset: 'adj_factor',
    job: {
      api: 'query_adjust_factor',
      params: {
        code: 'sh.600519',
        start_date: '2024-07-01',
        end_date: '2025-12-31',
      },
    },
  },
]

await mkdir(outputDir, { recursive: true })

function framesHash(frames: Awaited<ReturnType<typeof runBaoStockRelay>>['frames']) {
  return createHash('sha256')
    .update(Buffer.concat(frames.map((frame) => Buffer.from(frame.payload))))
    .digest('hex')
}

for (const { dataset, job, stable } of jobs) {
  const result = await runBaoStockRelay(job)
  let rows = 0

  for (const frame of result.frames) {
    const parsed = parseBaoStockFrame(frame.payload)
    rows += parsed.records.length
    const suffix = String(frame.seq).padStart(4, '0')
    await writeFile(
      path.join(outputDir, `${dataset}-frame-${suffix}.txt`),
      frame.payload,
    )
  }

  const hash = framesHash(result.frames)
  if (stable) {
    const repeated = await runBaoStockRelay(job)
    const repeatedHash = framesHash(repeated.frames)
    if (repeatedHash !== hash) {
      throw new Error(
        `${dataset} changed on identical re-capture: ${hash} != ${repeatedHash}`,
      )
    }
  }
  console.log(
    `${dataset}: frames=${result.frames.length} rows=${rows} ` +
      `client=${result.clientVersion} sha256=${hash}` +
      (stable ? ' deterministic=true' : ''),
  )
}
