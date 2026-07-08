import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'
import { env } from '../server/env.ts'
import { logger } from '../server/log.ts'

export const polygonBaseUrl = 'https://api.polygon.io'

export function requirePolygonApiKey(): string {
  if (!env.POLYGON_API_KEY) {
    throw new Error('POLYGON_API_KEY is not set. Add it to .env (see .env.example).')
  }

  return env.POLYGON_API_KEY
}

export type PolygonResponse = {
  requestUrl: string
  httpStatus: number
  payload: Uint8Array
  body: unknown
}

const maxAttempts = 5
const retryableStatus = new Set([408, 429, 500, 502, 503, 504])

// The API key travels in the Authorization header, never in the URL, so
// request URLs are safe to persist verbatim in raw manifests.
export async function polygonGet(pathOrUrl: string): Promise<PolygonResponse> {
  const requestUrl = pathOrUrl.startsWith('http')
    ? pathOrUrl
    : `${polygonBaseUrl}${pathOrUrl}`
  const apiKey = requirePolygonApiKey()

  for (let attempt = 1; ; attempt++) {
    let response: Response | null = null
    let networkFailure: unknown = null

    try {
      response = await fetch(requestUrl, {
        headers: { authorization: `Bearer ${apiKey}` },
      })
    } catch (error) {
      networkFailure = error
    }

    if (response && !retryableStatus.has(response.status)) {
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 300)
        throw new Error(`Polygon ${response.status} for ${requestUrl}: ${detail}`)
      }

      const payload = new Uint8Array(await response.arrayBuffer())
      let body: unknown

      try {
        body = JSON.parse(new TextDecoder().decode(payload))
      } catch {
        body = null
      }

      return { requestUrl, httpStatus: response.status, payload, body }
    }

    if (attempt >= maxAttempts) {
      if (networkFailure) {
        throw new Error(`Polygon request failed for ${requestUrl}`, {
          cause: networkFailure,
        })
      }

      throw new Error(
        `Polygon ${response?.status} for ${requestUrl} after ${maxAttempts} attempts`,
      )
    }

    const waitMs = Math.min(30_000, 500 * 2 ** (attempt - 1))
    logger.warn(
      { requestUrl, status: response?.status, attempt, waitMs },
      'retrying polygon request',
    )
    await sleep(waitMs)
  }
}

const listEnvelopeSchema = z.object({
  status: z.string().optional(),
  next_url: z.string().optional(),
  results: z.array(z.unknown()).optional(),
})

export type PolygonListPage = PolygonResponse & {
  nextUrl: string | null
  rowCount: number
}

// Iterate a cursor-paginated list endpoint, yielding each page's verbatim
// bytes. The envelope is parsed only to steer pagination.
export async function* polygonListPages(
  firstPathOrUrl: string,
): AsyncGenerator<PolygonListPage> {
  let next: string | null = firstPathOrUrl

  while (next) {
    const response = await polygonGet(next)
    const envelope = listEnvelopeSchema.parse(response.body ?? {})
    next = envelope.next_url ?? null
    yield {
      ...response,
      nextUrl: next,
      rowCount: envelope.results?.length ?? 0,
    }
  }
}

export function cursorFromUrl(url: string): string | null {
  try {
    return new URL(url).searchParams.get('cursor')
  } catch {
    return null
  }
}
