import 'dotenv/config'
import { z } from 'zod'

const envSchema = z.object({
  ATM3_DUCKDB_PATH: z.string().default('data/atm3.duckdb'),
  ATM3_DATA_DIR: z.string().default('data'),
  ATM3_LOG_LEVEL: z.string().default('info'),
})

export type Env = z.infer<typeof envSchema>

export const env: Env = envSchema.parse(process.env)
