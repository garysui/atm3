import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const frameLineSchema = z.object({
  seq: z.number().int().positive(),
  request: z.string(),
  frame_b64: z.string(),
})

const doneLineSchema = z.object({
  done: z.literal(true),
  frames: z.number().int().nonnegative(),
  client_version: z.string(),
  login_code: z.string(),
})

export type BaoStockJob = {
  api:
    | 'query_trade_dates'
    | 'query_all_stock'
    | 'query_stock_basic'
    | 'query_history_k_data_plus'
    | 'query_dividend_data'
    | 'query_adjust_factor'
  params: Record<string, string>
}

export type BaoStockProtocolFrame = {
  seq: number
  request: string
  payload: Uint8Array
}

export type BaoStockRelayResult = {
  frames: BaoStockProtocolFrame[]
  clientVersion: string
  loginCode: string
  stderr: string
}

const defaultRelayPath = fileURLToPath(
  new URL('../acquisition/baostock_relay.py', import.meta.url),
)
const defaultPythonPath = fileURLToPath(
  new URL('../acquisition/.venv/bin/python3', import.meta.url),
)

export async function runBaoStockRelay(
  job: BaoStockJob,
  options: { pythonPath?: string; relayPath?: string } = {},
): Promise<BaoStockRelayResult> {
  const pythonPath = path.resolve(
    options.pythonPath ?? process.env.ATM3_CN_PYTHON ?? defaultPythonPath,
  )
  const relayPath = path.resolve(options.relayPath ?? defaultRelayPath)

  if (!existsSync(pythonPath)) {
    throw new Error(
      `BaoStock Python is missing at ${pythonPath}. Run: ` +
        'python3 -m venv acquisition/.venv && ' +
        'acquisition/.venv/bin/python3 -m pip install -r acquisition/requirements.txt',
    )
  }

  return await new Promise((resolve, reject) => {
    const child = spawn(pythonPath, [relayPath], {
      cwd: path.dirname(path.dirname(relayPath)),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      const diagnostic = Buffer.concat(stderr).toString('utf8').trim()
      if (code !== 0) {
        reject(
          new Error(
            `BaoStock relay exited ${code}${diagnostic ? `: ${diagnostic}` : ''}`,
          ),
        )
        return
      }

      try {
        const lines = Buffer.concat(stdout)
          .toString('utf8')
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line) as unknown)
        const done = doneLineSchema.parse(lines.at(-1))
        const frames = lines.slice(0, -1).map((line, index) => {
          const parsed = frameLineSchema.parse(line)
          if (parsed.seq !== index + 1) {
            throw new Error(`BaoStock frame sequence jumped at ${parsed.seq}`)
          }
          return {
            seq: parsed.seq,
            request: parsed.request,
            payload: new Uint8Array(Buffer.from(parsed.frame_b64, 'base64')),
          }
        })

        if (done.frames !== frames.length) {
          throw new Error(
            `BaoStock relay reported ${done.frames} frames, received ${frames.length}`,
          )
        }

        resolve({
          frames,
          clientVersion: done.client_version,
          loginCode: done.login_code,
          stderr: diagnostic,
        })
      } catch (error) {
        reject(error)
      }
    })

    child.stdin.end(JSON.stringify(job))
  })
}
