// Printable daily sales report for the web POS (webapp-pos-plan.md Increment 7),
// the browser analogue of SKC Branch's frmSalesReport. A per-sale list + a
// signed-off summary for a date range (defaulting to today), printed via
// window.print() with a print-only layout (see pos.css @media print). NOT a
// customer receipt. CSV export (per-item lines) is server-only and blocked when
// the on-screen rows came from the offline fallback. The whole `.pos-report-doc`
// is a WYSIWYG preview of exactly what prints.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { formatCentavos } from './money'
import { localDate, localTimestamp } from '../lib/format'
import type { ReportFlag, ReportRow } from './reportStore'
import { buildCsv, fetchSaleLines, loadReport, summarize } from './reportStore'

function peso(centavos: number): string {
  return `₱${formatCentavos(centavos)}`
}

// soldAt is server ISO ('T') or local wall-clock (space); split on either and
// drop the seconds - textually, never through Date (lib/format RULE 1).
function soldStamp(soldAt: string): string {
  const [date, rest = ''] = soldAt.split(/[T ]/)
  const hhmm = rest.slice(0, 5)
  return hhmm ? `${date} ${hhmm}` : date
}

const FLAG_TONE: Record<Exclude<ReportFlag, ''>, string> = {
  VOIDED: 'muted',
  REJECTED: 'muted',
  SHORTFALL: 'warn',
  UNSYNCED: 'warn',
}

export function DayReport({ branch }: { branch: string }) {
  const [start, setStart] = useState(localDate())
  const [end, setEnd] = useState(localDate())
  const [rows, setRows] = useState<ReportRow[] | null>(null)
  const [offline, setOffline] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [loadedStart, setLoadedStart] = useState('')
  const [loadedEnd, setLoadedEnd] = useState('')
  const [generatedAt, setGeneratedAt] = useState('')
  const [csvBusy, setCsvBusy] = useState(false)
  const [csvMsg, setCsvMsg] = useState('')
  const [wantPrint, setWantPrint] = useState(false)

  const load = useCallback(
    async (s: string, e: string) => {
      if (s > e) {
        setError('The "From" date is after the "To" date.')
        return
      }
      setError('')
      setCsvMsg('')
      setLoading(true)
      try {
        const res = await loadReport(branch, s, e)
        setRows(res.rows)
        setOffline(res.offline)
        setLoadedStart(s)
        setLoadedEnd(e)
        setGeneratedAt(localTimestamp())
      } catch {
        setError(
          'Could not load sales for this range - are you online? Past days can only be read from the server; today still works offline.',
        )
      } finally {
        setLoading(false)
      }
    },
    [branch],
  )

  // Auto-load today on mount, like frmSalesReport_Load.
  useEffect(() => {
    void load(localDate(), localDate())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Open the print dialog only after the DOM reflects the fresh generatedAt
  // stamp (set on the Print click), so the printed header shows the print time.
  useEffect(() => {
    if (wantPrint) {
      window.print()
      setWantPrint(false)
    }
  }, [wantPrint])

  const summary = useMemo(() => (rows ? summarize(rows) : null), [rows])
  // The pickers moved but the rows on screen still belong to the loaded range -
  // warn rather than let Print/Export emit a document for a range nobody loaded.
  const stale = rows != null && (start !== loadedStart || end !== loadedEnd)

  function loadToday() {
    const t = localDate()
    setStart(t)
    setEnd(t)
    void load(t, t)
  }

  function print() {
    if (!rows || rows.length === 0) return
    setGeneratedAt(localTimestamp())
    setWantPrint(true)
  }

  async function exportCsv() {
    if (offline) {
      setCsvMsg(
        'The CSV needs a connection - item details for synced sales are only on the server. The printed report still works offline; export once back online.',
      )
      return
    }
    setCsvBusy(true)
    setCsvMsg('')
    try {
      const lines = await fetchSaleLines(branch, loadedStart, loadedEnd)
      if (lines.length === 0) {
        setCsvMsg('No sales in this range to export.')
        return
      }
      // UTF-8 BOM so Excel reads non-ASCII names correctly (matches WinForms).
      const blob = new Blob(['﻿' + buildCsv(lines)], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download =
        loadedStart === loadedEnd
          ? `SKC-Sales-${branch}-${loadedStart}.csv`
          : `SKC-Sales-${branch}-${loadedStart}_to_${loadedEnd}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      setCsvMsg('Could not export - are you online?')
    } finally {
      setCsvBusy(false)
    }
  }

  const periodLabel = loadedStart === loadedEnd ? loadedStart : `${loadedStart} to ${loadedEnd}`
  const nothing = rows != null && rows.length === 0

  return (
    <div className="pos-report">
      <div className="pos-report-controls">
        <label>
          From
          <input type="date" value={start} max={end} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label>
          To
          <input type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} />
        </label>
        <button type="button" className="btn neutral" onClick={loadToday} disabled={loading}>
          Today
        </button>
        <button type="button" className="btn primary" onClick={() => void load(start, end)} disabled={loading}>
          {loading ? 'Loading…' : 'Load'}
        </button>
        {stale && <span className="pos-report-stale">Dates changed — press Load</span>}
        <span className="pos-report-controls-spacer" />
        <button type="button" className="btn neutral" onClick={print} disabled={loading || nothing}>
          Print
        </button>
        <button type="button" className="btn neutral" onClick={() => void exportCsv()} disabled={loading || nothing || csvBusy}>
          {csvBusy ? 'Exporting…' : 'Export CSV'}
        </button>
      </div>

      {error && <p className="error pos-report-msg">{error}</p>}
      {csvMsg && <p className="muted pos-report-msg">{csvMsg}</p>}

      <div className="pos-report-doc">
        <div className="pos-report-head">
          <h1>SKC Bakery Supplies</h1>
          <h2>Sales Report — {branch}</h2>
          <p className="pos-report-meta">
            {loadedStart ? (loadedStart === loadedEnd ? `Date: ${periodLabel}` : `Period: ${periodLabel}`) : ''}
            {generatedAt ? <span className="pos-report-generated">Generated: {generatedAt}</span> : null}
          </p>
        </div>

        {offline && (
          <div className="pos-report-offline">
            <strong>Offline copy</strong> — printed from this device&rsquo;s local records. May exclude sales made on
            another POS device, and does not reflect voids made elsewhere.
          </div>
        )}

        {rows == null ? (
          <p className="pos-report-empty">{loading ? 'Loading…' : ' '}</p>
        ) : rows.length === 0 ? (
          <p className="pos-report-empty">No sales in this {loadedStart === loadedEnd ? 'day' : 'range'}.</p>
        ) : (
          <table className="pos-report-table">
            <thead>
              <tr>
                <th className="c-no">No.</th>
                <th className="c-time">Date &amp; time</th>
                <th className="c-cashier">Cashier</th>
                <th className="c-total">Total</th>
                <th className="c-flag">Flag</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.no || `local-${i}`} className={r.flag ? `flag-${FLAG_TONE[r.flag]}` : undefined}>
                  <td className="c-no">{r.no || '—'}</td>
                  <td className="c-time">{soldStamp(r.soldAt)}</td>
                  <td className="c-cashier">{r.cashier || '—'}</td>
                  <td className="c-total">{peso(r.totalCentavos)}</td>
                  <td className="c-flag">{r.flag}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {summary && rows && rows.length > 0 && (
          <div className="pos-report-summary">
            <div className="pos-report-summary-line strong">
              <span>Sales counted</span>
              <span>{summary.countedSales}</span>
            </div>
            <div className="pos-report-summary-line strong">
              <span>Gross total</span>
              <span>{peso(summary.grossCentavos)}</span>
            </div>
            {summary.voidedCount > 0 && (
              <div className="pos-report-summary-line">
                <span>Voided (excluded)</span>
                <span>
                  {summary.voidedCount} ({peso(summary.voidedCentavos)})
                </span>
              </div>
            )}
            {summary.shortfallCount > 0 && (
              <div className="pos-report-summary-line">
                <span>With shortfall</span>
                <span>{summary.shortfallCount}</span>
              </div>
            )}
            {summary.rejectedCount > 0 && (
              <div className="pos-report-summary-line">
                <span>Rejected (excluded)</span>
                <span>{summary.rejectedCount}</span>
              </div>
            )}
            {summary.unsyncedCount > 0 && (
              <div className="pos-report-summary-line">
                <span>Not yet synced (included above)</span>
                <span>{summary.unsyncedCount}</span>
              </div>
            )}
          </div>
        )}

        {rows && rows.length > 0 && (
          <div className="pos-report-signatures">
            <div className="pos-report-sig">
              <span className="pos-report-sig-line" />
              Counted by
            </div>
            <div className="pos-report-sig">
              <span className="pos-report-sig-line" />
              Verified by
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
