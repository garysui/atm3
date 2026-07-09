import { createApiServer } from './api.ts'
import { env } from './env.ts'
import { logger } from './log.ts'

const server = await createApiServer()

server.app.listen(env.ATM3_API_PORT, env.ATM3_API_HOST, () => {
  logger.info(
    {
      host: env.ATM3_API_HOST,
      port: env.ATM3_API_PORT,
      dbPath: server.dbPath,
      mode: 'read-write (single writer + read pool)',
    },
    'api listening',
  )
})
