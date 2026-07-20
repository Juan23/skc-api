import { useState } from 'react'
import { DataTable } from '../../components/DataTable'
import type { Column } from '../../components/DataTable'
import { DateRangePicker } from '../../components/DateRangePicker'
import { useApi } from '../../lib/useApi'
import { endOfDay, formatDate, formatMoney, formatQty, localDate, sumMoney } from '../../lib/format'
import type { PurchaseLine, PurchaseTicket } from '../../api/types'

// Mirrors PurchasesReport in the office app: ticket list, click a ticket to see
// the lines it created. One ticket = one supplier delivery = many lots.
export function PurchasesReport() {
  const [start, setStart] = useState(localDate(30))
  const [end, setEnd] = useState(localDate())
  const [query, setQuery] = useState<string | null>(
    `/api/purchases/tickets?start=${localDate(30)}&end=${endOfDay(localDate())}`,
  )
  const [selected, setSelected] = useState<string | null>(null)

  const tickets = useApi<PurchaseTicket[]>(query)
  const lines = useApi<PurchaseLine[]>(selected ? `/api/purchases/${encodeURIComponent(selected)}` : null)

  function load() {
    setSelected(null)
    setQuery(`/api/purchases/tickets?start=${start}&end=${endOfDay(end)}`)
  }

  const ticketColumns: Column<PurchaseTicket>[] = [
    { header: 'Date', cell: (t) => formatDate(t.date) },
    { header: 'Ticket', cell: (t) => t.transactionId },
    { header: 'Supplier', cell: (t) => t.supplier || '' },
    { header: 'Total', align: 'right', cell: (t) => formatMoney(t.totalAmount) },
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
      <DateRangePicker
        start={start}
        end={end}
        onStart={setStart}
        onEnd={setEnd}
        onLoad={load}
        busy={tickets.loading}
      />
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
