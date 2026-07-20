import { useState } from 'react'
import { DataTable } from '../../components/DataTable'
import type { Column } from '../../components/DataTable'
import { DateRangePicker } from '../../components/DateRangePicker'
import { useApi } from '../../lib/useApi'
import { endOfDay, formatDate, formatMoney, formatQty, localDate, sumMoney } from '../../lib/format'
import { BRANCHES } from '../../lib/branches'
import type { DeliveryLine, DeliveryTicket } from '../../api/types'

// Mirrors ViewDeliveries in the office app. Status is ticket-grain: the server
// reports MIN(status) over every row sharing the transaction_id, so a ticket
// that split across several FIFO lots still shows one honest status.
export function Deliveries() {
  const [start, setStart] = useState(localDate(30))
  const [end, setEnd] = useState(localDate())
  const [branch, setBranch] = useState('')
  const [query, setQuery] = useState<string | null>(
    `/api/deliveries/tickets?start=${localDate(30)}&end=${endOfDay(localDate())}`,
  )
  const [selected, setSelected] = useState<string | null>(null)

  const tickets = useApi<DeliveryTicket[]>(query)
  const lines = useApi<DeliveryLine[]>(selected ? `/api/deliveries/${encodeURIComponent(selected)}` : null)

  function load() {
    setSelected(null)
    setQuery(`/api/deliveries/tickets?start=${start}&end=${endOfDay(end)}`)
  }

  // The endpoint has no branch filter, so this one is applied client-side over
  // the loaded range rather than pretending the server did it.
  const rows = tickets.data?.filter((t) => !branch || t.toBranch === branch) ?? null

  const ticketColumns: Column<DeliveryTicket>[] = [
    { header: 'Date', cell: (t) => formatDate(t.date) },
    { header: 'Ticket', cell: (t) => t.transactionId },
    { header: 'To branch', cell: (t) => t.toBranch },
    { header: 'Items', align: 'right', cell: (t) => formatQty(t.totalItems) },
    { header: 'Requester', cell: (t) => t.requester || '' },
    { header: 'Reason', cell: (t) => t.reason || '' },
    { header: 'Cost', align: 'right', cell: (t) => formatMoney(t.totalCost) },
    {
      header: 'Status',
      cell: (t) => (
        <span className={t.status === 'Accepted' ? 'pill ok' : 'pill warn'}>{t.status}</span>
      ),
    },
  ]

  const lineColumns: Column<DeliveryLine>[] = [
    { header: 'SKU', cell: (l) => l.sku },
    { header: 'Qty', align: 'right', cell: (l) => formatQty(l.qty) },
    { header: 'Line cost', align: 'right', cell: (l) => formatMoney(l.totalLineCost) },
  ]

  const total = rows ? sumMoney(rows.map((t) => t.totalCost)) : 0
  const pending = rows?.filter((t) => t.status === 'InTransit').length ?? 0

  return (
    <section>
      <h1>Deliveries</h1>
      <DateRangePicker start={start} end={end} onStart={setStart} onEnd={setEnd} onLoad={load} busy={tickets.loading}>
        <label className="inline">
          Branch
          {/* Fixed list, not one derived from the loaded rows: deriving it made
              the picker appear to reset to "All" whenever a range happened to
              contain no tickets for the chosen branch, because the selected
              value no longer matched any option. */}
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
