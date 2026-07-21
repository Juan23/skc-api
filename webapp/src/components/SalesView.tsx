import { useState } from 'react'
import { DataTable } from './DataTable'
import type { Column } from './DataTable'
import { DateRangePicker } from './DateRangePicker'
import { useApi } from '../lib/useApi'
import { api } from '../api/client'
import { buildSalesCsv, downloadCsv } from '../lib/csv'
import { endOfDay, formatMoney, formatQty, formatTimestamp, localDate, sumMoney } from '../lib/format'
import type { SaleLine, SaleLineExport, SaleSummary } from '../api/types'

// POS sales for one branch, with per-sale line detail. Shared by the office's
// Branch Sales Report and the branch's own Sales History.
//
// Two conventions copied from BranchSalesReport.cs so the numbers agree with
// what the owner already reads in WinForms:
//   - VOIDED takes precedence over SHORTFALL in the flag column (a voided sale
//     was reversed, so its shortfall no longer means anything).
//   - The takings total EXCLUDES voided sales.
// `soldAt` is counter time, not sync time - an offline sale syncs late but keeps
// the time it was actually rung up.
export function SalesView({ branch }: { branch: string }) {
  const [start, setStart] = useState(localDate(7))
  const [end, setEnd] = useState(localDate())
  // Load the default range immediately, like every other report page - an empty
  // screen with a Load button reads as "broken" rather than "no data yet".
  const [query, setQuery] = useState<string | null>(
    `/api/sales?branch=${encodeURIComponent(branch)}&start=${localDate(7)}&end=${endOfDay(localDate())}`,
  )
  const [selected, setSelected] = useState<string | null>(null)

  const sales = useApi<SaleSummary[]>(query)
  const lines = useApi<SaleLine[]>(
    selected ? `/api/sales/${encodeURIComponent(branch)}/${encodeURIComponent(selected)}` : null,
  )

  // The dates the on-screen rows were actually loaded with - the export uses
  // these, not the live picker values, so the CSV and the table always agree
  // even when the pickers have been changed since Load (same rule as
  // frmSalesReport's loadedStart/loadedEnd).
  const [loaded, setLoaded] = useState<{ start: string; end: string }>({
    start: localDate(7),
    end: localDate(),
  })
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState('')

  function load() {
    setSelected(null)
    setLoaded({ start, end })
    setQuery(`/api/sales?branch=${encodeURIComponent(branch)}&start=${start}&end=${endOfDay(end)}`)
  }

  // Line-level CSV for Excel (one row per item per sale, SUMIFS-friendly) via
  // /api/sales/lines - the same server rows frmSalesReport's export reads.
  async function exportCsv() {
    setExportError('')
    setExporting(true)
    try {
      const rows = await api.get<SaleLineExport[]>(
        `/api/sales/lines?branch=${encodeURIComponent(branch)}&start=${loaded.start}&end=${endOfDay(loaded.end)}`,
      )
      if (rows.length === 0) {
        setExportError('There are no sales in this date range to export.')
        return
      }
      const name =
        loaded.start === loaded.end
          ? `SKC-Sales-${branch}-${loaded.start}.csv`
          : `SKC-Sales-${branch}-${loaded.start}_to_${loaded.end}.csv`
      downloadCsv(name, buildSalesCsv(rows))
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Export failed.')
    } finally {
      setExporting(false)
    }
  }

  const saleColumns: Column<SaleSummary>[] = [
    { header: 'No.', align: 'right', cell: (s) => s.localId },
    { header: 'Time', cell: (s) => formatTimestamp(s.soldAt) },
    { header: 'Cashier', cell: (s) => s.staffName || '' },
    { header: 'Total', align: 'right', cell: (s) => formatMoney(s.totalAmount) },
    {
      header: '',
      cell: (s) =>
        s.voided ? (
          <span className="pill bad">VOIDED</span>
        ) : s.hasShortfall ? (
          <span className="pill warn">SHORTFALL</span>
        ) : (
          ''
        ),
    },
  ]

  const lineColumns: Column<SaleLine>[] = [
    { header: 'SKU', cell: (l) => l.sku || <span className="muted">discount</span> },
    { header: 'Description', cell: (l) => l.description },
    { header: 'Qty', align: 'right', cell: (l) => formatQty(l.qty) },
    { header: 'Unit price', align: 'right', cell: (l) => formatMoney(l.unitPrice) },
    { header: 'Amount', align: 'right', cell: (l) => formatMoney(l.lineTotal) },
    {
      header: 'Short',
      align: 'right',
      cell: (l) => (l.shortfallQty > 0 ? <span className="neg">{formatQty(l.shortfallQty)}</span> : ''),
    },
  ]

  const live = sales.data?.filter((s) => !s.voided) ?? []
  const takings = sumMoney(live.map((s) => s.totalAmount))
  const shortfalls = live.filter((s) => s.hasShortfall).length
  const voided = sales.data?.filter((s) => s.voided).length ?? 0

  return (
    <>
      <DateRangePicker start={start} end={end} onStart={setStart} onEnd={setEnd} onLoad={load} busy={sales.loading}>
        <button className="btn neutral" onClick={() => void exportCsv()} disabled={exporting || !sales.data}>
          {exporting ? 'Exporting…' : 'Export CSV'}
        </button>
      </DateRangePicker>
      {exportError && <p className="error">{exportError}</p>}
      {sales.data && (
        <p className="muted">
          {sales.data.length} sales, total {formatMoney(takings)}
          {shortfalls > 0 ? ` — ${shortfalls} with stock shortfall` : ''}
          {voided > 0 ? ` — ${voided} voided (excluded)` : ''}
        </p>
      )}
      <div className="master-detail">
        <div className="master">
          <DataTable
            columns={saleColumns}
            rows={sales.data}
            loading={sales.loading}
            error={sales.error}
            rowKey={(s) => s.clientSaleId}
            onRowClick={(s) => setSelected(s.clientSaleId)}
            selectedKey={selected}
            rowClass={(s) => (s.voided ? 'voided' : undefined)}
            empty="No sales in this range."
          />
        </div>
        <div className="detail">
          {selected ? (
            <>
              <h2>Sale detail</h2>
              <DataTable
                columns={lineColumns}
                rows={lines.data}
                loading={lines.loading}
                error={lines.error}
                rowKey={(l, i) => `${l.sku ?? 'discount'}-${i}`}
              />
            </>
          ) : (
            <p className="muted detail-empty">Select a sale to see its items.</p>
          )}
        </div>
      </div>
    </>
  )
}
