import { useAuth } from '../../auth/AuthContext'

// Phase 1 shell. Phase 2 adds Stock/ProductionHistory/SalesHistory; Phase 5 adds
// delivery acceptance and production entry. The POS stays in WinForms until
// Phase 7, deliberately.
export function BranchHome() {
  const { user } = useAuth()
  return (
    <section>
      <h1>Branch{user?.branchName ? ` — ${user.branchName}` : ''}</h1>
      <p className="muted">
        Stock, deliveries and production arrive in the next phases. Keep using the WinForms branch
        app, and the WinForms POS for the counter.
      </p>
    </section>
  )
}
