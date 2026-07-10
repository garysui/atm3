import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { renderMetricsReference } from '../core/metrics-reference.ts'

const target = fileURLToPath(
  new URL('../docs/metrics-reference.md', import.meta.url),
)
await writeFile(target, renderMetricsReference())
console.log(`wrote ${target}`)
