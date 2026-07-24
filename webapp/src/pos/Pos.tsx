// The chromeless top-level web POS page (webapp-pos-plan.md §5b, Increment 5).
// A sibling of /login, not nested under <Layout>/<AuthProvider>'s role
// sections - no Stock/Deliveries/Production/Sales nav, matching the plan's
// decision #2 ("POS is a POS, nothing else").
import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { InventoryRow, PosStaffPublic } from '../api/types'
import { commitSale } from './commitSale'
import type { CompletedSale } from './SaleScreen'
import { SaleScreen } from './SaleScreen'
import { getCachedCatalog } from './catalogSync'
import { getCachedStaff } from './staffSync'
import { PosAuthProvider, usePosAuth } from './posAuth'
import { PosStatusBadge } from './PosStatusBadge'
import { usePosSync } from './syncEngine'
import { DayLog } from './DayLog'
import { DayReport } from './DayReport'
import './pos.css'

type PosView = 'sell' | 'daylog' | 'report'

function PosNav({ view, onChange }: { view: PosView; onChange: (v: PosView) => void }) {
  const tab = (v: PosView, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={view === v}
      className={`pos-nav-btn${view === v ? ' active' : ''}`}
      onClick={() => onChange(v)}
    >
      {label}
    </button>
  )
  return (
    <div className="pos-nav" role="tablist" aria-label="POS views">
      {tab('sell', 'Sell')}
      {tab('daylog', "Today's sales")}
      {tab('report', 'Report')}
    </div>
  )
}

function SignInForm({
  onSubmit,
  busy,
  error,
  submitLabel,
}: {
  onSubmit: (username: string, password: string) => void
  busy: boolean
  error: string
  submitLabel: string
}) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  function submit(e: FormEvent) {
    e.preventDefault()
    onSubmit(username, password)
  }

  return (
    <form onSubmit={submit}>
      <input
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        placeholder="Username"
        autoFocus
        aria-label="Username"
      />
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Password"
        aria-label="Password"
      />
      {error && <p className="error">{error}</p>}
      <button className="btn primary" disabled={busy}>
        {busy ? 'Signing in…' : submitLabel}
      </button>
    </form>
  )
}

// This till has never had a Branch login - there is no cached branchName, so
// there is nothing to sell against yet. Blocking (not an overlay) is correct
// here: unlike the mid-shift signin-required case, the queue is empty and
// there's no cart to protect - a redirect-free in-place form is enough.
function ProvisionScreen() {
  const auth = usePosAuth()
  async function submit(username: string, password: string) {
    try {
      await auth.login(username, password)
    } catch {
      /* error already surfaced via auth.loginError */
    }
  }
  return (
    <div className="pos-provision">
      <div className="card">
        <h1>Set up this till</h1>
        <p className="muted">Sign in with a Branch account once to tell this device which branch it sells for.</p>
        <SignInForm onSubmit={submit} busy={auth.loggingIn} error={auth.loginError} submitLabel="Set up till" />
      </div>
    </div>
  )
}

// NOTE (2026-07-24): there used to be a SignInOverlay here, shown whenever the
// 12h branch session expired ('signin-required'). Removed at the owner's
// direction: tills are shut down nightly, so the expired-session card appeared
// EVERY morning asking cashiers for the branch password - a credential only
// the owner should hold (cashiers have their own PINs). The session isn't
// needed for operation anyway: sales sync cookie-less through the device/IP
// gates, and catalog/staff pulls are ungated GETs. The branch credential's
// only POS job is the one-time enrollment (ProvisionScreen above); everything
// else it guards lives in the /branch webapp screens, which keep their login.
function PosInner() {
  const auth = usePosAuth()
  const [catalog, setCatalog] = useState<InventoryRow[]>([])
  const [staff, setStaff] = useState<PosStaffPublic[]>([])
  const [view, setView] = useState<PosView>('sell')

  const refreshCatalog = useCallback(() => {
    void getCachedCatalog().then(setCatalog)
  }, [])

  useEffect(() => {
    refreshCatalog()
  }, [refreshCatalog])

  const branchName = auth.identity?.branchName ?? null

  // Cached-staff mirror of refreshCatalog, keyed on branchName because the
  // cache read is branch-guarded (a till re-provisioned to another branch must
  // not show the old branch's cashiers). Re-runs when the identity resolves
  // null -> branch on mount, same reason as the syncEngine's branchName dep.
  const refreshStaff = useCallback(() => {
    if (branchName) void getCachedStaff(branchName).then(setStaff)
    else setStaff([])
  }, [branchName])

  useEffect(() => {
    refreshStaff()
  }, [refreshStaff])

  const sync = usePosSync({ branchName, onCatalogChanged: refreshCatalog, onStaffChanged: refreshStaff })

  const handleComplete = useCallback(
    async (sale: CompletedSale) => {
      if (!branchName) throw new Error('This till has no branch identity - cannot record a sale.')
      await commitSale(sale, branchName)
      refreshCatalog()
      sync.triggerSync()
    },
    [branchName, refreshCatalog, sync],
  )

  if (auth.identity === undefined) return null // reading IndexedDB, instant in practice
  if (auth.identity === null) return <ProvisionScreen />

  return (
    <div className="pos-page">
      <PosNav view={view} onChange={setView} />
      <PosStatusBadge authMode={auth.mode} syncStatus={sync.status} pendingCount={sync.pendingCount} />
      {/* Both views stay mounted; only 'sell' is display:none'd when hidden so a
          part-built cart isn't lost by switching to the day log and back. The
          day log remounts each time it's shown (keyed by view) to re-pull. */}
      <div style={{ display: view === 'sell' ? 'contents' : 'none' }}>
        <SaleScreen catalog={catalog} staff={staff} onComplete={handleComplete} />
      </div>
      {view === 'daylog' && branchName && (
        <DayLog branch={branchName} voidedBy={auth.identity?.username ?? ''} onChanged={sync.triggerSync} />
      )}
      {view === 'report' && branchName && <DayReport branch={branchName} />}
    </div>
  )
}

export function Pos() {
  return (
    <PosAuthProvider>
      <PosInner />
    </PosAuthProvider>
  )
}
