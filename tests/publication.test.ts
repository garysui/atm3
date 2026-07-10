import assert from 'node:assert/strict'
import test from 'node:test'
import {
  latestCompletedTradingDate,
  latestPublishedMinuteDate,
} from '../core/publication.ts'

test('daily cutoff is yesterday in ET, not UTC', () => {
  // 2026-07-09 21:00 ET = 2026-07-10 01:00 UTC — the old todayUtc() bug
  // window: UTC has rolled, ET has not.
  const evening = new Date('2026-07-10T01:00:00Z')
  assert.equal(latestCompletedTradingDate(evening), '2026-07-08')

  // Plain afternoon: ET and UTC agree on the calendar date.
  const afternoon = new Date('2026-07-09T18:00:00Z') // 14:00 ET
  assert.equal(latestCompletedTradingDate(afternoon), '2026-07-08')

  // After ET midnight the cutoff advances.
  const lateNight = new Date('2026-07-10T05:00:00Z') // 01:00 ET Jul 10
  assert.equal(latestCompletedTradingDate(lateNight), '2026-07-09')
})

test('minute cutoff respects the ~00:30 ET publication lag', () => {
  // 01:00 ET on Jul 10: yesterday's file may not be out — require Jul 8.
  const beforePublication = new Date('2026-07-10T05:00:00Z')
  assert.equal(latestPublishedMinuteDate(beforePublication), '2026-07-08')

  // 07:00 ET on Jul 10: yesterday's file is comfortably published.
  const afterPublication = new Date('2026-07-10T11:00:00Z')
  assert.equal(latestPublishedMinuteDate(afterPublication), '2026-07-09')

  // Evening of Jul 9 (ET): the Jul 9 file does not exist — require Jul 8.
  const evening = new Date('2026-07-10T01:00:00Z') // 21:00 ET Jul 9
  assert.equal(latestPublishedMinuteDate(evening), '2026-07-08')
})
