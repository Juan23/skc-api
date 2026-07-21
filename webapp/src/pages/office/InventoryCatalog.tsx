import { useMemo, useState } from 'react'
import { DataTable } from '../../components/DataTable'
import type { Column } from '../../components/DataTable'
import { useApi } from '../../lib/useApi'
import { api, ApiError } from '../../api/client'
import { formatMoney, formatQty } from '../../lib/format'
import { generateSku, toProperCase } from '../../lib/sku'
import type { InventoryRow } from '../../api/types'

interface Draft {
  sku: string
  brand: string
  baseName: string
  price: string
}

const emptyDraft = (): Draft => ({ sku: '', brand: '', baseName: '', price: '0' })

// Mirrors ViewProducts + frmAddMasterItem in the office app: the active catalog
// with office stock, plus add / edit / deactivate.
//
// Two things are deliberately NOT edited here: selling price (owner-gated, set on
// the owner's Products & pricing screen) and category / UoM / pack size (also on
// that screen). A newly added product defaults to RawMaterial with pack 1 - the
// owner reclassifies it there if it's something else. Add still sets an initial
// price, matching the office app's Add Item.
export function InventoryCatalog() {
  const { data, loading, error, reload } = useApi<InventoryRow[]>('/api/inventory')
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('')

  const [mode, setMode] = useState<'add' | 'edit' | null>(null)
  const [draft, setDraft] = useState<Draft>(emptyDraft())
  const [skuTouched, setSkuTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState('')
  const [notice, setNotice] = useState('')

  const rows = useMemo(() => {
    if (!data) return null
    const term = search.trim().toLowerCase()
    return data.filter((r) => {
      if (category && r.category !== category) return false
      if (!term) return true
      // Brand + item name only, not SKU (site-wide search rule).
      return r.basename.toLowerCase().includes(term) || (r.brand ?? '').toLowerCase().includes(term)
    })
  }, [data, search, category])

  function startAdd() {
    setMode('add')
    setDraft(emptyDraft())
    setSkuTouched(false)
    setFormError('')
    setNotice('')
  }

  function startEdit(row: InventoryRow) {
    setMode('edit')
    // price is display-only here (the PUT only changes brand/base_name), but keep
    // it in the draft so the field can show the current value.
    setDraft({ sku: row.sku, brand: row.brand ?? '', baseName: row.basename, price: String(row.price) })
    setSkuTouched(true)
    setFormError('')
    setNotice('')
  }

  // In add mode the SKU auto-fills from brand+item until the user edits it by
  // hand (matching GenerateSKU's live regeneration), then leaves it alone.
  function setBrand(v: string) {
    setDraft((d) => ({ ...d, brand: v, sku: mode === 'add' && !skuTouched ? generateSku(v, d.baseName) : d.sku }))
  }
  function setBaseName(v: string) {
    setDraft((d) => ({ ...d, baseName: v, sku: mode === 'add' && !skuTouched ? generateSku(d.brand, v) : d.sku }))
  }

  async function save() {
    setFormError('')
    setNotice('')
    if (!draft.baseName.trim()) return setFormError('Item name is required.')

    setBusy(true)
    try {
      if (mode === 'edit') {
        await api.put(`/api/inventory/${encodeURIComponent(draft.sku)}`, {
          brand: toProperCase(draft.brand),
          baseName: toProperCase(draft.baseName),
        })
        setNotice(`Saved ${draft.sku}.`)
      } else {
        const price = Number(draft.price || '0')
        if (!(price >= 0)) return setFormError('Price cannot be negative.')
        const base = (skuTouched && draft.sku.trim() ? draft.sku : generateSku(draft.brand, draft.baseName))
          .toLowerCase()
          .trim()
        if (!base) return setFormError('Enter a brand or item name so a SKU can be generated.')
        const saved = await addWithUniqueSku(base, toProperCase(draft.brand), toProperCase(draft.baseName), price)
        setNotice(
          saved === base
            ? `Added ${saved}.`
            : `Added ${saved} — a product with SKU "${base}" already existed, so it was auto-numbered. Check it isn't a duplicate.`,
        )
      }
      setMode(null)
      reload()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Save failed.')
    } finally {
      setBusy(false)
    }
  }

  // The generated SKU is a readable stem, not a unique key. On a 409 (Duplicate
  // SKU) append -2, -3, ... until the server accepts one, exactly as the office
  // app's Add Item does. Returns the SKU that stuck.
  async function addWithUniqueSku(base: string, brand: string, baseName: string, price: number): Promise<string> {
    for (let n = 1; n <= 99; n++) {
      const sku = n === 1 ? base : `${base}-${n}`
      try {
        await api.post('/api/inventory', { sku, brand, baseName, price, isActive: true })
        return sku
      } catch (err) {
        // Only a duplicate-SKU conflict is retryable; anything else is a real error.
        if (err instanceof ApiError && err.status === 409) continue
        throw err
      }
    }
    throw new Error('Could not find a free SKU after 99 tries — set one manually.')
  }

  async function deactivate(row: InventoryRow) {
    if (!window.confirm(`Deactivate ${row.sku} — ${row.basename}? It will no longer appear in the catalog.`)) return
    setFormError('')
    setNotice('')
    setBusy(true)
    try {
      await api.patch(`/api/inventory/${encodeURIComponent(row.sku)}/deactivate`)
      setNotice(`Deactivated ${row.sku}.`)
      if (mode === 'edit' && draft.sku === row.sku) setMode(null)
      reload()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Deactivate failed.')
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
    { header: 'Pack', align: 'right', cell: (r) => (r.packmultiplier === 1 ? '' : formatQty(r.packmultiplier)) },
    {
      header: 'Price',
      align: 'right',
      cell: (r) => (r.price > 0 ? formatMoney(r.price) : <span className="muted">not priced</span>),
    },
    { header: 'Office stock', align: 'right', cell: (r) => formatQty(r.currentstock) },
    {
      header: '',
      cell: (r) => (
        <span className="row-actions">
          <button className="btn neutral" disabled={busy} onClick={() => startEdit(r)}>
            Edit
          </button>
          <button className="btn destructive" disabled={busy} onClick={() => void deactivate(r)}>
            Deactivate
          </button>
        </span>
      ),
    },
  ]

  return (
    <section>
      <h1>Inventory catalog</h1>

      <div className="toolbar">
        <button className="btn primary" onClick={startAdd} disabled={busy}>
          Add product
        </button>
      </div>

      {formError && <p className="error">{formError}</p>}
      {notice && <p className="notice">{notice}</p>}

      {mode && (
        <div className="editor">
          <h2>{mode === 'add' ? 'Add product' : `Edit ${draft.sku}`}</h2>
          <div className="toolbar">
            <label className="inline">
              Brand
              <input value={draft.brand} onChange={(e) => setBrand(e.target.value)} placeholder="Optional" />
            </label>
            <label className="inline">
              Item name
              <input value={draft.baseName} onChange={(e) => setBaseName(e.target.value)} />
            </label>
            {mode === 'add' ? (
              <>
                <label className="inline">
                  SKU
                  <input
                    value={draft.sku}
                    onChange={(e) => {
                      setSkuTouched(true)
                      setDraft((d) => ({ ...d, sku: e.target.value }))
                    }}
                    placeholder="auto"
                  />
                </label>
                <label className="inline">
                  Initial price
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={draft.price}
                    onChange={(e) => setDraft((d) => ({ ...d, price: e.target.value }))}
                  />
                </label>
              </>
            ) : (
              <label className="inline">
                SKU
                <input value={draft.sku} disabled />
              </label>
            )}
          </div>
          <p className="entry-hint muted">
            {mode === 'add'
              ? 'New products start as RawMaterial, pack 1. Set category, unit and selling price on the owner’s Products & pricing screen.'
              : 'Only brand and item name change here. Price, category, unit and pack size are set on the owner’s Products & pricing screen.'}
          </p>
          <div className="toolbar">
            <button className="btn primary" onClick={() => void save()} disabled={busy}>
              {busy ? 'Saving…' : mode === 'add' ? 'Add product' : 'Save changes'}
            </button>
            <button className="btn neutral" onClick={() => setMode(null)} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="toolbar">
        <label className="inline">
          Search
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="brand or item" />
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
