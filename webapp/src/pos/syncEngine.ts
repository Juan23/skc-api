// Sync engine for the offline-first web POS (webapp-pos-plan.md Increment 5).
// Push-then-pull, mirrors the WinForms PosSyncEngine: push sales first so the
// pulled stock snapshot already reflects them. A reentrancy guard stops the
// 60s timer and a post-sale trigger from ever overlapping - two concurrent
// pushes of the same pendingSales row would both send it, relying entirely on
// server idempotency to avoid a visible double-row (harmless there, but
// pointless network traffic and noise to reason about for no benefit).
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../api/client'
import type { PosSaleDto, PosSaleLineDto, PosSaleSyncResult } from '../api/types'
import { getDb } from './db'
import type { PendingSale } from './db'
import { pullCatalog } from './catalogSync'
import { centavosToWireNumber } from './money'
import { localTimestamp } from '../lib/format'

const SYNC_INTERVAL_MS = 60_000

export type PosSyncStatus = 'idle' | 'syncing' | 'offline' | 'synced' | 'sync-error'

function toWireDto(sale: PendingSale): PosSaleDto {
  const lines: PosSaleLineDto[] = sale.lines.map((l) => ({
    sku: l.sku,
    description: l.description,
    qty: l.qty,
    unitPrice: centavosToWireNumber(l.unitPriceCentavos),
    lineTotal: centavosToWireNumber(l.lineTotalCentavos),
  }))
  return {
    clientSaleId: sale.clientSaleId,
    branch: sale.branch,
    staffName: sale.staffName,
    soldAt: sale.soldAt,
    totalAmount: centavosToWireNumber(sale.totalCentavos),
    lines,
  }
}

// A per-sale "Rejected" result whose detail names the IP-gate specifically
// (see Program.cs's IsTrustedBranchCaller check on POST /api/sales) is worth
// retrying - the caller's trusted-IP status can change (branch onboarding,
// the office laptop moving networks), unlike a bad-data rejection which never
// will. Left in the queue untouched (still syncState:'pending') so the next
// cycle just tries again, identical to a sale that hasn't synced yet.
function isRetryableRejection(detail: string): boolean {
  return detail.toLowerCase().includes('not authorized')
}

async function movePendingToSyncedLog(clientSaleId: string, status: PosSaleSyncResult['status']) {
  const db = await getDb()
  const tx = db.transaction(['pendingSales', 'syncedLog'], 'readwrite')
  const pending = await tx.objectStore('pendingSales').get(clientSaleId)
  if (pending) {
    await tx.objectStore('syncedLog').put({
      clientSaleId: pending.clientSaleId,
      branch: pending.branch,
      staffName: pending.staffName,
      soldAt: pending.soldAt,
      lines: pending.lines,
      totalCentavos: pending.totalCentavos,
      tenderedCentavos: pending.tenderedCentavos,
      changeCentavos: pending.changeCentavos,
      status: status as 'Synced' | 'SyncedWithShortfall' | 'AlreadySynced',
      syncedAt: localTimestamp(),
    })
    await tx.objectStore('pendingSales').delete(clientSaleId)
  }
  await tx.done
}

async function markTerminalRejection(clientSaleId: string, detail: string) {
  const db = await getDb()
  const sale = await db.get('pendingSales', clientSaleId)
  if (!sale) return
  await db.put('pendingSales', { ...sale, syncState: 'error', syncError: detail })
}

// One POST batch of every currently-pending sale, applying the plan's exact
// error taxonomy per result. Returns false only for a batch-level failure
// (network down, or the server itself rejected the whole request) - per-sale
// Rejected results are NOT a batch failure, so a genuinely bad sale doesn't
// stop its siblings in the same batch from syncing.
async function pushPendingSales(): Promise<{ ok: boolean; offline: boolean }> {
  const db = await getDb()
  const all = await db.getAllFromIndex('pendingSales', 'bySyncState', 'pending')
  if (all.length === 0) return { ok: true, offline: false }

  const dtos = all.map(toWireDto)

  async function post(): Promise<PosSaleSyncResult[]> {
    return api.post<PosSaleSyncResult[]>('/api/sales', dtos)
  }

  let results: PosSaleSyncResult[]
  try {
    results = await post()
  } catch (err) {
    // A 401 here means the session cookie just expired mid-batch - the
    // server's response already cleared it, so an immediate retry rides
    // cookie-less into the IP-gated path (webapp-pos-plan.md §3), draining
    // the queue without waiting a full 60s. Retried only once: a second 401
    // would mean something else is wrong, not just an expiring session.
    if (err instanceof ApiError && err.status === 401) {
      try {
        results = await post()
      } catch (retryErr) {
        return { ok: false, offline: !(retryErr instanceof ApiError) }
      }
    } else {
      return { ok: false, offline: !(err instanceof ApiError) }
    }
  }

  for (const r of results) {
    if (r.status === 'Rejected') {
      if (isRetryableRejection(r.detail)) continue
      await markTerminalRejection(r.clientSaleId, r.detail)
    } else {
      await movePendingToSyncedLog(r.clientSaleId, r.status)
    }
  }
  return { ok: true, offline: false }
}

export interface UsePosSyncOptions {
  branchName: string | null
  onCatalogChanged?: () => void
}

export interface PosSyncState {
  status: PosSyncStatus
  pendingCount: number
  lastError: string | null
  triggerSync: () => void
}

export function usePosSync({ branchName, onCatalogChanged }: UsePosSyncOptions): PosSyncState {
  const [status, setStatus] = useState<PosSyncStatus>('idle')
  const [pendingCount, setPendingCount] = useState(0)
  const [lastError, setLastError] = useState<string | null>(null)
  const runningRef = useRef(false)
  const branchRef = useRef(branchName)
  branchRef.current = branchName

  const refreshPendingCount = useCallback(async () => {
    const db = await getDb()
    const pending = await db.getAllFromIndex('pendingSales', 'bySyncState', 'pending')
    const errored = await db.getAllFromIndex('pendingSales', 'bySyncState', 'error')
    setPendingCount(pending.length + errored.length)
    return { pendingLeft: pending.length, erroredLeft: errored.length }
  }, [])

  const runSync = useCallback(async () => {
    if (runningRef.current) return
    runningRef.current = true
    setStatus('syncing')
    try {
      const pushResult = await pushPendingSales()
      const { pendingLeft, erroredLeft } = await refreshPendingCount()

      const branch = branchRef.current
      if (branch) {
        const pull = await pullCatalog(branch)
        if (pull.ok) onCatalogChanged?.()
      }

      if (!pushResult.ok) {
        setStatus(pushResult.offline ? 'offline' : 'sync-error')
        setLastError(pushResult.offline ? null : 'Could not reach the server to sync sales.')
      } else if (erroredLeft > 0) {
        setStatus('sync-error')
        setLastError(`${erroredLeft} sale${erroredLeft === 1 ? '' : 's'} rejected by the server - needs office attention.`)
      } else if (pendingLeft > 0) {
        // Push succeeded for everything it sent, but something new landed in
        // pendingSales while this cycle was running (a sale rung mid-sync) -
        // leave status as-is, the next tick (or the sale's own trigger) picks
        // it up rather than misreporting "synced" with a queue still non-empty.
        setStatus('idle')
        setLastError(null)
      } else {
        setStatus('synced')
        setLastError(null)
      }
    } catch (err) {
      // getDb()/IndexedDB itself failed (quota, a blocked version-change, a
      // corrupted store) - only the network post() is guarded above, so this
      // is the local-storage path throwing. The badge must never lie
      // "SYNCING..." forever: surface it. getDb() resets its promise and
      // retries fresh next tick, so a transient failure self-heals.
      setStatus('sync-error')
      setLastError('Local sales storage is unavailable - sync paused.')
      console.error('POS sync cycle failed:', err)
    } finally {
      runningRef.current = false
    }
  }, [onCatalogChanged, refreshPendingCount])

  useEffect(() => {
    void runSync()
    const id = setInterval(() => void runSync(), SYNC_INTERVAL_MS)
    return () => clearInterval(id)
  }, [runSync])

  return { status, pendingCount, lastError, triggerSync: () => void runSync() }
}
