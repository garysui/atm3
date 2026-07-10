import { createApiServer } from './api.ts'
import { env } from './env.ts'
import { logger } from './log.ts'

const server = await createApiServer()

// The write endpoints are unauthenticated by design for a local tool; a
// non-loopback bind exposes expensive pipeline operations to the network.
if (!['127.0.0.1', 'localhost', '::1'].includes(env.ATM3_API_HOST)) {
  logger.warn(
    { host: env.ATM3_API_HOST },
    'API bound beyond loopback: pipeline write endpoints are UNAUTHENTICATED',
  )
}

const httpServer = server.app.listen(env.ATM3_API_PORT, env.ATM3_API_HOST, () => {
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

// Graceful shutdown: stop accepting requests, close the database (flushes
// the WAL), then exit. A second signal or the timeout forces exit.
let shuttingDown = false

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) {
      process.exit(1)
    }

    shuttingDown = true
    logger.info({ signal }, 'shutting down')
    const deadline = setTimeout(() => process.exit(1), 5000)
    deadline.unref()
    httpServer.close(() => {
      server.closeSync()
      process.exit(0)
    })
  })
}
