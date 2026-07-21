import { useMemo, useState } from 'react'
import { DataTable } from '../../components/DataTable'
import type { Column } from '../../components/DataTable'
import { useApi } from '../../lib/useApi'
import { api, ApiError } from '../../api/client'
import { formatMoney, formatQty, formatTimestamp } from '../../lib/format'
import { useAuth } from '../../auth/AuthContext'
import type { DeliveryLine, DeliveryTicket, InventoryRow } from '../../api/types'

// Mirrors frmMain in the branch app: the InTransit tickets addressed to this
// branch, with line detail, and an Accept action that credits the branch's own
// FIFO lots. Branch comes from the session, never a picker - and the server
// re-checks it against the ticket's real to_branch, so this page couldn't
// accept another branch's ticket even if it tried.
export function PendingDeliveries() {
  const { user } = useAuth()
  const branch = user?.branchName ?? ''

  const pending = useApi<DeliveryTicket[]>(
    branch ? `/api/deliveries/pending?branch=${encodeURIComponent(branch)}` : null,
  )
  const [selected, setSelected] = useState<string | null>(null)
  const lines = useApi<DeliveryLine[]>(selected ? `/api/deliveries/${encodeURIComponent(selected)}` : null)
  const catalog = useApi<InventoryRow[]>('/api/inventory')

  const [acceptedBy, setAcceptedBy] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  // Translate SKUs into readable names and collapse FIFO-split rows back to one
  // line per item, exactly as frmMain's detail grid does.
  const displayLines = useMemo(() => {
    if (!lines.data) return null
    const cat = catalog.data ?? []
    const byItem = new Map<string, number>()
    for (const l of lines.data) {
      const p = cat.find((c) => c.sku === l.sku)
      const item = p ? (p.brand && p.brand !== p.basename ? `${p.brand} ${p.basename}` : p.basename) : l.sku
      byItem.set(item, (byItem.get(item) ?? 0) + l.qty)
    }
    return Array.from(byItem.entries()).map(([item, qty]) => ({ item, qty }))
  }, [lines.data, catalog.data])

  async function accept(t: DeliveryTicket) {
    const name = acceptedBy.trim()
    if (!name) return setError('Enter who physically received and checked the items.')
    if (
      !window.confirm(
        `Accept delivery ${t.transactionId} (${formatQty(t.totalItems)} items) as ${name}?\n\n` +
          'Only accept after physically checking the items against the delivery sheet.',
      )
    )
      return

    setError('')
    setNotice('')
    setBusy(true)
    try {
      await api.post(`/api/deliveries/${encodeURIComponent(t.transactionId)}/accept`, {
        branch,
        acceptedBy: name,
      })
      setNotice(`Accepted ${t.transactionId} — stock added to ${branch}.`)
      setSelected(null)
      setAcceptedBy('')
      pending.reload()
    } catch (err) {
      // 409 = already accepted (a double-click or a retry after a lost
      // response). The stock is already in, so report it as done rather than a
      // scary failure - same stance as frmMain's AlreadyAcceptedException.
      if (err instanceof ApiError && err.status === 409) {
        setNotice(`${t.transactionId} was already accepted — nothing to do.`)
        setSelected(null)
        pending.reload()
      } else {
        setError(err instanceof Error ? err.message : 'Accept failed.')
      }
    } finally {
      setBusy(false)
    }
  }

  const ticketColumns: Column<DeliveryTicket>[] = [
    // Delivery dates are client-stamped with a real time component, so show it.
    { header: 'Sent', cell: (t) => formatTimestamp(t.date) },
    { header: 'Ticket', cell: (t) => t.transactionId },
    { header: 'Items', align: 'right', cell: (t) => formatQty(t.totalItems) },
    { header: 'Requester', cell: (t) => t.requester || '' },
    { header: 'Reason', cell: (t) => t.reason || '' },
    { header: 'Value', align: 'right', cell: (t) => formatMoney(t.totalCost) },
  ]

  const lineColumns: Column<{ item: string; qty: number }>[] = [
    { header: 'Item', cell: (l) => l.item },
    { header: 'Qty', align: 'right', cell: (l) => formatQty(l.qty) },
  ]

  if (!branch) return <p className="muted">This account isn't tied to a branch.</p>

  const selectedTicket = pending.data?.find((t) => t.transactionId === selected) ?? null

  return (
    <section>
      <h1>Pending deliveries — {branch}</h1>
      <p className="muted">
        Deliveries the office has sent that are still in transit. Accepting one adds its items to this
        branch's stock — only accept after physically checking the items against the delivery sheet.
      </p>

      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}

      <DataTable
        columns={ticketColumns}
        rows={pending.data}
        loading={pending.loading}
        error={pending.error}
        rowKey={(t) => t.transactionId}
        onRowClick={(t) => setSelected(t.transactionId)}
        selectedKey={selected}
        empty="No deliveries waiting — you're all caught up."
      />

      {selectedTicket && (
        <>
          <h2>Items — {selectedTicket.transactionId}</h2>
          <DataTable
            columns={lineColumns}
            rows={displayLines}
            loading={lines.loading}
            error={lines.error}
            rowKey={(l) => l.item}
          />
          <div className="toolbar" style={{ marginTop: 12 }}>
            <label className="inline">
              Received &amp; checked by
              <input
                value={acceptedBy}
                onChange={(e) => setAcceptedBy(e.target.value)}
                placeholder="Your name"
              />
            </label>
            <button
              className="btn primary"
              onClick={() => void accept(selectedTicket)}
              disabled={busy || !acceptedBy.trim()}
            >
              {busy ? 'Accepting…' : 'Accept delivery'}
            </button>
          </div>
        </>
      )}
    </section>
  )
}
