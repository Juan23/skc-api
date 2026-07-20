import { useState } from 'react'
import { DataTable } from '../../components/DataTable'
import type { Column } from '../../components/DataTable'
import { DateRangePicker } from '../../components/DateRangePicker'
import { useApi } from '../../lib/useApi'
import { endOfDay, formatMoney, formatQty, formatTimestamp, localDate } from '../../lib/format'
import { STOCK_LOCATIONS } from '../../lib/branches'
import type { AdjustmentRow } from '../../api/types'

// Mirrors AdjustmentHistory in the office app: the manual stock-count
// reconciliation log. A negative delta is shrinkage, a positive one a found or
// corrected count - coloured accordingly rather than left as a bare number.
export function AdjustmentHistory() {
  const [start, setStart] = useState(localDate(30))
  const [end, setEnd] = useState(localDate())
  const [branch, setBranch] = useState('')
  const [query, setQuery] = useState<string | null>(
    `/api/inventory/adjustments?start=${localDate(30)}&end=${endOfDay(localDate())}`,
  )

  const { data, loading, error } = useApi<AdjustmentRow[]>(query)

  function load() {
    const branchParam = branch ? `&branch=${encodeURIComponent(branch)}` : ''
    setQuery(`/api/inventory/adjustments?start=${start}&end=${endOfDay(end)}${branchParam}`)
  }

  const columns: Column<AdjustmentRow>[] = [
    // These timestamps are server CURRENT_TIMESTAMP values (UTC), unlike the
    // client-stamped delivery dates. Shown verbatim - see lib/format.ts.
    { header: 'Date', cell: (a) => formatTimestamp(a.date) },
    { header: 'Branch', cell: (a) => a.branch },
    { header: 'SKU', cell: (a) => a.sku },
    // Some catalog rows carry the same text in brand and base_name; joining
    // them blindly renders "Fifo Test Fifo Test".
    {
      header: 'Item',
      cell: (a) =>
        a.brand && a.brand !== a.baseName ? `${a.brand} ${a.baseName ?? ''}`.trim() : (a.baseName ?? ''),
    },
    {
      header: 'Change',
      align: 'right',
      cell: (a) => (
        <span className={a.qtyDelta < 0 ? 'neg' : 'pos'}>
          {a.qtyDelta > 0 ? '+' : ''}
          {formatQty(a.qtyDelta)}
        </span>
      ),
    },
    { header: 'Unit cost', align: 'right', cell: (a) => formatMoney(a.unitCost) },
    { header: 'Reason', cell: (a) => a.reason || '' },
  ]

  return (
    <section>
      <h1>Stock adjustments</h1>
      <DateRangePicker start={start} end={end} onStart={setStart} onEnd={setEnd} onLoad={load} busy={loading}>
        <label className="inline">
          Location
          <select value={branch} onChange={(e) => setBranch(e.target.value)}>
            <option value="">All</option>
            {STOCK_LOCATIONS.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
      </DateRangePicker>
      {data && <p className="muted">{data.length} adjustments</p>}
      <DataTable
        columns={columns}
        rows={data}
        loading={loading}
        error={error}
        rowKey={(a, i) => `${a.date}-${a.sku}-${i}`}
        empty="No adjustments in this range."
      />
    </section>
  )
}
