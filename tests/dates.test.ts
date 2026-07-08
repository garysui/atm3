import assert from 'node:assert/strict'
import test from 'node:test'
import {
  addDays,
  addYears,
  isWeekend,
  weekdaysBetween,
} from '../core/dates.ts'

test('addDays crosses month and year boundaries', () => {
  assert.equal(addDays('2026-07-08', 1), '2026-07-09')
  assert.equal(addDays('2026-12-31', 1), '2027-01-01')
  assert.equal(addDays('2026-03-01', -1), '2026-02-28')
})

test('addYears handles leap day by rolling forward', () => {
  assert.equal(addYears('2026-07-08', -2), '2024-07-08')
  assert.equal(addYears('2024-02-29', 1), '2025-03-01')
})

test('isWeekend', () => {
  assert.equal(isWeekend('2026-07-04'), true) // Saturday
  assert.equal(isWeekend('2026-07-05'), true) // Sunday
  assert.equal(isWeekend('2026-07-06'), false) // Monday
})

test('weekdaysBetween is inclusive and skips weekends', () => {
  assert.deepEqual(weekdaysBetween('2026-07-02', '2026-07-07'), [
    '2026-07-02',
    '2026-07-03',
    '2026-07-06',
    '2026-07-07',
  ])
  assert.deepEqual(weekdaysBetween('2026-07-04', '2026-07-05'), [])
  assert.throws(() => weekdaysBetween('2026-07-08', '2026-07-07'))
})
