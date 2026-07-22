// Catalog pull for the offline-first web POS (webapp-pos-plan.md Increment 2).
// Reuses the same /api/inventory/branch/{branch} endpoint StockView already
// calls - the API needs no changes for this.
import { api, ApiError } from '../api/client'
import type { InventoryRow } from '../api/types'
import { localTimestamp } from '../lib/format'
import { getDb } from './db'

// Sellable mirrors the WinForms branch POS's PosLocalStore.GetSellableCatalog()
// rule exactly (see CLAUDE.md): price > 0 (set via SKC Admin - unpriced items
// never appear at the counter) AND never RawMaterial (office-only; only the
// office POS sells that category). This is a branch-till rule - the office POS
// has the opposite category filter, but branch till ships first per the plan's
// decision #1, so that's not handled here yet.
function isSellable(row: InventoryRow): boolean {
  return row.category !== 'RawMaterial' && row.price > 0
}

export interface CatalogPullResult {
  ok: boolean
  count: number
  // Why a pull didn't apply (only set when ok === false), so callers can tell a
  // genuine connectivity/server failure apart from a perfectly healthy server
  // that simply has nothing sellable yet (e.g. a branch before the owner has
  // priced anything). The sync-status badge must NOT show "offline" for the
  // latter - the server was reached fine.
  //   'error' - fetch threw, a non-2xx ApiError, or a malformed response.
  //   'empty' - a well-formed response that filtered down to zero sellable.
  reason?: 'error' | 'empty'
}

// Empty pull -> keep last-good (webapp-pos-plan.md §1): a blank pull is a bad
// pull, never blanks the counter. This covers a hard failure (offline, server
// error, a malformed/non-array response), a real ApiError (e.g. a 403 IP-gate
// rejection), and a "successful" response that happens to filter down to
// nothing sellable - all of these leave the existing cached catalog untouched.
// Logged (not silently swallowed) so a persistent problem in the field is
// distinguishable from ordinary offline flakiness when reading the console
// later; ApiError.status is kept in the log specifically because a later
// increment's status indicator will want to tell "offline" apart from
// "rejected" (see the plan's sync-engine error taxonomy).
export async function pullCatalog(branch: string): Promise<CatalogPullResult> {
  let rows: InventoryRow[]
  try {
    rows = await api.get<InventoryRow[]>(`/api/inventory/branch/${encodeURIComponent(branch)}`)
    if (!Array.isArray(rows)) throw new Error('Catalog response was not an array')
  } catch (err) {
    if (err instanceof ApiError) {
      console.warn(`[pos] Catalog pull rejected (${err.status}):`, err.message)
    } else {
      console.warn('[pos] Catalog pull failed (offline or malformed response):', err)
    }
    return { ok: false, count: await getCatalogCount(), reason: 'error' }
  }

  const sellable = rows.filter(isSellable)
  if (sellable.length === 0) {
    console.warn('[pos] Catalog pull returned nothing sellable - keeping last-good catalog.')
    return { ok: false, count: await getCatalogCount(), reason: 'empty' }
  }

  // One transaction across both stores so the catalog and its bookkeeping
  // meta can never observably diverge (e.g. a crash leaving catalogBranch
  // pointing at the previous branch while the catalog itself is already new).
  const db = await getDb()
  const tx = db.transaction(['catalog', 'meta'], 'readwrite')
  const catalogStore = tx.objectStore('catalog')
  const metaStore = tx.objectStore('meta')
  await catalogStore.clear()
  const now = localTimestamp()
  await Promise.all([
    ...sellable.map((row) => catalogStore.put(row)),
    metaStore.put({ key: 'catalogFetchedAt', value: now }),
    metaStore.put({ key: 'catalogBranch', value: branch }),
    metaStore.put({ key: 'lastPullAt', value: now }),
  ])
  await tx.done

  return { ok: true, count: sellable.length }
}

export async function getCachedCatalog(): Promise<InventoryRow[]> {
  const db = await getDb()
  return db.getAll('catalog')
}

async function getCatalogCount(): Promise<number> {
  const db = await getDb()
  return db.count('catalog')
}
