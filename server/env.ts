import 'dotenv/config'
import path from 'node:path'
import { z } from 'zod'

const envSchema = z.object({
  ATM3_DATA_DIR: z.string().default('data'),
  ATM3_DUCKDB_PATH: z.string().optional(),
  ATM3_LOG_LEVEL: z.string().default('info'),
  ATM3_API_HOST: z.string().default('127.0.0.1'),
  ATM3_API_PORT: z.coerce.number().int().positive().default(5180),
  ATM3_BACKFILL_FROM: z.string().optional(),
  ATM3_BACKFILL_TO: z.string().optional(),
  // Intraday flat files can use a shorter window than the daily backfill
  // (they are ~30 MB/day); defaults to ATM3_BACKFILL_FROM when unset.
  ATM3_INTRADAY_BACKFILL_FROM: z.string().optional(),
  ATM3_CN_SOURCE: z.enum(['baostock']).optional(),
  ATM3_CN_BACKFILL_FROM: z.string().optional(),
  ATM3_CN_PYTHON: z.string().optional(),
  POLYGON_API_KEY: z.string().optional(),
  // Polygon/Massive flat files use S3-compatible credentials (an AWS CLI
  // profile), NOT the REST key.
  ATM3_POLYGON_FLATFILES_AWS_PROFILE: z.string().default('massive-flatfiles'),
})

const parsed = envSchema.parse(process.env)

// The database lives inside the data dir unless explicitly overridden, so
// setting ATM3_DATA_DIR alone moves all local data (e.g. to an external
// drive).
export const env = {
  ...parsed,
  ATM3_DUCKDB_PATH:
    parsed.ATM3_DUCKDB_PATH ?? path.join(parsed.ATM3_DATA_DIR, 'atm3.duckdb'),
}

export type Env = typeof env
