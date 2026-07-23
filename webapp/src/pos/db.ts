// IndexedDB store for the offline-first web POS (webapp-pos-plan.md
// Increment 2). Four stores, all declared now even though pendingSales/
// syncedLog stay unused until Increment 4/6 - the schema shouldn't need a
// version bump partway through this feature.
import { openDB } from 'idb'
import type { DBSchema, IDBPDatabase } from 'idb'
import type { InventoryRow } from '../api/types'

const DB_NAME = 'skc-pos'
const DB_VERSION = 1

export type SyncState = 'pending' | 'syncing' | 'error'

// A discount line has sku: null (see webapp-pos-plan.md §5). Money is integer
// centavos throughout - never a float - captured once when the line is added
// so a later price change can't retroactively alter an already-rung sale.
export interface PosSaleLine {
  sku: string | null
  description: string
  qty: number
  unitPriceCentavos: number
  lineTotalCentavos: number
}

// Lines are embedded, not a separate store keyed by clientSaleId - see
// webapp-pos-plan.md §1: a completed sale is one atomic `put`, so there is no
// interleaving where a header exists without its lines.
export interface PendingSale {
  clientSaleId: string
  branch: string
  staffName: string
  soldAt: string // localTimestamp() - counter wall-clock, no timezone offset
  lines: PosSaleLine[]
  totalCentavos: number
  tenderedCentavos: number
  changeCentavos: number
  paymentMethod: string // Cash | GCash | GCash Terminal | Foodpanda
  syncState: SyncState
  syncError?: string
}

export interface SyncedSale {
  clientSaleId: string
  branch: string
  staffName: string
  soldAt: string
  lines: PosSaleLine[]
  totalCentavos: number
  tenderedCentavos: number
  changeCentavos: number
  paymentMethod: string // Cash | GCash | GCash Terminal | Foodpanda
  status: 'Synced' | 'SyncedWithShortfall' | 'AlreadySynced' | 'Voided'
  syncedAt: string
}

// kv bag: authIdentity, catalogFetchedAt, catalogBranch, schemaVersion,
// lastPullAt (see webapp-pos-plan.md's db.ts table). Untyped value on purpose -
// this store holds a handful of unrelated scalars/objects, not one shape.
interface MetaRow {
  key: string
  value: unknown
}

interface PosDBSchema extends DBSchema {
  catalog: {
    key: string // sku
    value: InventoryRow
  }
  pendingSales: {
    key: string // clientSaleId
    value: PendingSale
    indexes: { bySoldAt: string; bySyncState: string }
  }
  syncedLog: {
    key: string // clientSaleId
    value: SyncedSale
  }
  meta: {
    key: string
    value: MetaRow
  }
}

// NOTE for whoever bumps this next: the `if (!db.objectStoreNames.contains(...))`
// guards below only cover "create this store from scratch". Adding a new INDEX
// to an already-existing store later (e.g. a byBranch index on syncedLog) is a
// different case - naively dropping a `createIndex` call inside one of these
// `if` blocks silently no-ops, since the block is skipped once the store
// already exists. That needs DB_VERSION bumped and the new index created via
// the upgrade callback's `transaction` param against the EXISTING store
// (`transaction.objectStore(name).createIndex(...)`), not `createObjectStore`.
let dbPromise: Promise<IDBPDatabase<PosDBSchema>> | null = null

export function getDb(): Promise<IDBPDatabase<PosDBSchema>> {
  if (!dbPromise) {
    // If openDB() ever rejects (storage restrictions, quota, a `blocked` event),
    // dbPromise must not stay wedged on that failure - reset so the next call
    // gets a fresh attempt instead of permanently re-throwing for the rest of
    // the tab's life. This app has to survive a whole offline counter day, so
    // a transient open failure early on can't become a permanent one.
    dbPromise = openDB<PosDBSchema>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('catalog')) {
          db.createObjectStore('catalog', { keyPath: 'sku' })
        }
        if (!db.objectStoreNames.contains('pendingSales')) {
          const store = db.createObjectStore('pendingSales', { keyPath: 'clientSaleId' })
          store.createIndex('bySoldAt', 'soldAt')
          store.createIndex('bySyncState', 'syncState')
        }
        if (!db.objectStoreNames.contains('syncedLog')) {
          db.createObjectStore('syncedLog', { keyPath: 'clientSaleId' })
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' })
        }
      },
    }).catch((err) => {
      dbPromise = null
      throw err
    })
  }
  return dbPromise
}

export async function getMeta<T>(key: string): Promise<T | undefined> {
  const db = await getDb()
  const row = await db.get('meta', key)
  return row?.value as T | undefined
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  const db = await getDb()
  await db.put('meta', { key, value })
}

// Atomically set the signed-out sentinel AND forget the cached identity in a
// SINGLE meta transaction. Doing these as two separate awaited writes risks a
// partial state (sentinel set, identity still cached) that the POS mount check
// would misread as "still provisioned" and silently re-adopt from a valid
// cookie - see posAuth's logout(). One transaction commits both or neither.
// The request promises are awaited alongside tx.done via Promise.all so a
// failing request surfaces as a rejection (caught by the caller) rather than a
// bare unhandled rejection.
export async function signOutMeta(signedOutKey: string, identityKey: string): Promise<void> {
  const db = await getDb()
  const tx = db.transaction('meta', 'readwrite')
  await Promise.all([tx.store.put({ key: signedOutKey, value: true }), tx.store.delete(identityKey), tx.done])
}

// The provisioning counterpart: atomically cache the identity AND clear the
// signed-out sentinel in one transaction, so an explicit login can't leave the
// "identity cached but sentinel still true" partial state (which the mount
// check treats sentinel-first, bouncing the freshly-logged-in till back to the
// setup screen on next reload). One transaction commits both or neither.
export async function provisionMeta(identityKey: string, identity: unknown, signedOutKey: string): Promise<void> {
  const db = await getDb()
  const tx = db.transaction('meta', 'readwrite')
  await Promise.all([tx.store.put({ key: identityKey, value: identity }), tx.store.delete(signedOutKey), tx.done])
}
