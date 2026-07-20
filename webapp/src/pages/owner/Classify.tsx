import { useMemo, useState } from 'react'
import { DataTable } from '../../components/DataTable'
import type { Column } from '../../components/DataTable'
import { useApi } from '../../lib/useApi'
import { api } from '../../api/client'
import { formatMoney, formatQty } from '../../lib/format'
import type { InventoryRow } from '../../api/types'

const CATEGORIES: InventoryRow['category'][] = [
  'RawMaterial',
  'BakedGood',
  'DecoratedGood',
  'Miscellaneous',
]

// Product classification and pricing. This single screen spans BOTH server
// gates, deliberately:
//   - category / UoM / pack multiplier -> PUT .../classification, office-gated
//   - selling price                    -> PUT .../price, owner-gated (stricter)
// Owner accounts pass both, but only from an owner device, so the whole screen
// 403s from the office PC even when signed in as the owner. The price half
// would 403 there for an Office user too.
export function Classify() {
  const { data, loading, error, reload } = useApi<InventoryRow[]>('/api/inventory')
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<InventoryRow | null>(null)
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [notice, setNotice] = useState('')

  const rows = useMemo(() => {
    if (!data) return null
    const term = search.trim().toLowerCase()
    if (!term) return data
    return data.filter(
      (r) =>
        r.sku.toLowerCase().includes(term) ||
        r.basename.toLowerCase().includes(term) ||
        (r.brand ?? '').toLowerCase().includes(term),
    )
  }, [data, search])

  function startEdit(row: InventoryRow) {
    setEditing(row.sku)
    setDraft({ ...row })
    setSaveError('')
    setNotice('')
  }

  async function save() {
    if (!draft) return
    const original = data?.find((p) => p.sku === draft.sku)
    if (!original) return
    if (draft.packmultiplier <= 0) return setSaveError('Pack size must be greater than zero.')
    if (draft.price < 0) return setSaveError('Price cannot be negative.')

    const changedClassification =
      draft.category !== original.category ||
      (draft.uom ?? '') !== (original.uom ?? '') ||
      draft.packmultiplier !== original.packmultiplier
    const changedPrice = draft.price !== original.price

    setSaveError('')
    setNotice('')
    setBusy(true)
    // These are two calls behind two different gates, so a half-save is a real
    // outcome, not a theoretical one: the price endpoint is owner-gated while
    // classification is only office-gated. Track what landed so the error can
    // say so - a bare "restricted to the owner's device" reads as if nothing
    // saved, when the category/UoM/pack change already committed.
    let classificationSaved = false
    try {
      // Send all three fields together: the endpoint's UPDATE has no COALESCE,
      // so omitting uom or packMultiplier would blank them rather than leave
      // them alone. Skipping the call entirely when nothing changed also keeps
      // an Office user off the office gate for a price-only edit.
      if (changedClassification) {
        await api.put(`/api/inventory/${encodeURIComponent(draft.sku)}/classification`, {
          category: draft.category,
          uom: draft.uom?.trim() ? draft.uom.trim() : null,
          packMultiplier: draft.packmultiplier,
        })
        classificationSaved = true
      }

      if (changedPrice) {
        await api.put(`/api/inventory/${encodeURIComponent(draft.sku)}/price`, { price: draft.price })
      }

      if (!changedClassification && !changedPrice) {
        setNotice('Nothing changed.')
      } else {
        setNotice(`Saved ${draft.sku}.`)
        setEditing(null)
        reload()
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Save failed.'
      setSaveError(
        classificationSaved
          ? `Category, unit and pack size were saved. The price change failed: ${message}`
          : message,
      )
      reload() // a partial save may have landed; show what's actually stored
    } finally {
      setBusy(false)
    }
  }

  const columns: Column<InventoryRow>[] = [
    { header: 'SKU', cell: (r) => r.sku },
    { header: 'Brand', cell: (r) => r.brand || '' },
    { header: 'Item', cell: (r) => r.basename },
    { header: 'Category', cell: (r) => r.category },
    { header: 'UoM', cell: (r) => r.uom || '' },
    { header: 'Pack', align: 'right', cell: (r) => formatQty(r.packmultiplier) },
    {
      header: 'Price',
      align: 'right',
      cell: (r) => (r.price > 0 ? formatMoney(r.price) : <span className="muted">not sold</span>),
    },
    {
      header: '',
      cell: (r) => (
        <button className="btn neutral" disabled={busy} onClick={() => startEdit(r)}>
          Edit
        </button>
      ),
    },
  ]

  return (
    <section>
      <h1>Products &amp; pricing</h1>
      <p className="muted">
        A product is sellable when its price is above zero — leave it at zero for things the counter
        should never offer (chiffon, for instance, is a baked good but only an intermediary). Each POS
        additionally filters by category on its own side.
      </p>

      <div className="toolbar">
        <label className="inline">
          Search
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="SKU, brand or item"
          />
        </label>
        <span className="muted">{rows ? `${rows.length} of ${data?.length ?? 0} items` : ''}</span>
      </div>

      {saveError && <p className="error">{saveError}</p>}
      {notice && <p className="notice">{notice}</p>}

      {draft && editing && (
        <div className="editor">
          <h2>
            {draft.sku} — {draft.basename}
          </h2>
          <div className="toolbar">
            <label className="inline">
              Category
              <select
                value={draft.category}
                onChange={(e) =>
                  setDraft({ ...draft, category: e.target.value as InventoryRow['category'] })
                }
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label className="inline">
              Unit of measure
              <input
                value={draft.uom ?? ''}
                onChange={(e) => setDraft({ ...draft, uom: e.target.value })}
                placeholder="e.g. Sack (25kg)"
              />
            </label>
            <label className="inline">
              Base units per pack
              <input
                type="number"
                min={1}
                step="any"
                value={draft.packmultiplier}
                onChange={(e) => setDraft({ ...draft, packmultiplier: Number(e.target.value) })}
              />
            </label>
            <label className="inline">
              Selling price
              <input
                type="number"
                min={0}
                step="0.01"
                value={draft.price}
                onChange={(e) => setDraft({ ...draft, price: Number(e.target.value) })}
              />
            </label>
          </div>
          <p className="muted">
            Pack size is the purchase-time conversion only — a “Sack (25kg)” holding 25000 grams means
            buying one pack credits 25000 base units. Stock, recipes and production always stay in base
            units.
          </p>
          <div className="toolbar">
            <button className="btn primary" onClick={() => void save()} disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button className="btn neutral" onClick={() => setEditing(null)} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        error={error}
        rowKey={(r) => r.sku}
        selectedKey={editing}
        empty="No items match."
      />
    </section>
  )
}
