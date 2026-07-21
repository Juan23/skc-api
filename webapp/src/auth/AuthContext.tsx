import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, ApiError, AUTH_EXPIRED_EVENT } from '../api/client'
import type { CurrentUser } from '../api/types'

interface AuthState {
  user: CurrentUser | null
  loading: boolean
  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null)
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()

  // /api/auth/me is the only source of truth for who's signed in - the cookie is
  // HttpOnly, so the browser can't inspect it and we must ask the server.
  const refresh = useCallback(async () => {
    try {
      setUser(await api.get<CurrentUser>('/api/auth/me'))
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setUser(null)
      else throw err
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // A 401 from any other endpoint means the session died mid-session (12h
  // expiry, a password change elsewhere, deactivation). Drop the user and send
  // them to login carrying where they were, so re-login resumes in place.
  // Never on /pos: the till's own sync engine (webapp-pos-plan.md §3) expects
  // a 401 mid-sync as a normal, recoverable event (session cookie expired ->
  // retry cookie-less) and must keep selling through it - this global
  // listener redirecting the tab away from the chromeless POS is exactly the
  // "fatal for a till" failure mode the plan calls out. AuthProvider wraps the
  // whole app (main.tsx), so this listener is always mounted regardless of
  // route; the guard has to live here, not in the POS code, since /pos never
  // calls useAuth() at all.
  useEffect(() => {
    const onExpired = () => {
      const p = window.location.pathname
      if (p === '/pos' || p.startsWith('/pos/')) return
      setUser(null)
      const here = window.location.pathname + window.location.search
      navigate(`/login?next=${encodeURIComponent(here)}`, { replace: true })
    }
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired)
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired)
  }, [navigate])

  const login = useCallback(async (username: string, password: string) => {
    await api.post('/api/auth/login', { username, password })
    await refresh()
  }, [refresh])

  const logout = useCallback(async () => {
    await api.post('/api/auth/logout')
    setUser(null)
    navigate('/login', { replace: true })
  }, [navigate])

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
