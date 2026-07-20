import { useState } from 'react'
import { DataTable } from '../../components/DataTable'
import type { Column } from '../../components/DataTable'
import { DateRangePicker } from '../../components/DateRangePicker'
import { useApi } from '../../lib/useApi'
import { endOfDay, formatMoney, formatQty, formatTimestamp, localDate, sumMoney } from '../../lib/format'
import { useAuth } from '../../auth/AuthContext'
import type { ProductionBatch } from '../../api/types'

// Mirrors frmProductionHistory in the branch app: baking and decorating batches
// this branch has recorded. Both kinds come back from the same endpoint - a
// decorating recipe is just one whose inputs include a BakedGood.
export function ProductionHistory() {
  const { user } = useAuth()
  const branch = user?.branchName ?? ''
  const [start, setStart] = useState(localDate(30))
  const [end, setEnd] = useState(localDate())
  const [query, setQuery] = useState<string | null>(
    branch
      ? `/api/production?branch=${encodeURIComponent(branch)}&start=${localDate(30)}&end=${endOfDay(localDate())}`
      : null,
  )

  const { data, loading, error } = useApi<ProductionBatch[]>(query)

  function load() {
    setQuery(`/api/production?branch=${encodeURIComponent(branch)}&start=${start}&end=${endOfDay(end)}`)
  }

  const columns: Column<ProductionBatch>[] = [
    { header: 'Date', cell: (b) => formatTimestamp(b.date) },
    { header: 'Batch', cell: (b) => b.transactionId },
    { header: 'Recipe', cell: (b) => b.recipeName || `#${b.recipeId}` },
    { header: 'Staff', cell: (b) => b.staffName || '' },
    { header: '×', align: 'right', cell: (b) => formatQty(b.batchMultiplier) },
    { header: 'Output SKU', cell: (b) => b.outputSku },
    { header: 'Made', align: 'right', cell: (b) => formatQty(b.outputQty) },
    { header: 'Input cost', align: 'right', cell: (b) => formatMoney(b.totalInputCost) },
  ]

  if (!branch) return <p className="muted">This account isn't tied to a branch.</p>

  return (
    <section>
      <h1>Production — {branch}</h1>
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
    </section>
  )
}
