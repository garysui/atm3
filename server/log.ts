import { pino } from 'pino'
import { env } from './env.ts'

export const logger = pino({ level: env.ATM3_LOG_LEVEL })
