import { useState } from 'react'
import { DataTable } from './DataTable'
import type { Column } from './DataTable'
import { DateRangePicker } from './DateRangePicker'
import { useApi } from '../lib/useApi'
import { endOfDay, formatMoney, formatQty, formatTimestamp, localDate, sumMoney } from '../lib/format'
import type { ProductionBatch } from '../api/types'

// Baking and decorating batches for one branch. Shared by the branch's own
// Production screen and the office's Production report - same endpoint and
// columns, only where the branch comes from differs (session vs picker).
//
// Both kinds of batch come back from the same endpoint: a decorating recipe is
// just one whose inputs happen to include a BakedGood, so there is no "kind"
// column to split on here.
export function ProductionView({ branch }: { branch: string }) {
  const [start, setStart] = useState(localDate(30))
  const [end, setEnd] = useState(localDate())
  const [query, setQuery] = useState<string | null>(
    `/api/production?branch=${encodeURIComponent(branch)}&start=${localDate(30)}&end=${endOfDay(localDate())}`,
  )

  const { data, loading, error } = useApi<ProductionBatch[]>(query)

  function load() {
    setQuery(`/api/production?branch=${encodeURIComponent(branch)}&start=${start}&end=${endOfDay(end)}`)
  }

  const columns: Column<ProductionBatch>[] = [
    { header: 'Date', cell: (b) => formatTimestamp(b.date) },
    { header: 'Batch', cell: (b) => b.transactionId },
    // recipeName comes from a LEFT JOIN, so it is null for a batch whose recipe
    // row was later removed - fall back to the id rather than a blank cell.
    { header: 'Recipe', cell: (b) => b.recipeName || `#${b.recipeId}` },
    { header: 'Staff', cell: (b) => b.staffName || '' },
    { header: '×', align: 'right', cell: (b) => formatQty(b.batchMultiplier) },
    { header: 'Output SKU', cell: (b) => b.outputSku },
    { header: 'Made', align: 'right', cell: (b) => formatQty(b.outputQty) },
    { header: 'Input cost', align: 'right', cell: (b) => formatMoney(b.totalInputCost) },
  ]

  return (
    <>
      <DateRangePicker start={start} end={end} onStart={setStart} onEnd={setEnd} onLoad={load} busy={loading} />
      {data && (
        <p className="muted">
          {data.length} batches, input cost {formatMoney(sumMoney(data.map((b) => b.totalInputCost)))}
        </p>
      )}
      <DataTable
        columns={columns}
        rows={data}
        loading={loading}
        error={error}
        rowKey={(b) => b.transactionId}
        empty="No production in this range."
      />
    </>
  )
}
