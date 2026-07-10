import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  metricsCatalog,
  sessionMetricsCatalog,
} from '../core/metrics-catalog.ts'
import { renderMetricsReference } from '../core/metrics-reference.ts'

// docs/metrics-reference.md is generated from the catalog. This test is the
// evolving contract's enforcement: change the catalog without running
// `npm run docs:metrics` and the gate fails.
test('metrics reference doc is in sync with the catalog', async () => {
  const rendered = renderMetricsReference()
  const onDisk = await readFile(
    new URL('../docs/metrics-reference.md', import.meta.url),
    'utf8',
  )
  assert.equal(onDisk, rendered)

  // Every catalog id appears exactly once, so the page is complete.
  for (const entry of [...metricsCatalog, ...sessionMetricsCatalog]) {
    const occurrences = rendered.split(`\`${entry.id}\` |`).length - 1
    assert.equal(occurrences, 1, entry.id)
  }
})
