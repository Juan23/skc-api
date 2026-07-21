import { useState } from 'react'
import { DataTable } from '../../components/DataTable'
import type { Column } from '../../components/DataTable'
import { DateRangePicker } from '../../components/DateRangePicker'
import { ProductPicker, productLabel } from '../../components/ProductPicker'
import { useApi } from '../../lib/useApi'
import { api } from '../../api/client'
import { endOfDay, formatMoney, formatQty, formatTimestamp, localDate } from '../../lib/format'
import { STOCK_LOCATIONS } from '../../lib/branches'
import type { AdjustmentRow, InventoryRow } from '../../api/types'

// Mirrors AdjustmentHistory + the office app's stock-count reconciliation: the
// log below, plus an entry panel that sets a SKU's on-hand count at a location to
// a physical count. The server computes the delta (new count minus current) and
// FIFO-removes shrinkage or credits a found lot - this screen just supplies the
// count, matching POST /api/inventory/{sku}/adjust.
export function AdjustmentHistory() {
  const [start, setStart] = useState(localDate(30))
  const [end, setEnd] = useState(localDate())
  const [branch, setBranch] = useState('')
  const [query, setQuery] = useState<string | null>(
    `/api/inventory/adjustments?start=${localDate(30)}&end=${endOfDay(localDate())}`,
  )

  const { data, loading, error, reload } = useApi<AdjustmentRow[]>(query)

  // --- entry state -------------------------------------------------------
  const [open, setOpen] = useState(false)
  const [location, setLocation] = useState<string>('Office')
  // Catalog scoped to the chosen location so the "current" stock shown is that
  // location's, not always Office's (branches hold their own credited lots).
  const catalog = useApi<InventoryRow[]>(
    location === 'Office' ? '/api/inventory' : `/api/inventory/branch/${encodeURIComponent(location)}`,
  )
  const [picked, setPicked] = useState<InventoryRow | null>(null)
  const [newCount, setNewCount] = useState('')
  const [unitCost, setUnitCost] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState('')
  const [notice, setNotice] = useState('')

  function loadHistory() {
    const branchParam = branch ? `&branch=${encodeURIComponent(branch)}` : ''
    setQuery(`/api/inventory/adjustments?start=${start}&end=${endOfDay(end)}${branchParam}`)
  }

  const countNum = Number(newCount)
  const delta = picked && newCount !== '' && Number.isInteger(countNum) ? countNum - picked.currentstock : null

  async function submit() {
    setFormError('')
    setNotice('')
    if (!picked) return setFormError('Choose a product.')
    if (newCount === '' || !Number.isInteger(countNum) || countNum < 0)
      return setFormError('New count must be a whole number of zero or more.')
    if (!reason.trim()) return setFormError('Enter a reason for the adjustment.')

    const body = {
      newCount: countNum,
      // Only meaningful when the count is HIGHER than the system (a found lot needs
      // a cost); ignored by the server on shrinkage. Blank -> null -> server falls
      // back to the SKU's most recent cost.
      unitCost: unitCost.trim() ? Number(unitCost) : null,
      reason: reason.trim(),
      branch: location,
    }
    setBusy(true)
    try {
      await api.post(`/api/inventory/${encodeURIComponent(picked.sku)}/adjust`, body)
      setNotice(
        delta === 0
          ? `No discrepancy for ${picked.sku} — nothing changed.`
          : `Adjusted ${picked.sku} at ${location} to ${formatQty(countNum)} (${delta! > 0 ? '+' : ''}${formatQty(delta!)}).`,
      )
      setPicked(null)
      setNewCount('')
      setUnitCost('')
      setReason('')
      catalog.reload() // stock changed; refresh the picker's "current" figure
      reload() // and the history below
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Adjustment failed.')
    } finally {
      setBusy(false)
    }
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

      <div className="toolbar">
        <button className="btn primary" onClick={() => setOpen((v) => !v)} disabled={busy}>
          {open ? 'Close entry' : 'New adjustment'}
        </button>
      </div>

      {formError && <p className="error">{formError}</p>}
      {notice && <p className="notice">{notice}</p>}

      {open && (
        <div className="editor">
          <h2>Set a physical count</h2>
          <div className="toolbar">
            <label className="inline">
              Location
              <select
                value={location}
                onChange={(e) => {
                  setLocation(e.target.value)
                  setPicked(null) // its stock figure belongs to the old location
                }}
              >
                {STOCK_LOCATIONS.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </label>
            <label className="inline">
              Product
              <ProductPicker catalog={catalog.data ?? []} onPick={setPicked} disabled={busy} />
            </label>
            <label className="inline">
              New count
              <input type="number" min={0} step={1} value={newCount} onChange={(e) => setNewCount(e.target.value)} />
            </label>
            <label className="inline">
              Unit cost (if found)
              <input
                type="number"
                min={0}
                step="0.01"
                value={unitCost}
                onChange={(e) => setUnitCost(e.target.value)}
                placeholder="optional"
              />
            </label>
            <label className="inline">
              Reason
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. physical count" />
            </label>
            <button className="btn primary" onClick={() => void submit()} disabled={busy || !picked}>
              {busy ? 'Saving…' : 'Apply'}
            </button>
          </div>
          {picked && (
            <p className="entry-hint muted">
              <strong>{productLabel(picked)}</strong> — system shows {formatQty(picked.currentstock)} at {location}
              {delta !== null && delta !== 0 && (
                <>
                  {'. '}This records{' '}
                  <span className={delta < 0 ? 'neg' : 'pos'}>
                    {delta > 0 ? '+' : ''}
                    {formatQty(delta)}
                  </span>
                  .
                </>
              )}
              {delta === 0 && '. No discrepancy — this will be a no-op.'}
            </p>
          )}
        </div>
      )}

      <DateRangePicker start={start} end={end} onStart={setStart} onEnd={setEnd} onLoad={loadHistory} busy={loading}>
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
