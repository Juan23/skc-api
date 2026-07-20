import { Navigate, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useAuth } from '../auth/AuthContext'
import type { Role } from '../api/types'

// IMPORTANT: route guards are UX only. They keep the wrong nav items and screens
// out of someone's way; they are NOT the security boundary. Every restricted
// action is enforced server-side by the role+IP gates in Program.cs, which is
// what actually stops a Branch user from doing office work - editing this file
// (or the bundle in devtools) grants nobody a single extra permission.
export function RequireRole({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { user, loading } = useAuth()
  const location = useLocation()

  if (loading) return <p className="muted">Loading…</p>
  if (!user) {
    const next = encodeURIComponent(location.pathname + location.search)
    return <Navigate to={`/login?next=${next}`} replace />
  }
  // Owner is a superuser in the UI as well as in the gates.
  if (user.role !== 'Owner' && !roles.includes(user.role)) {
    return <Navigate to="/" replace />
  }
  return <>{children}</>
}
