import { useMemo, useState } from 'react'
import { DataTable } from './DataTable'
import type { Column } from './DataTable'
import { useApi } from '../lib/useApi'
import { formatMoney, formatQty } from '../lib/format'
import type { InventoryRow } from '../api/types'

// Stock on hand at one location. Shared by the office's Branch Stock report and
// the branch's own Stock screen - same endpoint, same columns, only the branch
// differs (and where it comes from: a picker vs the session).
//
// 'Office' is a valid branch here: /api/inventory/branch/Office and /api/inventory
// both report office stock, since the office holds lots like any branch.
export function StockView({ branch }: { branch: string }) {
  const { data, loading, error } = useApi<InventoryRow[]>(
    `/api/inventory/branch/${encodeURIComponent(branch)}`,
  )
  const [search, setSearch] = useState('')
  const [inStockOnly, setInStockOnly] = useState(true)

  const rows = useMemo(() => {
    if (!data) return null
    const term = search.trim().toLowerCase()
    return data.filter((r) => {
      // The endpoint returns the whole catalog with 0 for anything this branch
      // never received, which is a lot of noise at a branch - hence the default.
      if (inStockOnly && r.currentstock === 0) return false
      if (!term) return true
      // Brand + item name only, not SKU (site-wide search rule).
      return r.basename.toLowerCase().includes(term) || (r.brand ?? '').toLowerCase().includes(term)
    })
  }, [data, search, inStockOnly])

  const columns: Column<InventoryRow>[] = [
    { header: 'SKU', cell: (r) => r.sku },
    { header: 'Brand', cell: (r) => r.brand || '' },
    { header: 'Item', cell: (r) => r.basename },
    { header: 'Category', cell: (r) => r.category },
    { header: 'On hand', align: 'right', cell: (r) => formatQty(r.currentstock) },
    {
      header: 'Price',
      align: 'right',
      cell: (r) => (r.price > 0 ? formatMoney(r.price) : <span className="muted">—</span>),
    },
  ]

  return (
    <>
      <div className="toolbar">
        <label className="inline">
          Search
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="brand or item" />
        </label>
        <label className="inline checkbox">
          <input type="checkbox" checked={inStockOnly} onChange={(e) => setInStockOnly(e.target.checked)} />
          Only items with stock
        </label>
        <span className="muted">{rows ? `${rows.length} items` : ''}</span>
      </div>
      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        error={error}
        rowKey={(r) => r.sku}
        empty={inStockOnly ? 'No stock on hand here.' : 'No items match.'}
      />
    </>
  )
}
