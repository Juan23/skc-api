import { useRef, useState } from 'react'
import { DataTable } from '../../components/DataTable'
import type { Column } from '../../components/DataTable'
import { DateRangePicker } from '../../components/DateRangePicker'
import { ProductPicker, productLabel } from '../../components/ProductPicker'
import { useApi } from '../../lib/useApi'
import { api } from '../../api/client'
import { endOfDay, formatDate, formatMoney, formatQty, localDate, sumMoney } from '../../lib/format'
import { newTicketId } from '../../lib/tickets'
import { toProperCase } from '../../lib/sku'
import type { InventoryRow, PurchaseLine, PurchaseTicket } from '../../api/types'

// A draft purchase line, already converted to BASE units (grams/pieces). When a
// line is entered "by pack" the pack count and cost-per-pack are converted here,
// exactly as Purchases.cs does, so everything downstream stays in base units.
interface DraftLine {
  key: number
  sku: string
  label: string
  qty: number
  unitCost: number
}

let nextKey = 1

// Office purchases: the report (ticket list + line detail) plus multi-line entry
// and ticket delete. Mirrors the office app's frmPurchases and PurchasesReport.
export function Purchases() {
  const [start, setStart] = useState(localDate(30))
  const [end, setEnd] = useState(localDate())
  const [query, setQuery] = useState(
    `/api/purchases/tickets?start=${localDate(30)}&end=${endOfDay(localDate())}`,
  )
  const [selected, setSelected] = useState<string | null>(null)

  const tickets = useApi<PurchaseTicket[]>(query)
  const lines = useApi<PurchaseLine[]>(selected ? `/api/purchases/${encodeURIComponent(selected)}` : null)
  const catalog = useApi<InventoryRow[]>('/api/inventory')

  // --- entry state -------------------------------------------------------
  const [entryOpen, setEntryOpen] = useState(false)
  const [supplier, setSupplier] = useState('')
  const [date, setDate] = useState(localDate())
  const [draft, setDraft] = useState<DraftLine[]>([])

  const [picked, setPicked] = useState<InventoryRow | null>(null)
  const [qty, setQty] = useState('')
  const [cost, setCost] = useState('')
  const [byPack, setByPack] = useState(false)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  // Reused across a retry so a resubmit after a lost response dedups server-side
  // into a no-op instead of creating the lots twice; cleared on a confirmed
  // success so a genuinely new ticket gets a fresh id. Same contract as the
  // WinForms currentTransactionId.
  const txId = useRef<string | null>(null)

  function load() {
    setSelected(null)
    setQuery(`/api/purchases/tickets?start=${start}&end=${endOfDay(end)}`)
  }

  function resetEntryBar() {
    setPicked(null)
    setQty('')
    setCost('')
    setByPack(false)
  }

  function pick(p: InventoryRow) {
    setPicked(p)
    setByPack(false)
  }

  function addLine() {
    setError('')
    if (!picked) return setError('Choose a product first.')
    const q = Number(qty)
    const c = Number(cost)
    // Whole numbers only, in both modes: base units are an int column, and packs
    // are bought whole (the office app's NumericUpDown is DecimalPlaces=0, so a
    // fractional pack count can't be entered there either).
    if (!Number.isInteger(q) || q <= 0) return setError('Quantity must be a whole number greater than zero.')
    if (!(c >= 0)) return setError('Unit cost cannot be negative.')

    const usePack = byPack && picked.packmultiplier > 1
    // "By pack": qty is a pack count and cost is per-pack; convert to base units
    // the same way Purchases.cs does. The divisibility check runs on the RAW
    // product before rounding (checking the rounded value would always pass): a
    // fractional pack multiplier whose product isn't whole (3 packs x 2.5) is
    // rejected rather than silently rounded, with a small tolerance so binary
    // float dust on an honest whole result doesn't false-positive.
    const rawQty = usePack ? q * picked.packmultiplier : q
    const baseQty = Math.round(rawQty)
    const baseCost = usePack ? c / picked.packmultiplier : c
    if (baseQty <= 0 || Math.abs(rawQty - baseQty) > 1e-6)
      return setError('That pack size does not divide into a whole number of base units.')

    setDraft((d) => [
      ...d,
      { key: nextKey++, sku: picked.sku, label: productLabel(picked), qty: baseQty, unitCost: baseCost },
    ])
    resetEntryBar()
  }

  async function submit() {
    if (draft.length === 0) return
    if (!supplier.trim()) return setError('Enter a supplier.')

    // Embed the picked purchase date in the id (not today), matching Purchases.cs
    // which stamps entryDate - so a backdated receipt's id and stored date agree.
    if (!txId.current) txId.current = newTicketId('PUR', date)
    const body = draft.map((l) => ({
      transactionId: txId.current,
      // Purchase dates are date-only in the office app (dtpDate.Value.Date); send
      // midnight so it binds to the server's DateTime unambiguously.
      date: `${date}T00:00:00`,
      sku: l.sku,
      qty: l.qty,
      unitCost: l.unitCost,
      supplier: toProperCase(supplier),
    }))

    setError('')
    setNotice('')
    setBusy(true)
    try {
      await api.post('/api/purchases', body)
      setNotice(`Recorded purchase ${txId.current} (${draft.length} lines).`)
      txId.current = null // confirmed success -> next ticket gets a fresh id
      setDraft([])
      setSupplier('')
      resetEntryBar()
      setEntryOpen(false)
      tickets.reload()
    } catch (err) {
      // Keep the draft and the tx id so the admin can just hit Submit again.
      setError(err instanceof Error ? err.message : 'Purchase failed.')
    } finally {
      setBusy(false)
    }
  }

  async function remove(t: PurchaseTicket) {
    if (!window.confirm(`Delete purchase ${t.transactionId}? This removes its lots from Office stock.`))
      return
    setError('')
    setNotice('')
    setBusy(true)
    try {
      await api.del(`/api/purchases/${encodeURIComponent(t.transactionId)}`)
      setNotice(`Deleted ${t.transactionId}.`)
      if (selected === t.transactionId) setSelected(null)
      tickets.reload()
    } catch (err) {
      // The server refuses if any of the ticket's stock has already shipped in a
      // delivery - surface that reason rather than a bare failure.
      setError(err instanceof Error ? err.message : 'Delete failed.')
    } finally {
      setBusy(false)
    }
  }

  const draftTotal = sumMoney(draft.map((l) => l.qty * l.unitCost))

  const ticketColumns: Column<PurchaseTicket>[] = [
    { header: 'Date', cell: (t) => formatDate(t.date) },
    { header: 'Ticket', cell: (t) => t.transactionId },
    { header: 'Supplier', cell: (t) => t.supplier || '' },
    { header: 'Total', align: 'right', cell: (t) => formatMoney(t.totalAmount) },
    {
      header: '',
      cell: (t) => (
        <span className="row-actions">
          <button
            className="btn destructive"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation() // don't also select the row for detail view
              void remove(t)
            }}
          >
            Delete
          </button>
        </span>
      ),
    },
  ]

  const lineColumns: Column<PurchaseLine>[] = [
    { header: 'SKU', cell: (l) => l.sku },
    { header: 'Qty', align: 'right', cell: (l) => formatQty(l.qty) },
    { header: 'Unit cost', align: 'right', cell: (l) => formatMoney(l.unitCost) },
    { header: 'Line total', align: 'right', cell: (l) => formatMoney(l.qty * l.unitCost) },
  ]

  const total = tickets.data ? sumMoney(tickets.data.map((t) => t.totalAmount)) : 0

  return (
    <section>
      <h1>Purchases</h1>

      <div className="toolbar">
        <button className="btn primary" onClick={() => setEntryOpen((v) => !v)} disabled={busy}>
          {entryOpen ? 'Close entry' : 'New purchase'}
        </button>
      </div>

      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}

      {entryOpen && (
        <div className="editor">
          <h2>New purchase</h2>
          <div className="toolbar">
            <label className="inline">
              Supplier
              <input value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="Supplier name" />
            </label>
            <label className="inline">
              Date
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
          </div>

          <h3>Add item</h3>
          <div className="toolbar">
            <label className="inline">
              Product
              <ProductPicker catalog={catalog.data ?? []} onPick={pick} disabled={busy} />
            </label>
            <label className="inline">
              {byPack && picked && picked.packmultiplier > 1 ? 'Packs' : 'Qty (base units)'}
              <input
                type="number"
                min={1}
                step={1}
                value={qty}
                onChange={(e) => setQty(e.target.value)}
              />
            </label>
            <label className="inline">
              {byPack && picked && picked.packmultiplier > 1 ? 'Cost per pack' : 'Unit cost'}
              <input
                type="number"
                min={0}
                step="0.01"
                value={cost}
                onChange={(e) => setCost(e.target.value)}
              />
            </label>
            <button className="btn neutral" onClick={addLine} disabled={busy || !picked}>
              Add line
            </button>
          </div>

          {picked && (
            <p className="entry-hint muted">
              Selected: <strong>{productLabel(picked)}</strong>
              {picked.packmultiplier > 1 && (
                <label className="inline checkbox" style={{ display: 'inline-flex', marginLeft: 12 }}>
                  <input type="checkbox" checked={byPack} onChange={(e) => setByPack(e.target.checked)} />
                  Buy by pack ({picked.uom || 'pack'} = {formatQty(picked.packmultiplier)} base units)
                </label>
              )}
            </p>
          )}

          {draft.length > 0 && (
            <div className="table-wrap" style={{ marginTop: 6 }}>
              <table className="data">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th style={{ textAlign: 'right' }}>Qty</th>
                    <th style={{ textAlign: 'right' }}>Unit cost</th>
                    <th style={{ textAlign: 'right' }}>Line total</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {draft.map((l) => (
                    <tr key={l.key}>
                      <td>{l.label}</td>
                      <td style={{ textAlign: 'right' }}>{formatQty(l.qty)}</td>
                      <td style={{ textAlign: 'right' }}>{formatMoney(l.unitCost)}</td>
                      <td style={{ textAlign: 'right' }}>{formatMoney(l.qty * l.unitCost)}</td>
                      <td style={{ textAlign: 'right' }}>
                        <span className="row-actions">
                          <button
                            className="btn destructive"
                            disabled={busy}
                            onClick={() => setDraft((d) => d.filter((x) => x.key !== l.key))}
                          >
                            Remove
                          </button>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="toolbar" style={{ marginTop: 12 }}>
            <span className="muted">
              {draft.length} lines — total {formatMoney(draftTotal)}
            </span>
            <button className="btn primary" onClick={() => void submit()} disabled={busy || draft.length === 0}>
              {busy ? 'Submitting…' : 'Submit purchase'}
            </button>
          </div>
        </div>
      )}

      <DateRangePicker start={start} end={end} onStart={setStart} onEnd={setEnd} onLoad={load} busy={tickets.loading} />
      {tickets.data && (
        <p className="muted">
          {tickets.data.length} tickets, total {formatMoney(total)}
        </p>
      )}
      <DataTable
        columns={ticketColumns}
        rows={tickets.data}
        loading={tickets.loading}
        error={tickets.error}
        rowKey={(t) => t.transactionId}
        onRowClick={(t) => setSelected(t.transactionId)}
        selectedKey={selected}
        empty="No purchases in this range."
      />
      {selected && (
        <>
          <h2>Lines — {selected}</h2>
          <DataTable
            columns={lineColumns}
            rows={lines.data}
            loading={lines.loading}
            error={lines.error}
            rowKey={(l, i) => `${l.sku}-${i}`}
          />
        </>
      )}
    </section>
  )
}
