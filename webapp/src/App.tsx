import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { Layout } from './components/Layout'
import { RequireRole } from './components/RequireRole'
import { useAuth } from './auth/AuthContext'
import { Login } from './pages/Login'
import { Setup } from './pages/Setup'
import { ChangePassword } from './pages/ChangePassword'
import { OfficeHome } from './pages/office/OfficeHome'
import { BranchHome } from './pages/branch/BranchHome'
import { OwnerHome } from './pages/owner/OwnerHome'

// Signed-in landing: each role starts on its own section.
function Home() {
  const { user, loading } = useAuth()
  if (loading) return <p className="muted">Loading…</p>
  if (!user) return <Navigate to="/login" replace />
  if (user.role === 'Branch') return <Navigate to="/branch" replace />
  if (user.role === 'Office') return <Navigate to="/office" replace />
  return <Navigate to="/owner" replace />
}

export function App() {
  const { user } = useAuth()
  const location = useLocation()

  // A must-change-password account can't reach anything else. The server doesn't
  // enforce this (the flag is advisory there) - it exists so a shared account's
  // owner-issued password gets replaced by the person actually using it.
  if (user?.mustChangePassword && location.pathname !== '/change-password') {
    return <Navigate to="/change-password" replace />
  }

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/setup" element={<Setup />} />
      <Route path="/change-password" element={<ChangePassword />} />
      <Route element={<Layout />}>
        <Route path="/" element={<Home />} />
        <Route
          path="/office/*"
          element={
            <RequireRole roles={['Office']}>
              <OfficeHome />
            </RequireRole>
          }
        />
        <Route
          path="/branch/*"
          element={
            <RequireRole roles={['Branch']}>
              <BranchHome />
            </RequireRole>
          }
        />
        <Route
          path="/owner/*"
          element={
            <RequireRole roles={[]}>
              <OwnerHome />
            </RequireRole>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
