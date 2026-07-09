import type { DuckDBConnection } from '@duckdb/node-api'

// Interactive reads run on a small pool of dedicated connections so no two
// queries ever share a connection concurrently — two overlapping streaming
// reads on one DuckDB connection can silently return partial results.
export type ReadPool = {
  run<T>(fn: (connection: DuckDBConnection) => Promise<T>): Promise<T>
  closeSync(): void
}

export function createReadPool(connections: DuckDBConnection[]): ReadPool {
  const idle = [...connections]
  const waiters: Array<(connection: DuckDBConnection) => void> = []

  const acquire = () =>
    new Promise<DuckDBConnection>((resolve) => {
      const next = idle.pop()

      if (next) {
        resolve(next)
      } else {
        waiters.push(resolve)
      }
    })

  const release = (connection: DuckDBConnection) => {
    const waiter = waiters.shift()

    if (waiter) {
      waiter(connection)
    } else {
      idle.push(connection)
    }
  }

  return {
    async run(fn) {
      const connection = await acquire()

      try {
        return await fn(connection)
      } finally {
        release(connection)
      }
    },
    closeSync() {
      for (const connection of connections) {
        connection.closeSync()
      }
    },
  }
}
