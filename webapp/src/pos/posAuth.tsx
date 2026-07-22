// Offline-auth gate for the web POS (webapp-pos-plan.md §3). The global
// AuthContext rethrows on network error and navigates to /login on any 401 -
// fatal for a till that must keep selling through both of those. This is a
// separate, POS-only provider that never redirects: it degrades through
// online / offline / signin-required instead.
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api, ApiError } from '../api/client'
import type { CurrentUser } from '../api/types'
import { getMeta, setMeta, signOutMeta, provisionMeta } from './db'

export interface PosIdentity {
  branchName: string
  username: string
}

// 'checking': first /api/auth/me call in flight, cached identity not read yet.
// 'online': the last check succeeded live.
// 'offline': the last check failed to reach the server at all (fetch threw).
// 'signin-required': the server reached us and said the session is invalid/
// expired (a real 401) - distinct from 'offline' because logging in again
// would fix this, whereas 'offline' just needs the network back.
export type PosAuthMode = 'checking' | 'online' | 'offline' | 'signin-required'

interface PosAuthState {
  // undefined = not yet read from IndexedDB; null = read, nothing cached (till
  // has never been provisioned - there is no branch to sell for yet).
  identity: PosIdentity | null | undefined
  mode: PosAuthMode
  login: (username: string, password: string) => Promise<void>
  // Clear this till's provisioning: end the server session AND forget the cached
  // branch identity, returning the device to the ProvisionScreen so it can be
  // set up for a (possibly different) branch. Queued sales in pendingSales are
  // deliberately left untouched - they carry their own branch tag and keep
  // syncing cookie-less via the IP-allowlist path regardless of who's signed in.
  logout: () => Promise<void>
  loginError: string
  loggingIn: boolean
}

const PosAuthContext = createContext<PosAuthState | null>(null)

const META_KEY = 'authIdentity'
// Durable "the operator explicitly signed out" flag. It has to outlive a reload,
// because a sign-out done offline can't invalidate the server session cookie -
// so on the next load a still-valid cookie would otherwise let check() silently
// re-provision the till to the branch it was just signed out of. This sentinel
// is what makes the mount check distinguish "never provisioned" (auto-adopt is
// fine) from "signed out on purpose" (must not auto-adopt; require a fresh
// explicit login). Cleared on the next successful login().
const META_SIGNED_OUT = 'signedOut'

// Only a Branch-role login carries a branchName - Owner/Office accounts have
// none, and PosSaleDto.Branch must be a real branch name (delivery_logs.to_branch
// convention). A non-Branch login can authenticate but can't provision a till.
function toIdentity(user: CurrentUser): PosIdentity | null {
  if (user.role !== 'Branch' || !user.branchName) return null
  return { branchName: user.branchName, username: user.username }
}

async function readCached(): Promise<PosIdentity | null> {
  try {
    return (await getMeta<PosIdentity>(META_KEY)) ?? null
  } catch {
    // IndexedDB unavailable (quota, a blocked version-change from another tab,
    // private-mode restrictions). Never let this wedge the till on a blank
    // "checking" screen - fall through with no cache so it at least renders
    // (ProvisionScreen) and the /api/auth/me probe below can still promote it.
    return null
  }
}

async function readSignedOut(): Promise<boolean> {
  try {
    return (await getMeta<boolean>(META_SIGNED_OUT)) === true
  } catch {
    // Same defensive stance as readCached: if we can't read the flag, don't
    // wedge - treat as "not signed out" and let the normal path decide.
    return false
  }
}

export function PosAuthProvider({ children }: { children: ReactNode }) {
  const [identity, setIdentity] = useState<PosIdentity | null | undefined>(undefined)
  const [mode, setMode] = useState<PosAuthMode>('checking')
  const [loginError, setLoginError] = useState('')
  const [loggingIn, setLoggingIn] = useState(false)
  const cancelledRef = useRef(false)
  // Read identity synchronously in async handlers without a stale closure -
  // login()'s branch-match guard depends on the till's *current* provisioned
  // branch, which the effect below may have set after login()'s closure formed.
  const identityRef = useRef<PosIdentity | null | undefined>(identity)
  identityRef.current = identity

  async function check() {
    const [cached, signedOut] = await Promise.all([readCached(), readSignedOut()])
    if (cancelledRef.current) return
    // When signed out, the cached identity (if a partial/failed delete left one
    // behind) must NOT be shown - render ProvisionScreen, not the POS. signedOut
    // is authoritative over cached in every path below, so a stale identity can
    // never re-provision the till after an explicit sign-out.
    setIdentity((prev) => prev ?? (signedOut ? null : cached) ?? null)

    try {
      const user = await api.get<CurrentUser>('/api/auth/me')
      if (cancelledRef.current) return
      const fresh = toIdentity(user)
      // Route a signed-out till into the !current branch regardless of any
      // lingering cached/in-memory identity, so the adopt-guard below applies.
      const current = signedOut ? null : (identityRef.current ?? cached)
      if (!current) {
        // Unprovisioned till: normally adopt whatever Branch identity the live
        // session carries (a non-Branch session leaves it null -> Provision).
        // But NOT if the operator explicitly signed out: that sentinel means an
        // in-flight cookie must not silently re-provision the till - they have
        // to log in again on purpose (which clears the sentinel).
        if (fresh && !signedOut) {
          setIdentity(fresh)
          try {
            await setMeta(META_KEY, fresh)
          } catch {
            /* persist best-effort; identity is already live in memory */
          }
        }
        setMode('online')
      } else if (fresh && fresh.branchName === current.branchName) {
        // Live session matches the till's branch - refresh (username may have
        // changed) and go online.
        setIdentity(fresh)
        try {
          await setMeta(META_KEY, fresh)
        } catch {
          /* persist best-effort; identity is already live in memory */
        }
        setMode('online')
      } else {
        // Server reachable, but the shared-origin session is for a *different*
        // branch (or a non-Branch account) - it can't sync this till's queued
        // sales (they're tagged with the till's own branch and the server would
        // reject them "not authorized"). Keep the till's identity, but surface
        // 'signin-required' so the badge doesn't show a false green "online"
        // over a silently-failing queue, and the overlay prompts a re-login as
        // the correct branch (login()'s branch-match guard enforces that).
        setMode('signin-required')
      }
    } catch (err) {
      if (cancelledRef.current) return
      if (err instanceof ApiError && err.status === 401) {
        setMode('signin-required')
      } else {
        // Anything else (fetch threw, a 5xx, a malformed response) is treated
        // as "can't reach the server right now" - the till keeps selling on
        // whatever's cached, same as a genuine network outage.
        setMode('offline')
      }
    }
  }

  useEffect(() => {
    cancelledRef.current = false
    void check()
    return () => {
      cancelledRef.current = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A deliberate, explicit credential entry (provisioning a new till, or the
  // mid-shift signin-required overlay). Unlike the passive mount check, this
  // validates the account before committing it: a non-Branch account, or a
  // Branch account for the *wrong* branch, must fail loudly rather than
  // silently no-op (blank provision form) or hijack the till's identity.
  async function login(username: string, password: string) {
    setLoginError('')
    setLoggingIn(true)
    try {
      await api.post('/api/auth/login', { username, password })
      const user = await api.get<CurrentUser>('/api/auth/me')
      const fresh = toIdentity(user)
      if (!fresh) {
        // Authenticated, but it's an Owner/Office account with no branch - it
        // can't run a till. Don't leave that session sitting on the device.
        await api.post('/api/auth/logout').catch(() => {})
        throw new Error('That is not a Branch account. Sign in with the branch login this till sells for.')
      }
      const current = identityRef.current
      if (current && current.branchName !== fresh.branchName) {
        await api.post('/api/auth/logout').catch(() => {})
        throw new Error(
          `This till is set up for ${current.branchName}. Sign in with a ${current.branchName} account, not ${fresh.branchName}.`,
        )
      }
      setIdentity(fresh)
      try {
        // Cache the identity AND clear the sign-out sentinel atomically: an
        // explicit, successful login is exactly the "provision on purpose"
        // event the sentinel was gating for, and doing both in one transaction
        // avoids the "identity cached but sentinel still set" partial state that
        // would bounce this freshly-logged-in till back to setup on next reload.
        await provisionMeta(META_KEY, fresh, META_SIGNED_OUT)
      } catch {
        /* persist best-effort; identity is already live in memory */
      }
      setMode('online')
    } catch (err) {
      setLoginError(
        err instanceof ApiError && err.status === 429
          ? 'Too many attempts. Wait a few minutes and try again.'
          : err instanceof Error
            ? err.message
            : 'Sign-in failed.',
      )
      throw err
    } finally {
      setLoggingIn(false)
    }
  }

  // Sign out and de-provision this till. Three things, in order:
  //  1. cancelledRef -> true so the still-in-flight mount check() (which may be
  //     awaiting /api/auth/me) can't resume and re-adopt the stale identity from
  //     its captured `cached` closure a moment after we clear it. check() only
  //     runs once at mount, so permanently cancelling it here is safe.
  //  2. Best-effort server logout. Offline it'll fail (swallowed) - which is
  //     exactly why we also persist the sentinel: the cookie may still be valid,
  //     so a durable local flag is what makes the sign-out stick across reloads.
  //  3. Persist the signed-out sentinel and forget the cached identity in ONE
  //     atomic IndexedDB transaction (signOutMeta), so there's no partial state
  //     ("sentinel set, identity still cached") that the next mount check could
  //     misread as "still provisioned" and re-adopt from a valid cookie.
  // pendingSales/syncedLog are intentionally left alone - queued sales keep
  // syncing cookie-less via the IP-allowlist path regardless of who's signed in.
  async function logout() {
    cancelledRef.current = true
    await api.post('/api/auth/logout').catch(() => {})
    try {
      await signOutMeta(META_SIGNED_OUT, META_KEY)
    } catch {
      /* durable flag best-effort; the in-memory sign-out below still happens.
         check() also guards on the sentinel, so even a totally-failed persist
         only degrades to "re-adopt on next reload" - never a mid-session flip. */
    }
    setIdentity(null)
    setLoginError('')
    setMode('checking')
  }

  return (
    <PosAuthContext.Provider value={{ identity, mode, login, logout, loginError, loggingIn }}>
      {children}
    </PosAuthContext.Provider>
  )
}

export function usePosAuth(): PosAuthState {
  const ctx = useContext(PosAuthContext)
  if (!ctx) throw new Error('usePosAuth must be used inside <PosAuthProvider>')
  return ctx
}
