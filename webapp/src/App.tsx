import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { Layout } from './components/Layout'
import { RequireRole } from './components/RequireRole'
import { useAuth } from './auth/AuthContext'
import { Login } from './pages/Login'
import { Setup } from './pages/Setup'
import { ChangePassword } from './pages/ChangePassword'
import { OfficeSection } from './pages/office/OfficeSection'
import { BranchSection } from './pages/branch/BranchSection'
import { OwnerSection } from './pages/owner/OwnerSection'

// Signed-in landing: each role starts on its own section. The Owner lands on
// Office, which is where the reports they actually read live (the Owner section
// is admin: users, recipes, pricing).
function Home() {
  const { user, loading } = useAuth()
  if (loading) return <p className="muted">Loading…</p>
  if (!user) return <Navigate to="/login" replace />
  if (user.role === 'Branch') return <Navigate to="/branch" replace />
  return <Navigate to="/office" replace />
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
              <OfficeSection />
            </RequireRole>
          }
        />
        <Route
          path="/branch/*"
          element={
            <RequireRole roles={['Branch']}>
              <BranchSection />
            </RequireRole>
          }
        />
        <Route
          path="/owner/*"
          element={
            <RequireRole roles={[]}>
              <OwnerSection />
            </RequireRole>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
