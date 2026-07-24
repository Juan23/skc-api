// Staff-list pull + offline PIN verification for the POS cashier picker.
// Mirrors catalogSync.ts: pulled on every sync cycle, cached in IndexedDB (the
// generic `meta` kv store - the list is small, no dedicated object store or
// DB_VERSION bump needed), read by the sale screen from cache only.
//
// Security posture, explicitly accepted: each cashier's PIN salt+hash is cached
// on the till so a 4-digit PIN can be verified with no network. 10,000
// combinations against a client-held SHA-256 is trivially brute-forceable by
// anyone who opens DevTools - by design. This is accountability-grade ("the
// name on a sale is a real cashier who knew their own PIN"), not access
// control; the trust boundary remains Tailscale + device tiers.
import { api } from '../api/client'
import type { PosStaffPublic } from '../api/types'
import { localTimestamp } from '../lib/format'
import { getDb, getMeta } from './db'

const KEY_LIST = 'staffList'
const KEY_BRANCH = 'staffBranch'
const KEY_FETCHED_AT = 'staffFetchedAt'

export interface StaffPullResult {
  ok: boolean
}

// One deliberate difference from pullCatalog: a well-formed EMPTY array is
// applied, not treated as a bad pull. "This branch has no cashiers" is a
// legitimate, meaningful state - it's what re-enables the free-text staff-name
// fallback, and therefore the owner's rollback path (delete a branch's staff ->
// its tills revert on next sync). Only a failure to reach/parse the server
// keeps last-good, so an offline shift keeps its picker.
export async function pullStaff(branch: string): Promise<StaffPullResult> {
  let rows: PosStaffPublic[]
  try {
    rows = await api.get<PosStaffPublic[]>(`/api/staff/branch/${encodeURIComponent(branch)}`)
    if (!Array.isArray(rows)) throw new Error('Staff response was not an array')
  } catch (err) {
    console.warn('[pos] Staff pull failed - keeping last-good staff list:', err)
    return { ok: false }
  }

  // Same one-transaction discipline as pullCatalog: the list and its
  // bookkeeping meta can never observably diverge.
  const db = await getDb()
  const tx = db.transaction('meta', 'readwrite')
  await Promise.all([
    tx.store.put({ key: KEY_LIST, value: rows }),
    tx.store.put({ key: KEY_BRANCH, value: branch }),
    tx.store.put({ key: KEY_FETCHED_AT, value: localTimestamp() }),
    tx.done,
  ])
  return { ok: true }
}

// Cache read for the sale screen. Returns [] (-> free-text fallback) unless the
// cached list belongs to THIS branch - a till re-provisioned to a different
// branch must not offer the old branch's cashiers. Any IndexedDB failure also
// degrades to [] rather than crashing the sale screen: a broken cache means
// "no picker", never "no selling".
export async function getCachedStaff(branch: string): Promise<PosStaffPublic[]> {
  try {
    const cachedBranch = await getMeta<string>(KEY_BRANCH)
    if (cachedBranch !== branch) return []
    return (await getMeta<PosStaffPublic[]>(KEY_LIST)) ?? []
  } catch {
    return []
  }
}

// The picker is only offered when SubtleCrypto exists (it always should - the
// POS runs on the HTTPS tailnet origin or localhost dev, both secure contexts -
// but if it somehow doesn't, showing a picker that can never verify would block
// selling; the free-text fallback can't).
export function pinVerificationAvailable(): boolean {
  return typeof crypto !== 'undefined' && typeof crypto.subtle?.digest === 'function'
}

// Offline PIN check. Must match the server's HashPin in Program.cs exactly:
// lowercase hex SHA-256 of the UTF-8 bytes of (pin_salt || pin). Compared
// lowercased on both sides as belt-and-braces against hex-casing drift.
export async function verifyPin(member: PosStaffPublic, pin: string): Promise<boolean> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(member.pinSalt + pin))
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return hex === member.pinHash.toLowerCase()
}
