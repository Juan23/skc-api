import { ProductionView } from '../../components/ProductionView'
import { useAuth } from '../../auth/AuthContext'

// Mirrors frmProductionHistory in the branch app. Scoped to the session's own
// branch - there is no picker, because a Branch account has exactly one branch.
export function ProductionHistory() {
  const { user } = useAuth()
  if (!user?.branchName) return <p className="muted">This account isn't tied to a branch.</p>
  return (
    <section>
      <h1>Production — {user.branchName}</h1>
      <ProductionView branch={user.branchName} />
    </section>
  )
}
