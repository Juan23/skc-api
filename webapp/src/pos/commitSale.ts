// The durable-commit sequence (webapp-pos-plan.md Increment 4 - "the core
// no-loss guarantee"). A sale is durable the instant it lands in IndexedDB,
// before the UI updates or anything else happens - a crash after that point
// is harmless (the sync engine, once it exists, re-pushes and the server's
// idempotency on (branch, clientSaleId) makes that a no-op); a crash before
// it means the cashier never saw a confirmation and the sale legitimately
// didn't happen. Ordered exactly like the WinForms POS's own commit path.
import { localTimestamp } from '../lib/format'
import { getDb } from './db'
import type { PendingSale } from './db'
import type { CartLine } from './useCart'

export interface SaleToCommit {
  staffName: string
  lines: CartLine[]
  totalCentavos: number
  tenderedCentavos: number | null
  changeCentavos: number | null
}

export async function commitSale(sale: SaleToCommit, branch: string): Promise<PendingSale> {
  // 1. Build the record in memory. `key` is React-only bookkeeping from the
  // cart, never persisted.
  const record: PendingSale = {
    clientSaleId: crypto.randomUUID(),
    branch,
    staffName: sale.staffName,
    soldAt: localTimestamp(),
    lines: sale.lines.map(({ key: _key, ...line }) => line),
    totalCentavos: sale.totalCentavos,
    tenderedCentavos: sale.tenderedCentavos ?? 0,
    changeCentavos: sale.changeCentavos ?? 0,
    syncState: 'pending',
  }

  // 2. Durable commit FIRST. `durability: 'strict'` forces the fsync a
  // power cut could otherwise race past under Chrome's default 'relaxed'
  // mode (which can fire the transaction's complete event before the OS has
  // actually flushed to disk) - awaiting `tx.done` is what actually waits
  // for that commit, not just the individual add() request's own success.
  // Used only for this write; the catalog decrement below is advisory and
  // self-heals, so it stays on the default durability.
  const db = await getDb()
  const saleTx = db.transaction('pendingSales', 'readwrite', { durability: 'strict' })
  await saleTx.store.add(record)
  await saleTx.done

  // 3. Decrement cached stock for sold SKUs (never discount lines). Advisory
  // only - the next catalog pull overwrites it with the server's real count
  // regardless - so a crash OR a thrown error here just means a slightly
  // stale cached number until then, not a lost sale. Floored at 0 like the
  // WinForms cache. Wrapped in try/catch so a failure here (quota error, a
  // blocked/versionchange from another tab) can never surface as a rejected
  // commitSale() - the sale is already durable by this point (step 2), and a
  // caller reacting to a rejection by retrying would mint a brand-new
  // clientSaleId for the same cart, which the server's (branch, clientSaleId)
  // idempotency does not dedupe against the first one.
  try {
    const catalogTx = db.transaction('catalog', 'readwrite')
    for (const line of record.lines) {
      if (line.sku == null) continue
      const row = await catalogTx.store.get(line.sku)
      if (row) {
        row.currentstock = Math.max(0, row.currentstock - line.qty)
        await catalogTx.store.put(row)
      } else {
        console.warn(`commitSale: SKU ${line.sku} not in cached catalog, skipping stock decrement`)
      }
    }
    await catalogTx.done
  } catch (err) {
    console.warn('commitSale: catalog stock decrement failed (advisory only, sale is already durable)', err)
  }

  // 4 (clear cart, show change, log the sale) and 5 (fire the sync engine)
  // are the caller's responsibility once the sale is safely durable - this
  // function's only job is steps 1-3. The sync engine itself is Increment 5;
  // until it exists, a committed sale simply waits in pendingSales.
  return record
}
