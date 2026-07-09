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
  POLYGON_API_KEY: z.string().optional(),
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
