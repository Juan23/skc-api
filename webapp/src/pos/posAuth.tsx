// Offline-auth gate for the web POS (webapp-pos-plan.md §3). The global
// AuthContext rethrows on network error and navigates to /login on any 401 -
// fatal for a till that must keep selling through both of those. This is a
// separate, POS-only provider that never redirects: it degrades through
// online / offline / signin-required instead.
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api, ApiError } from '../api/client'
import type { CurrentUser } from '../api/types'
import { getMeta, setMeta } from './db'

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
  loginError: string
  loggingIn: boolean
}

const PosAuthContext = createContext<PosAuthState | null>(null)

const META_KEY = 'authIdentity'

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
    const cached = await readCached()
    if (cancelledRef.current) return
    setIdentity((prev) => prev ?? cached ?? null)

    try {
      const user = await api.get<CurrentUser>('/api/auth/me')
      if (cancelledRef.current) return
      const fresh = toIdentity(user)
      const current = identityRef.current ?? cached
      if (!current) {
        // Unprovisioned till: adopt whatever Branch identity the live session
        // carries (a non-Branch session leaves it null -> ProvisionScreen).
        if (fresh) {
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
        await setMeta(META_KEY, fresh)
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

  return (
    <PosAuthContext.Provider value={{ identity, mode, login, loginError, loggingIn }}>
      {children}
    </PosAuthContext.Provider>
  )
}

export function usePosAuth(): PosAuthState {
  const ctx = useContext(PosAuthContext)
  if (!ctx) throw new Error('usePosAuth must be used inside <PosAuthProvider>')
  return ctx
}
