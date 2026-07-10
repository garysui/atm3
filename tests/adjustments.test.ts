import assert from 'node:assert/strict'
import test from 'node:test'
import {
  stockDividendFactor,
  stockDividendVolumeFactor,
} from '../core/adjustments.ts'

test('stock dividend factors mirror the computed SQL', () => {
  assert.equal(stockDividendFactor(0.2, 0.3), 1 / 1.5)
  assert.equal(stockDividendVolumeFactor(0.2, 0.3), 1.5)
})
