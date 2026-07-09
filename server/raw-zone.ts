import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { z } from 'zod'
import type { DuckDBConnection } from '@duckdb/node-api'
import { env } from './env.ts'

// The .meta.json sidecar written next to every raw payload file. Manifests
// carry all fetch provenance, so raw.fetches is only an index and can be
// rebuilt from disk alone (reindexRawZone).
export const fetchManifestSchema = z.object({
  fetch_id: z.string(),
  run_id: z.string().nullable(),
  source_id: z.string(),
  dataset: z.string(),
  request_url: z.string(),
  request_params: z.record(z.string(), z.unknown()).nullable(),
  market_scope: z.string().nullable(),
  market_date: z.string().nullable(),
  page_cursor: z.string().nullable(),
  http_status: z.number(),
  file_path: z.string(),
  file_bytes: z.number(),
  content_sha256: z.string(),
  row_count: z.number().nullable(),
  fetched_at: z.string(),
})

export type FetchManifest = z.infer<typeof fetchManifestSchema>

export type LandRawFileOptions = {
  connection: DuckDBConnection
  dataDir?: string
  runId?: string | null
  sourceId: string
  dataset: string
  requestUrl: string
  requestParams?: Record<string, unknown> | null
  marketScope?: string | null
  marketDate?: string | null
  pageCursor?: string | null
  httpStatus: number
  relativeFilePath: string
  payload: Uint8Array
  rowCount?: number | null
  // The vendor artifact is already a compressed file (flat files): store and
  // hash the bytes exactly as received, never re-encode.
  storeVerbatim?: boolean
}

// Write one verbatim payload file plus its manifest (temp file + rename so a
// crash never leaves a half-written file), then index it in raw.fetches.
// Payload bytes are stored exactly as received. For REST responses, paths
// ending in .gz are gzipped by us and content_sha256 covers the uncompressed
// payload; with storeVerbatim (vendor flat files) the artifact is written and
// hashed byte-identical.
export async function landRawFile(
  options: LandRawFileOptions,
): Promise<FetchManifest> {
  const dataDir = path.resolve(options.dataDir ?? env.ATM3_DATA_DIR)

  if (!options.relativeFilePath.startsWith('raw/')) {
    throw new Error(
      `Raw files must land under raw/: ${options.relativeFilePath}`,
    )
  }

  const absolutePath = path.join(dataDir, options.relativeFilePath)
  await mkdir(path.dirname(absolutePath), { recursive: true })

  const stored =
    !options.storeVerbatim && options.relativeFilePath.endsWith('.gz')
      ? gzipSync(options.payload)
      : options.payload
  await writeFile(`${absolutePath}.tmp`, stored)
  await rename(`${absolutePath}.tmp`, absolutePath)

  const manifest: FetchManifest = {
    fetch_id: randomUUID(),
    run_id: options.runId ?? null,
    source_id: options.sourceId,
    dataset: options.dataset,
    request_url: options.requestUrl,
    request_params: options.requestParams ?? null,
    market_scope: options.marketScope ?? null,
    market_date: options.marketDate ?? null,
    page_cursor: options.pageCursor ?? null,
    http_status: options.httpStatus,
    file_path: options.relativeFilePath,
    file_bytes: stored.length,
    content_sha256: createHash('sha256').update(options.payload).digest('hex'),
    row_count: options.rowCount ?? null,
    fetched_at: new Date().toISOString(),
  }

  const manifestPath = `${absolutePath}.meta.json`
  await writeFile(`${manifestPath}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`)
  await rename(`${manifestPath}.tmp`, manifestPath)

  await insertFetchRow(options.connection, manifest)

  return manifest
}

// One raw.fetches row per payload file: re-landing a file replaces its row.
export async function insertFetchRow(
  connection: DuckDBConnection,
  manifest: FetchManifest,
): Promise<void> {
  await connection.run('delete from raw.fetches where file_path = $file_path', {
    file_path: manifest.file_path,
  })
  await connection.run(
    `
      insert into raw.fetches (
        fetch_id, run_id, source_id, dataset, request_url, request_params,
        market_scope, market_date, page_cursor, http_status, file_path,
        file_bytes, content_sha256, row_count, fetched_at
      ) values (
        cast($fetch_id as uuid), cast($run_id as uuid), $source_id, $dataset,
        $request_url, cast($request_params as json), $market_scope,
        cast($market_date as date), $page_cursor, $http_status, $file_path,
        $file_bytes, $content_sha256, $row_count,
        cast($fetched_at as timestamptz)
      )
    `,
    {
      fetch_id: manifest.fetch_id,
      run_id: manifest.run_id,
      source_id: manifest.source_id,
      dataset: manifest.dataset,
      request_url: manifest.request_url,
      request_params:
        manifest.request_params === null
          ? null
          : JSON.stringify(manifest.request_params),
      market_scope: manifest.market_scope,
      market_date: manifest.market_date,
      page_cursor: manifest.page_cursor,
      http_status: manifest.http_status,
      file_path: manifest.file_path,
      file_bytes: manifest.file_bytes,
      content_sha256: manifest.content_sha256,
      row_count: manifest.row_count,
      fetched_at: manifest.fetched_at,
    },
  )
}

export async function fetchExists(
  connection: DuckDBConnection,
  filter: {
    sourceId: string
    dataset: string
    marketDate?: string
    filePath?: string
  },
): Promise<boolean> {
  if (filter.filePath) {
    const result = await connection.runAndReadAll(
      'select 1 from raw.fetches where file_path = $file_path limit 1',
      { file_path: filter.filePath },
    )
    return result.getRowObjectsJson().length > 0
  }

  const result = await connection.runAndReadAll(
    `
      select 1
      from raw.fetches
      where source_id = $source_id
        and dataset = $dataset
        and market_date = cast($market_date as date)
      limit 1
    `,
    {
      source_id: filter.sourceId,
      dataset: filter.dataset,
      market_date: filter.marketDate ?? null,
    },
  )

  return result.getRowObjectsJson().length > 0
}

// Remove a partial snapshot subtree (files + index rows). Partial snapshots
// from an interrupted paginated sweep are not facts — a rerun must not leave
// stale trailing pages behind.
export async function clearRawSubtree(
  connection: DuckDBConnection,
  relativeDir: string,
  dataDir?: string,
): Promise<void> {
  if (!relativeDir.startsWith('raw/')) {
    throw new Error(`Not a raw subtree: ${relativeDir}`)
  }

  const absoluteDir = path.join(
    path.resolve(dataDir ?? env.ATM3_DATA_DIR),
    relativeDir,
  )
  await rm(absoluteDir, { recursive: true, force: true })
  await connection.run(
    "delete from raw.fetches where starts_with(file_path, $prefix)",
    { prefix: `${relativeDir.replace(/\/$/, '')}/` },
  )
}

// Rebuild raw.fetches purely from the .meta.json manifests on disk. This is
// the proof that the database is a disposable index over the raw zone.
export async function reindexRawZone(
  connection: DuckDBConnection,
  dataDir?: string,
): Promise<number> {
  const root = path.join(path.resolve(dataDir ?? env.ATM3_DATA_DIR), 'raw')
  let entries: string[] = []

  try {
    entries = (await readdir(root, { recursive: true })) as string[]
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }

  const manifestFiles = entries
    .filter((entry) => entry.endsWith('.meta.json'))
    .sort()

  await connection.run('delete from raw.fetches')

  for (const relativeManifest of manifestFiles) {
    const content = await readFile(path.join(root, relativeManifest), 'utf8')
    const manifest = fetchManifestSchema.parse(JSON.parse(content))
    await insertFetchRow(connection, manifest)
  }

  return manifestFiles.length
}
