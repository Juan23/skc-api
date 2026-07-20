import { useMemo, useState } from 'react'
import { DataTable } from '../../components/DataTable'
import type { Column } from '../../components/DataTable'
import { useApi } from '../../lib/useApi'
import { formatMoney, formatQty } from '../../lib/format'
import type { InventoryRow } from '../../api/types'

// Mirrors ViewProducts in the office app: the active catalog with office stock.
// `price > 0` is what makes an item sellable at either POS, so an unpriced row
// is flagged rather than left looking like a normal zero.
export function InventoryCatalog() {
  const { data, loading, error } = useApi<InventoryRow[]>('/api/inventory')
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('')

  const rows = useMemo(() => {
    if (!data) return null
    const term = search.trim().toLowerCase()
    return data.filter((r) => {
      if (category && r.category !== category) return false
      if (!term) return true
      return (
        r.sku.toLowerCase().includes(term) ||
        r.basename.toLowerCase().includes(term) ||
        (r.brand ?? '').toLowerCase().includes(term)
      )
    })
  }, [data, search, category])

  const columns: Column<InventoryRow>[] = [
    { header: 'SKU', cell: (r) => r.sku },
    { header: 'Brand', cell: (r) => r.brand || '' },
    { header: 'Item', cell: (r) => r.basename },
    { header: 'Category', cell: (r) => r.category },
    { header: 'UoM', cell: (r) => r.uom || '' },
    { header: 'Pack', align: 'right', cell: (r) => (r.packmultiplier === 1 ? '' : formatQty(r.packmultiplier)) },
    {
      header: 'Price',
      align: 'right',
      cell: (r) => (r.price > 0 ? formatMoney(r.price) : <span className="muted">not priced</span>),
    },
    { header: 'Office stock', align: 'right', cell: (r) => formatQty(r.currentstock) },
  ]

  return (
    <section>
      <h1>Inventory catalog</h1>
      <div className="toolbar">
        <label className="inline">
          Search
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="SKU, brand or item"
          />
        </label>
        <label className="inline">
          Category
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All</option>
            <option value="RawMaterial">RawMaterial</option>
            <option value="BakedGood">BakedGood</option>
            <option value="DecoratedGood">DecoratedGood</option>
            <option value="Miscellaneous">Miscellaneous</option>
          </select>
        </label>
        <span className="muted">{rows ? `${rows.length} of ${data?.length ?? 0} items` : ''}</span>
      </div>
      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        error={error}
        rowKey={(r) => r.sku}
        empty="No items match."
      />
    </section>
  )
}
