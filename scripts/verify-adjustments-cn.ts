import { formatTable } from '../core/format.ts'
import { diagnoseCnAdjustments } from '../server/cn-adjustment-diagnostic.ts'
import { openDatabase } from '../server/db.ts'

const db = await openDatabase()

try {
  const report = await diagnoseCnAdjustments(db.connection)
  const comparable = report.coverage.find(
    (row) => row.comparison_class === 'comparable',
  )

  console.log('CN adjustment diagnostic vs BaoStock price-ratio factors\n')
  console.log('Coverage classes')
  console.log(formatTable(report.coverage as never))
  console.log('\nResiduals by action structure (descriptive, not a gate)')
  console.log(formatTable(report.segments as never))
  console.log('\nLargest methodology residuals')
  console.log(formatTable(report.largestResiduals as never))
  console.log('\nInvalid vendor rows')
  console.log(formatTable(report.invalidVendorRows as never))

  if (report.staged.invalidVendorFactorRows > 0) {
    throw new Error(
      `CN adjustment diagnostic found ${report.staged.invalidVendorFactorRows} invalid vendor rows`,
    )
  }
  if (Number(comparable?.events ?? 0) === 0) {
    throw new Error('CN adjustment diagnostic found no comparable events')
  }
} finally {
  db.closeSync()
}
