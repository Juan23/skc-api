import { useMemo, useState } from 'react'
import { DataTable } from '../../components/DataTable'
import type { Column } from '../../components/DataTable'
import { useApi } from '../../lib/useApi'
import { api, ApiError } from '../../api/client'
import { formatMoney, formatQty } from '../../lib/format'
import { generateSku, toProperCase } from '../../lib/sku'
import type { InventoryRow } from '../../api/types'

const CATEGORIES: InventoryRow['category'][] = [
  'RawMaterial',
  'BakedGood',
  'DecoratedGood',
  'Miscellaneous',
]

// Category quick-filter for the list. 'All' is the default; the rest mirror
// CATEGORIES so every category is filterable, with readable labels.
type CategoryFilter = InventoryRow['category'] | 'All'
const CATEGORY_FILTERS: { value: CategoryFilter; label: string }[] = [
  { value: 'All', label: 'All' },
  { value: 'RawMaterial', label: 'Raw material' },
  { value: 'BakedGood', label: 'Baked good' },
  { value: 'DecoratedGood', label: 'Decorated good' },
  { value: 'Miscellaneous', label: 'Misc' },
]

interface AddDraft {
  sku: string
  brand: string
  baseName: string
  category: InventoryRow['category']
  uom: string
  packMultiplier: string
  price: string
}

const emptyAddDraft = (): AddDraft => ({
  sku: '',
  brand: '',
  baseName: '',
  category: 'RawMaterial',
  uom: '',
  packMultiplier: '1',
  price: '0',
})

// Product classification and pricing. This single screen spans BOTH server
// gates, deliberately:
//   - category / UoM / pack multiplier -> PUT .../classification, office-gated
//   - selling price                    -> PUT .../price, owner-gated (stricter)
// Owner accounts pass both, but only from an owner device, so the whole screen
// 403s from the office PC even when signed in as the owner. The price half
// would 403 there for an Office user too.
//
// Add product lives here too (not just the office catalog screen): the owner can
// create a product AND set its category / UoM / pack / price in one pass, instead
// of adding it in the office catalog and then coming here to classify and price
// it. It reuses the same two office-gated endpoints - POST /api/inventory (which
// also sets the initial price) then PUT .../classification - which both pass from
// an owner device. The office catalog's simpler Add (RawMaterial, pack 1) stays
// for office staff who aren't the owner.
export function Classify() {
  const { data, loading, error, reload } = useApi<InventoryRow[]>('/api/inventory')
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('All')
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<InventoryRow | null>(null)
  const [adding, setAdding] = useState(false)
  const [addDraft, setAddDraft] = useState<AddDraft>(emptyAddDraft())
  const [skuTouched, setSkuTouched] = useState(false)
  // Set once the POST half of an add succeeds. It survives a failed classification
  // PUT so a retry re-issues only the (idempotent) PUT against this SKU instead of
  // POSTing again - a second POST would 409, auto-number, and orphan the first row
  // as an unclassified duplicate.
  const [pendingSku, setPendingSku] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [notice, setNotice] = useState('')

  const rows = useMemo(() => {
    if (!data) return null
    const term = search.trim().toLowerCase()
    return data.filter((r) => {
      if (categoryFilter !== 'All' && r.category !== categoryFilter) return false
      if (!term) return true
      // Brand + item name only, not SKU (site-wide search rule).
      return r.basename.toLowerCase().includes(term) || (r.brand ?? '').toLowerCase().includes(term)
    })
  }, [data, search, categoryFilter])

  function startEdit(row: InventoryRow) {
    setAdding(false)
    setEditing(row.sku)
    setDraft({ ...row })
    setSaveError('')
    setNotice('')
  }

  function startAdd() {
    setEditing(null)
    setDraft(null)
    setAdding(true)
    setAddDraft(emptyAddDraft())
    setSkuTouched(false)
    setPendingSku(null)
    setSaveError('')
    setNotice('')
  }

  function cancelAdd() {
    setAdding(false)
    setPendingSku(null)
  }

  // In add mode the SKU auto-fills from brand+item until the user edits it by
  // hand (mirrors the office catalog's Add), then leaves it alone.
  function setAddBrand(v: string) {
    setAddDraft((d) => ({ ...d, brand: v, sku: skuTouched ? d.sku : generateSku(v, d.baseName) }))
  }
  function setAddBaseName(v: string) {
    setAddDraft((d) => ({ ...d, baseName: v, sku: skuTouched ? d.sku : generateSku(d.brand, v) }))
  }

  async function saveAdd() {
    setSaveError('')
    setNotice('')
    if (!addDraft.baseName.trim()) return setSaveError('Item name is required.')
    const price = Number(addDraft.price || '0')
    if (!(price >= 0)) return setSaveError('Price cannot be negative.')
    const pack = Number(addDraft.packMultiplier || '1')
    if (!(pack > 0)) return setSaveError('Pack size must be greater than zero.')
    const base = (skuTouched && addDraft.sku.trim() ? addDraft.sku : generateSku(addDraft.brand, addDraft.baseName))
      .toLowerCase()
      .trim()
    if (!base) return setSaveError('Enter a brand or item name so a SKU can be generated.')

    setBusy(true)
    // Two office-gated calls, so a half-create is a real outcome: POST creates the
    // product (as RawMaterial, pack 1, with the price) and the classification PUT
    // then applies category/UoM/pack. If the PUT fails after the POST succeeded,
    // `pendingSku` holds the created SKU so this retry skips straight to the PUT -
    // re-POSTing would 409, auto-number, and leave the first row behind as an
    // unclassified duplicate.
    let createdSku = pendingSku
    try {
      if (!createdSku) {
        createdSku = await addWithUniqueSku(base, toProperCase(addDraft.brand), toProperCase(addDraft.baseName), price)
        setPendingSku(createdSku)
      }
      const uom = addDraft.uom.trim()
      // Only touch classification when it differs from the POST defaults - skips a
      // needless call for a plain RawMaterial, pack-1 add.
      if (addDraft.category !== 'RawMaterial' || uom || pack !== 1) {
        await api.put(`/api/inventory/${encodeURIComponent(createdSku)}/classification`, {
          category: addDraft.category,
          uom: uom ? uom : null,
          packMultiplier: pack,
        })
      }
      setNotice(
        createdSku === base
          ? `Added ${createdSku}.`
          : `Added ${createdSku} — a product with SKU "${base}" already existed, so it was auto-numbered. Check it isn't a duplicate.`,
      )
      setPendingSku(null)
      setAdding(false)
      reload()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Save failed.'
      setSaveError(
        createdSku
          ? `${createdSku} was created as RawMaterial (pack 1) with the price, but setting its category, unit and pack size failed: ${message} — click “Add product” to retry (it won’t create a duplicate), or Cancel and finish it in the edit row below.`
          : message,
      )
      reload() // the product may have been created; show what's actually stored
    } finally {
      setBusy(false)
    }
  }

  // The generated SKU is a readable stem, not a unique key. On a 409 (Duplicate
  // SKU) append -2, -3, ... until the server accepts one, exactly as the office
  // catalog's Add does. Returns the SKU that stuck.
  async function addWithUniqueSku(base: string, brand: string, baseName: string, price: number): Promise<string> {
    for (let n = 1; n <= 99; n++) {
      const sku = n === 1 ? base : `${base}-${n}`
      try {
        await api.post('/api/inventory', { sku, brand, baseName, price, isActive: true })
        return sku
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) continue
        throw err
      }
    }
    throw new Error('Could not find a free SKU after 99 tries — set one manually.')
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
        <button className="btn primary" onClick={startAdd} disabled={busy}>
          Add product
        </button>
      </div>

      {saveError && <p className="error">{saveError}</p>}
      {notice && <p className="notice">{notice}</p>}

      {adding && (
        <div className="editor">
          <h2>Add product</h2>
          <div className="toolbar">
            <label className="inline">
              Brand
              <input value={addDraft.brand} onChange={(e) => setAddBrand(e.target.value)} placeholder="Optional" />
            </label>
            <label className="inline">
              Item name
              <input value={addDraft.baseName} onChange={(e) => setAddBaseName(e.target.value)} />
            </label>
            <label className="inline">
              SKU
              <input
                value={addDraft.sku}
                onChange={(e) => {
                  setSkuTouched(true)
                  setAddDraft((d) => ({ ...d, sku: e.target.value }))
                }}
                placeholder="auto"
              />
            </label>
          </div>
          <div className="toolbar">
            <label className="inline">
              Category
              <select
                value={addDraft.category}
                onChange={(e) =>
                  setAddDraft((d) => ({ ...d, category: e.target.value as InventoryRow['category'] }))
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
                value={addDraft.uom}
                onChange={(e) => setAddDraft((d) => ({ ...d, uom: e.target.value }))}
                placeholder="e.g. Sack (25kg)"
              />
            </label>
            <label className="inline">
              Base units per pack
              <input
                type="number"
                min={1}
                step="any"
                value={addDraft.packMultiplier}
                onChange={(e) => setAddDraft((d) => ({ ...d, packMultiplier: e.target.value }))}
              />
            </label>
            <label className="inline">
              Selling price
              <input
                type="number"
                min={0}
                step="0.01"
                value={addDraft.price}
                onChange={(e) => setAddDraft((d) => ({ ...d, price: e.target.value }))}
              />
            </label>
          </div>
          <p className="entry-hint muted">
            Leave the price at zero for anything the counter shouldn’t sell. Pack size is the
            purchase-time conversion only — everything downstream stays in base units.
          </p>
          <div className="toolbar">
            <button className="btn primary" onClick={() => void saveAdd()} disabled={busy}>
              {busy ? 'Saving…' : 'Add product'}
            </button>
            <button className="btn neutral" onClick={cancelAdd} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      )}

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

      <div className="toolbar" style={{ flexWrap: 'wrap' }}>
        {CATEGORY_FILTERS.map((f) => (
          <button
            key={f.value}
            className={`btn ${categoryFilter === f.value ? 'primary' : 'neutral'}`}
            onClick={() => setCategoryFilter(f.value)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="toolbar">
        <label className="inline">
          Search
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="brand or item"
          />
        </label>
        <span className="muted">{rows ? `${rows.length} of ${data?.length ?? 0} items` : ''}</span>
      </div>

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
