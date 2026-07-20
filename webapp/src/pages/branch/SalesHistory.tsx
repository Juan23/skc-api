import { SalesView } from '../../components/SalesView'
import { useAuth } from '../../auth/AuthContext'

// The branch's own POS sales. Read-only: voiding a sale stays in the WinForms
// POS for now (the web POS is phase 7).
export function SalesHistory() {
  const { user } = useAuth()
  if (!user?.branchName) return <p className="muted">This account isn't tied to a branch.</p>
  return (
    <section>
      <h1>Sales — {user.branchName}</h1>
      <SalesView branch={user.branchName} />
    </section>
  )
}
