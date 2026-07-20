import { StockView } from '../../components/StockView'
import { useAuth } from '../../auth/AuthContext'

// The branch's own stock. Scoped to the session's branch - there is no picker,
// because a branch user has exactly one branch.
export function Stock() {
  const { user } = useAuth()
  if (!user?.branchName) return <p className="muted">This account isn't tied to a branch.</p>
  return (
    <section>
      <h1>Stock — {user.branchName}</h1>
      <StockView branch={user.branchName} />
    </section>
  )
}
