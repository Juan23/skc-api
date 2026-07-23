// Day log data layer for the web POS (webapp-pos-plan.md Increment 6 + the
// same-day void of Increment 8). The on-screen list is the UNION of the two
// local stores - pendingSales (not yet synced) and syncedLog (synced) - for
// TODAY only, so it works fully offline. When online we additionally reconcile
// against the server's authoritative view (GET /api/sales): a sale voided on
// another till of the same branch, or rung on a second branch PC, shows up here
// too. Void is whole-sale and TODAY-ONLY by the owner's decision (see the
// pos-void-and-branch-history-scope memory): the button lives only on this day
// log, never on the back-office Sales History, and past days stay final.
import { api, ApiError } from '../api/client'
import type { SaleSummary } from '../api/types'
import { getDb } from './db'
import type { PosSaleLine } from './db'
import { localDate, endOfDay } from '../lib/format'

export type DayLogStatus = 'pending' | 'error' | 'synced' | 'shortfall' | 'voided'

export interface DayLogEntry {
  clientSaleId: string
  soldAt: string
  staffName: string
  totalCentavos: number
  paymentMethod: string // Cash | GCash | GCash Terminal | Foodpanda
  // Line detail is present for sales this device rang (from either local
  // store); null for a sale that only reached us via the server refresh (rung
  // on another till of the same branch) - the header is still shown and it can
  // still be voided, but we can't itemise it.
  lines: PosSaleLine[] | null
  status: DayLogStatus
  // A void needs the server to already have the sale, so only a synced (not a
  // still-pending) sale is voidable. Combined with !voided and being online.
  synced: boolean
  voided: boolean
  syncError?: string
}

// soldAt is always local wall-clock 'YYYY-MM-DD HH:mm:ss' (minted by
// localTimestamp) for local rows, or ISO 'YYYY-MM-DDTHH:mm:ss' for server rows -
// either way the first 10 chars are the calendar date, compared textually so we
// never re-parse a timestamp through Date (lib/format RULE 1).
function isToday(soldAt: string): boolean {
  return soldAt.slice(0, 10) === localDate()
}

// Build the today-only list from the two local stores, deduped by clientSaleId.
// A synced row wins over a pending one with the same id (sync deletes the
// pending copy, so this only matters defensively if a crash left both).
// Scoped to the till's own branch: a till is single-branch (posAuth refuses to
// re-point a provisioned till), but filtering by branch keeps this honest to
// the codebase's branch-scoping discipline and makes the void-with-till-branch
// assumption sound even if a future "reassign till" feature ever loosens that.
export async function loadTodayLocal(branch: string): Promise<DayLogEntry[]> {
  const db = await getDb()
  const [pending, synced] = await Promise.all([db.getAll('pendingSales'), db.getAll('syncedLog')])

  const byId = new Map<string, DayLogEntry>()

  for (const p of pending) {
    if (p.branch !== branch || !isToday(p.soldAt)) continue
    byId.set(p.clientSaleId, {
      clientSaleId: p.clientSaleId,
      soldAt: p.soldAt,
      staffName: p.staffName,
      totalCentavos: p.totalCentavos,
      paymentMethod: p.paymentMethod ?? 'Cash',
      lines: p.lines,
      status: p.syncState === 'error' ? 'error' : 'pending',
      synced: false,
      voided: false,
      syncError: p.syncError,
    })
  }

  for (const s of synced) {
    if (s.branch !== branch || !isToday(s.soldAt)) continue
    const voided = s.status === 'Voided'
    byId.set(s.clientSaleId, {
      clientSaleId: s.clientSaleId,
      soldAt: s.soldAt,
      staffName: s.staffName,
      totalCentavos: s.totalCentavos,
      paymentMethod: s.paymentMethod ?? 'Cash',
      lines: s.lines,
      status: voided ? 'voided' : s.status === 'SyncedWithShortfall' ? 'shortfall' : 'synced',
      synced: true,
      voided,
    })
  }

  return sortNewestFirst([...byId.values()])
}

function sortNewestFirst(entries: DayLogEntry[]): DayLogEntry[] {
  // soldAt strings are lexicographically ordered by time within the same date,
  // so a plain string compare is a correct chronological sort here.
  return entries.sort((a, b) => (a.soldAt < b.soldAt ? 1 : a.soldAt > b.soldAt ? -1 : 0))
}

// Persist a server-authoritative void into the local syncedLog so it survives a
// reload and shows voided even offline afterwards. No-op if the sale isn't in
// the local log (a purely server-side row) - the merged view still reflects it.
async function markLocalVoided(clientSaleId: string): Promise<void> {
  const db = await getDb()
  const row = await db.get('syncedLog', clientSaleId)
  if (row && row.status !== 'Voided') {
    await db.put('syncedLog', { ...row, status: 'Voided' })
  }
}

// Persist a server-reported shortfall into the local syncedLog. Needed because a
// sale whose sync response was lost gets re-pushed and comes back 'AlreadySynced'
// (the server's idempotency path doesn't re-report the shortfall), so its local
// row settles as plain 'Synced' even though the server holds a shortfall. Never
// downgrades a void and never rewrites an already-flagged row, so it's a safe
// no-op once the row is correct.
async function markLocalShortfall(clientSaleId: string): Promise<void> {
  const db = await getDb()
  const row = await db.get('syncedLog', clientSaleId)
  if (row && row.status !== 'Voided' && row.status !== 'SyncedWithShortfall') {
    await db.put('syncedLog', { ...row, status: 'SyncedWithShortfall' })
  }
}

// Reconcile the local today-list against the server's authoritative rows.
// Throws on a network failure so the caller can fall back to the local view
// unchanged (the whole point of offline-first). Two things happen:
//   1. Any sale the server reports voided is written back to the local log.
//   2. Any server sale not in our local stores (another branch PC) is merged in
//      as a header-only, line-less entry.
export async function reconcileWithServer(branch: string): Promise<DayLogEntry[]> {
  const today = localDate()
  const rows = await api.get<SaleSummary[]>(
    `/api/sales?branch=${encodeURIComponent(branch)}&start=${today}&end=${endOfDay(today)}`,
  )

  const local = await loadTodayLocal(branch)
  const byId = new Map(local.map((e) => [e.clientSaleId, e]))

  for (const r of rows) {
    if (!isToday(r.soldAt)) continue
    const existing = byId.get(r.clientSaleId)
    if (existing) {
      if (r.voided && !existing.voided) {
        await markLocalVoided(r.clientSaleId)
        existing.voided = true
        existing.status = 'voided'
      } else if (r.hasShortfall && existing.synced && !existing.voided && existing.status !== 'shortfall') {
        // Server recorded a shortfall this local row doesn't reflect (a re-pushed
        // sale came back 'AlreadySynced', losing the flag). Void wins over
        // shortfall, so this is an else-if. Only upgrade a synced row - a
        // still-pending one is the sync engine's job to resolve first.
        await markLocalShortfall(r.clientSaleId)
        existing.status = 'shortfall'
      }
    } else {
      // Rung on another till of this branch - we have no lines for it.
      byId.set(r.clientSaleId, {
        clientSaleId: r.clientSaleId,
        soldAt: r.soldAt,
        staffName: r.staffName ?? '',
        totalCentavos: Math.round(r.totalAmount * 100),
        paymentMethod: r.paymentMethod ?? 'Cash',
        lines: null,
        status: r.voided ? 'voided' : r.hasShortfall ? 'shortfall' : 'synced',
        synced: true,
        voided: r.voided,
      })
    }
  }

  return sortNewestFirst([...byId.values()])
}

// Dismiss a terminally-rejected sale: delete its row from pendingSales so it
// stops counting toward the sync badge's pending total and its 'sync-error'
// status (syncEngine.refreshPendingCount counts errored rows). The server
// rejected the sale outright (that's exactly what syncState 'error' means), so
// this local row is a record of a sale that was NEVER recorded server-side -
// removing it un-sells nothing. Guarded to fire ONLY on an errored row of this
// branch: it can never delete a still-syncable ('pending') sale, so a queued
// sale awaiting sync is safe. Returns true iff a row was actually removed.
export async function dismissRejectedSale(branch: string, clientSaleId: string): Promise<boolean> {
  const db = await getDb()
  const tx = db.transaction('pendingSales', 'readwrite')
  const row = await tx.store.get(clientSaleId)
  if (!row || row.branch !== branch || row.syncState !== 'error') {
    await tx.done
    return false
  }
  await tx.store.delete(clientSaleId)
  await tx.done
  return true
}

export type VoidResult = 'voided' | 'not-synced' | 'forbidden' | 'offline' | 'error'

function classifyVoidError(err: unknown): VoidResult {
  if (err instanceof ApiError) {
    if (err.status === 404) return 'not-synced' // server doesn't have it yet
    if (err.status === 403) return 'forbidden' // device not on the branch allowlist
    return 'error'
  }
  return 'offline' // fetch threw - no network
}

// Void a whole sale server-side, then mirror it into the local log. Online-only
// by nature (the server must already hold the sale). Returns a discriminated
// result instead of throwing so the UI can message each case precisely.
export async function voidSale(branch: string, clientSaleId: string, voidedBy: string): Promise<VoidResult> {
  const path = `/api/sales/${encodeURIComponent(branch)}/${encodeURIComponent(clientSaleId)}/void`
  async function attempt(): Promise<void> {
    // Server is idempotent: 'Voided' and 'AlreadyVoided' are both success.
    await api.post(path, { voidedBy })
    await markLocalVoided(clientSaleId)
  }
  try {
    await attempt()
    return 'voided'
  } catch (err) {
    // A 401 means the session expired; the server cleared the cookie in that
    // same response, so an immediate retry rides cookie-less into the IP-gated
    // path - exactly what syncEngine's push does. Retried once only.
    if (err instanceof ApiError && err.status === 401) {
      try {
        await attempt()
        return 'voided'
      } catch (retryErr) {
        return classifyVoidError(retryErr)
      }
    }
    return classifyVoidError(err)
  }
}
