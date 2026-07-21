// Today's sales history for the web POS (webapp-pos-plan.md Increment 6) with
// same-day whole-sale void (Increment 8). Offline-first: the list comes from
// the local stores first (instant, works with no network), then a best-effort
// server reconcile fills in cross-till voids/sales. Void is online-only and
// today-only by design - see the pos-void-and-branch-history-scope memory.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { formatCentavos } from './money'
import type { DayLogEntry, DayLogStatus, VoidResult } from './dayLogStore'
import { loadTodayLocal, reconcileWithServer, voidSale } from './dayLogStore'

// soldAt is 'YYYY-MM-DD HH:mm:ss' for locally-rung sales (localTimestamp mints a
// space separator) but ISO 'YYYY-MM-DDTHH:mm:ss' for sales merged in from the
// server. lib/format's formatTimestamp only splits on 'T', so it would leave a
// local string unparsed (seconds and all) - inconsistent with server rows on the
// same screen. Split on either separator and drop the seconds, textually, never
// through Date (lib/format RULE 1).
function soldParts(soldAt: string): { date: string; time: string } {
  const [date, rest = ''] = soldAt.split(/[T ]/)
  return { date, time: rest.slice(0, 5) }
}

const STATUS: Record<DayLogStatus, { label: string; tone: string }> = {
  pending: { label: 'Pending', tone: 'warn' },
  error: { label: 'Rejected', tone: 'error' },
  synced: { label: 'Synced', tone: 'ok' },
  shortfall: { label: 'Short stock', tone: 'warn' },
  voided: { label: 'Voided', tone: 'muted' },
}

function peso(centavos: number): string {
  return `₱${formatCentavos(centavos)}`
}

function voidMessage(result: VoidResult): string {
  switch (result) {
    case 'not-synced':
      return "This sale hasn't reached the server yet - wait for it to sync, then void."
    case 'forbidden':
      return 'This device is not allowed to void sales for this branch.'
    case 'offline':
      return 'Can’t reach the server. Connect to the network and try again.'
    default:
      return 'Void failed. Try again in a moment.'
  }
}

export function DayLog({ branch, voidedBy }: { branch: string; voidedBy: string }) {
  const [entries, setEntries] = useState<DayLogEntry[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [voiding, setVoiding] = useState(false)
  const [message, setMessage] = useState('')

  const load = useCallback(async () => {
    // Local first so the list appears instantly and works fully offline, then
    // overlay the server's authoritative view if we can reach it.
    const local = await loadTodayLocal(branch)
    setEntries(local)
    try {
      setEntries(await reconcileWithServer(branch))
    } catch {
      /* offline - the local list stands, no error shown */
    }
  }, [branch])

  useEffect(() => {
    void load()
  }, [load])

  const selected = entries?.find((e) => e.clientSaleId === selectedId) ?? null

  // Takings = non-voided totals only, matching SalesView/frmSalesReport's rule.
  const takings = useMemo(
    () => (entries ?? []).filter((e) => !e.voided).reduce((sum, e) => sum + e.totalCentavos, 0),
    [entries],
  )
  const soldCount = (entries ?? []).filter((e) => !e.voided).length

  function select(id: string) {
    setSelectedId(id)
    setConfirming(false)
    setMessage('')
  }

  async function doVoid() {
    if (!selected) return
    setVoiding(true)
    setMessage('')
    const result = await voidSale(branch, selected.clientSaleId, voidedBy)
    setVoiding(false)
    setConfirming(false)
    if (result === 'voided') {
      await load()
    } else {
      setMessage(voidMessage(result))
    }
  }

  return (
    <div className="pos-daylog">
      <div className="pos-daylog-list">
        <div className="pos-daylog-head">
          <h1>Today&rsquo;s sales</h1>
          <div className="pos-daylog-takings">
            <span>{peso(takings)}</span>
            <small>
              {soldCount} sale{soldCount === 1 ? '' : 's'}
            </small>
          </div>
        </div>

        {entries == null ? (
          <p className="pos-daylog-empty">Loading&hellip;</p>
        ) : entries.length === 0 ? (
          <p className="pos-daylog-empty">No sales yet today.</p>
        ) : (
          <ul className="pos-daylog-rows">
            {entries.map((e) => {
              const s = STATUS[e.status]
              return (
                <li key={e.clientSaleId}>
                  <button
                    type="button"
                    className={`pos-daylog-row${e.clientSaleId === selectedId ? ' selected' : ''}${
                      e.voided ? ' voided' : ''
                    }`}
                    onClick={() => select(e.clientSaleId)}
                  >
                    <span className="pos-daylog-time">{soldParts(e.soldAt).time || '--:--'}</span>
                    <span className="pos-daylog-who">{e.staffName || '—'}</span>
                    <span className={`pos-daylog-badge ${s.tone}`}>{s.label}</span>
                    <span className="pos-daylog-amt">{peso(e.totalCentavos)}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <div className="pos-daylog-detail">
        {!selected ? (
          <p className="muted">Select a sale to see its items{'…'}</p>
        ) : (
          <>
            <div className="pos-daylog-detail-head">
              <h2>{`${soldParts(selected.soldAt).date} ${soldParts(selected.soldAt).time}`}</h2>
              <span className={`pos-daylog-badge ${STATUS[selected.status].tone}`}>
                {STATUS[selected.status].label}
              </span>
            </div>
            <p className="muted">Cashier: {selected.staffName || '—'}</p>

            {selected.lines == null ? (
              <p className="muted">Rung on another till - item detail isn&rsquo;t on this device.</p>
            ) : (
              <table className="pos-daylog-lines">
                <tbody>
                  {selected.lines.map((l, i) => (
                    <tr key={i} className={l.sku == null ? 'discount' : undefined}>
                      <td>{l.description}</td>
                      <td className="q">{l.sku == null ? '' : `×${l.qty}`}</td>
                      <td className="amt">{peso(l.lineTotalCentavos)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <div className="pos-daylog-total-row">
              <span>Total</span>
              <span className={selected.voided ? 'voided-amt' : ''}>{peso(selected.totalCentavos)}</span>
            </div>

            {message && <p className="error">{message}</p>}

            {selected.voided ? (
              <p className="pos-daylog-voided-note">This sale has been voided.</p>
            ) : selected.status === 'error' ? (
              <p className="error">
                Rejected by the server{selected.syncError ? `: ${selected.syncError}` : ''}. This sale won&rsquo;t sync
                on its own — the office needs to check it.
              </p>
            ) : !selected.synced ? (
              <p className="muted">This sale voids only after it syncs to the server.</p>
            ) : confirming ? (
              <div className="pos-daylog-confirm">
                <p>Void this entire sale? Stock it used is returned.</p>
                <div className="pos-daylog-confirm-btns">
                  <button type="button" className="btn destructive" onClick={doVoid} disabled={voiding}>
                    {voiding ? 'Voiding…' : 'Yes, void'}
                  </button>
                  <button type="button" className="btn neutral" onClick={() => setConfirming(false)} disabled={voiding}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" className="btn destructive pos-daylog-void" onClick={() => setConfirming(true)}>
                Void sale
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
