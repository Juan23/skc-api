import { useMemo, useRef, useState } from 'react'
import { DataTable } from '../../components/DataTable'
import type { Column } from '../../components/DataTable'
import { DateRangePicker } from '../../components/DateRangePicker'
import { ProductPicker, productLabel } from '../../components/ProductPicker'
import { useApi } from '../../lib/useApi'
import { api } from '../../api/client'
import { endOfDay, formatDate, formatMoney, formatQty, localDate, localTimestamp, sumMoney } from '../../lib/format'
import { newTicketId } from '../../lib/tickets'
import { BRANCHES } from '../../lib/branches'
import { REQUESTERS } from '../../lib/requesters'
import type { DeliveryLine, DeliveryTicket, InventoryRow } from '../../api/types'

interface DraftLine {
  key: number
  sku: string
  label: string
  qty: number
}

let nextKey = 1

// Office deliveries: the report (ticket list + line detail) plus create, delete
// (InTransit only) and edit-ticket. Mirrors frmDelivery and ViewDeliveries.
//
// Edit is a delete-then-recreate, exactly as the WinForms "amend" is: the
// original ticket is deleted at submit time (not when editing opens), so backing
// out leaves it untouched, and the replacement is a brand-new InTransit ticket
// the branch re-accepts. Only an InTransit ticket can be edited or deleted; once
// a branch accepts, its stock has moved and the ticket is immutable.
export function Deliveries() {
  const [start, setStart] = useState(localDate(30))
  const [end, setEnd] = useState(localDate())
  const [branch, setBranch] = useState('')
  const [query, setQuery] = useState(
    `/api/deliveries/tickets?start=${localDate(30)}&end=${endOfDay(localDate())}`,
  )
  const [selected, setSelected] = useState<string | null>(null)

  const tickets = useApi<DeliveryTicket[]>(query)
  const lines = useApi<DeliveryLine[]>(selected ? `/api/deliveries/${encodeURIComponent(selected)}` : null)
  const catalog = useApi<InventoryRow[]>('/api/inventory')

  // Line rows carry only the SKU; staff read by item name, not SKU. Join against
  // the catalog for the brand and base name. A deactivated SKU won't be in
  // /api/inventory (active-only), so fall back to the SKU rather than a blank.
  const catBySku = useMemo(() => {
    const m = new Map<string, InventoryRow>()
    for (const p of catalog.data ?? []) m.set(p.sku, p)
    return m
  }, [catalog.data])

  // --- entry state -------------------------------------------------------
  const [entryOpen, setEntryOpen] = useState(false)
  const [toBranch, setToBranch] = useState<string>(BRANCHES[0])
  const [requester, setRequester] = useState('')
  const [reason, setReason] = useState('')
  const [draft, setDraft] = useState<DraftLine[]>([])

  const [picked, setPicked] = useState<InventoryRow | null>(null)
  const [qty, setQty] = useState('')

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  // Reused across a retry so a resubmit after a lost response dedups into a
  // no-op; cleared on confirmed success. Same contract as WinForms
  // currentTransactionId.
  const txId = useRef<string | null>(null)
  // Non-null while amending: the original ticket to delete at submit time. Once
  // that delete succeeds it is cleared, so a submit retry doesn't re-delete.
  const amendTxId = useRef<string | null>(null)
  const [amendingLabel, setAmendingLabel] = useState<string | null>(null)

  function load() {
    setSelected(null)
    setQuery(`/api/deliveries/tickets?start=${start}&end=${endOfDay(end)}`)
  }

  function openNew() {
    resetEntry()
    setEntryOpen(true)
  }

  function resetEntry() {
    setToBranch(BRANCHES[0])
    setRequester('')
    setReason('')
    setDraft([])
    setPicked(null)
    setQty('')
    txId.current = null
    amendTxId.current = null
    setAmendingLabel(null)
    setError('')
    setNotice('')
  }

  function addLine() {
    setError('')
    if (!picked) return setError('Choose a product first.')
    const q = Number(qty)
    if (!Number.isInteger(q) || q <= 0) return setError('Quantity must be a whole number greater than zero.')
    setDraft((d) => [...d, { key: nextKey++, sku: picked.sku, label: productLabel(picked), qty: q }])
    setPicked(null)
    setQty('')
  }

  // Reopen the entry form pre-filled from an existing InTransit ticket. The
  // ticket's rows may be FIFO-split across several rows of the same SKU, so
  // collapse them back to one line per SKU (summing qty), matching ApplyAmendSeed.
  async function startEdit(t: DeliveryTicket) {
    setError('')
    setNotice('')
    setBusy(true)
    try {
      const rows = await api.get<DeliveryLine[]>(`/api/deliveries/${encodeURIComponent(t.transactionId)}`)
      const cat = catalog.data ?? []
      const bySku = new Map<string, number>()
      for (const r of rows) bySku.set(r.sku, (bySku.get(r.sku) ?? 0) + r.qty)

      const seeded: DraftLine[] = Array.from(bySku.entries()).map(([sku, q]) => {
        const p = cat.find((c) => c.sku === sku)
        return { key: nextKey++, sku, label: p ? productLabel(p) : sku, qty: q }
      })

      resetEntry()
      setToBranch(t.toBranch)
      setRequester(t.requester ?? '')
      setReason(t.reason ?? '')
      setDraft(seeded)
      amendTxId.current = t.transactionId
      setAmendingLabel(t.transactionId)
      setEntryOpen(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the ticket to edit.')
    } finally {
      setBusy(false)
    }
  }

  async function submit() {
    if (draft.length === 0) return
    if (!toBranch) return setError('Choose a destination branch.')
    if (!requester.trim()) return setError('Enter a requester.')

    setError('')
    setNotice('')
    setBusy(true)
    try {
      // Amend: delete the original first. If it was accepted a moment ago the
      // delete throws and the original stays intact - abort without touching the
      // replacement. Clear amendTxId only after a successful delete so a submit
      // retry below doesn't try to delete an already-gone ticket.
      if (amendTxId.current) {
        if (
          !window.confirm(
            `This removes the original ticket ${amendTxId.current} (restocking its items to Office) and ` +
              `submits these as a new delivery the branch re-accepts. Continue?`,
          )
        ) {
          setBusy(false)
          return
        }
        await api.del(`/api/deliveries/${encodeURIComponent(amendTxId.current)}`)
        amendTxId.current = null
        setAmendingLabel(null)
      }

      if (!txId.current) txId.current = newTicketId('DEL')
      const date = localTimestamp() // client-local wall clock, like Delivery.cs
      const body = draft.map((l) => ({
        transactionId: txId.current,
        date,
        sku: l.sku,
        qty: l.qty,
        toBranch,
        requester: requester.trim(),
        reason: reason.trim(),
      }))

      await api.post('/api/deliveries', body)
      setNotice(`Sent delivery ${txId.current} to ${toBranch} (${draft.length} lines).`)
      resetEntry()
      setEntryOpen(false)
      setSelected(null)
      tickets.reload()
    } catch (err) {
      // Insufficient Office stock comes back as a 500 ProblemDetails whose detail
      // is "Insufficient inventory for SKU: x. Short by N." - the client unwraps
      // detail, so it shows through here. Draft + tx id are kept for a retry.
      setError(err instanceof Error ? err.message : 'Delivery failed.')
    } finally {
      setBusy(false)
    }
  }

  async function remove(t: DeliveryTicket) {
    if (
      !window.confirm(
        `Delete delivery ${t.transactionId}? Its items are restocked to Office. Only works while In transit.`,
      )
    )
      return
    setError('')
    setNotice('')
    setBusy(true)
    try {
      await api.del(`/api/deliveries/${encodeURIComponent(t.transactionId)}`)
      setNotice(`Deleted ${t.transactionId}.`)
      if (selected === t.transactionId) setSelected(null)
      tickets.reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed.')
    } finally {
      setBusy(false)
    }
  }

  const rows = tickets.data?.filter((t) => !branch || t.toBranch === branch) ?? null

  const ticketColumns: Column<DeliveryTicket>[] = [
    { header: 'Date', cell: (t) => formatDate(t.date) },
    { header: 'Ticket', cell: (t) => t.transactionId },
    { header: 'To branch', cell: (t) => t.toBranch },
    { header: 'Items', align: 'right', cell: (t) => formatQty(t.totalItems) },
    { header: 'Requester', cell: (t) => t.requester || '' },
    // Reason lives in the detail panel, not the master — this table is already 8
    // columns wide and the split narrows it; keeping Reason here pushed the
    // Edit/Delete actions off the right edge.
    { header: 'Cost', align: 'right', cell: (t) => formatMoney(t.totalCost) },
    {
      header: 'Status',
      cell: (t) => <span className={t.status === 'Accepted' ? 'pill ok' : 'pill warn'}>{t.status}</span>,
    },
    {
      header: '',
      // Edit and Delete are offered only while the ticket is InTransit - once the
      // branch accepts, the stock has moved and the server refuses both anyway.
      cell: (t) =>
        t.status === 'InTransit' ? (
          <span className="row-actions">
            <button
              className="btn neutral"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation()
                void startEdit(t)
              }}
            >
              Edit
            </button>
            <button
              className="btn destructive"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation()
                void remove(t)
              }}
            >
              Delete
            </button>
          </span>
        ) : (
          ''
        ),
    },
  ]

  const lineColumns: Column<DeliveryLine>[] = [
    { header: 'SKU', cell: (l) => l.sku },
    { header: 'Brand', cell: (l) => catBySku.get(l.sku)?.brand || '' },
    { header: 'Base name', cell: (l) => catBySku.get(l.sku)?.basename ?? l.sku },
    { header: 'Qty', align: 'right', cell: (l) => formatQty(l.qty) },
    { header: 'Line cost', align: 'right', cell: (l) => formatMoney(l.totalLineCost) },
  ]

  const total = rows ? sumMoney(rows.map((t) => t.totalCost)) : 0
  const pending = rows?.filter((t) => t.status === 'InTransit').length ?? 0
  const draftItems = draft.reduce((n, l) => n + l.qty, 0)
  const selectedTicket = rows?.find((t) => t.transactionId === selected) ?? null

  return (
    <section>
      <h1>Deliveries</h1>

      <div className="toolbar">
        <button className="btn primary" onClick={() => (entryOpen ? setEntryOpen(false) : openNew())} disabled={busy}>
          {entryOpen ? 'Close entry' : 'New delivery'}
        </button>
      </div>

      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}

      {entryOpen && (
        <div className="editor">
          <h2>{amendingLabel ? `Amend ticket ${amendingLabel}` : 'New delivery'}</h2>
          {amendingLabel && (
            <p className="entry-hint muted">
              Submitting deletes {amendingLabel} (restocking it to Office) and sends these items as a new
              ticket for the branch to accept. Close without submitting to leave the original untouched.
            </p>
          )}
          <div className="toolbar">
            <label className="inline">
              To branch
              <select value={toBranch} onChange={(e) => setToBranch(e.target.value)}>
                {BRANCHES.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </label>
            <label className="inline">
              Requester
              <input
                list="requester-list"
                value={requester}
                onChange={(e) => setRequester(e.target.value)}
                placeholder="Who requested it"
              />
              <datalist id="requester-list">
                {REQUESTERS.map((r) => (
                  <option key={r} value={r} />
                ))}
              </datalist>
            </label>
            <label className="inline">
              Reason
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Optional" />
            </label>
          </div>

          <h3>Add item</h3>
          <div className="toolbar">
            <label className="inline">
              Product
              <ProductPicker catalog={catalog.data ?? []} onPick={setPicked} disabled={busy} />
            </label>
            <label className="inline">
              Qty
              <input type="number" min={1} step={1} value={qty} onChange={(e) => setQty(e.target.value)} />
            </label>
            <button className="btn neutral" onClick={addLine} disabled={busy || !picked}>
              Add line
            </button>
          </div>

          {picked && (
            <p className="entry-hint muted">
              Selected: <strong>{productLabel(picked)}</strong> — Office stock {formatQty(picked.currentstock)}
            </p>
          )}

          {draft.length > 0 && (
            <div className="table-wrap" style={{ marginTop: 6 }}>
              <table className="data">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th style={{ textAlign: 'right' }}>Qty</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {draft.map((l) => (
                    <tr key={l.key}>
                      <td>{l.label}</td>
                      <td style={{ textAlign: 'right' }}>{formatQty(l.qty)}</td>
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
              {draft.length} lines, {formatQty(draftItems)} items
            </span>
            <button className="btn primary" onClick={() => void submit()} disabled={busy || draft.length === 0}>
              {busy ? 'Submitting…' : amendingLabel ? 'Submit amended ticket' : 'Submit delivery'}
            </button>
          </div>
        </div>
      )}

      <DateRangePicker start={start} end={end} onStart={setStart} onEnd={setEnd} onLoad={load} busy={tickets.loading}>
        <label className="inline">
          Branch
          <select value={branch} onChange={(e) => setBranch(e.target.value)}>
            <option value="">All</option>
            {BRANCHES.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
      </DateRangePicker>
      {rows && (
        <p className="muted">
          {rows.length} tickets, total {formatMoney(total)}
          {pending > 0 ? ` — ${pending} still in transit` : ''}
        </p>
      )}
      <div className="master-detail">
        <div className="master">
          <DataTable
            columns={ticketColumns}
            rows={rows}
            loading={tickets.loading}
            error={tickets.error}
            rowKey={(t) => t.transactionId}
            onRowClick={(t) => setSelected(t.transactionId)}
            selectedKey={selected}
            empty="No deliveries in this range."
          />
        </div>
        <div className="detail">
          {selected ? (
            <>
              <h2>Lines — {selected}</h2>
              {selectedTicket?.reason && (
                <p className="muted" style={{ marginTop: -4 }}>
                  Reason: {selectedTicket.reason}
                </p>
              )}
              <DataTable
                columns={lineColumns}
                rows={lines.data}
                loading={lines.loading}
                error={lines.error}
                rowKey={(l, i) => `${l.sku}-${i}`}
              />
            </>
          ) : (
            <p className="muted detail-empty">Select a ticket to see its items.</p>
          )}
        </div>
      </div>
    </section>
  )
}
