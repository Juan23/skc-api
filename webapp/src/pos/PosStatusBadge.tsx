// Status indicator for the web POS (webapp-pos-plan.md Increment 5): OFFLINE /
// SYNCING / SYNCED / SYNC ERROR. The live sync truth (syncing / sync-error /
// offline) is shown first when it applies. authMode 'signin-required' (an
// expired 12h session with the server reachable) deliberately has NO badge
// state of its own since 2026-07-24: sales sync cookie-less through the
// device/IP gates, so an expired session changes nothing operationally and
// the sync status is the honest signal. (The old SIGN-IN TO SYNC chip - and
// the sign-in overlay it pointed at - nagged for the branch password every
// morning on tills that shut down nightly.)
import type { PosAuthMode } from './posAuth'
import type { PosSyncStatus } from './syncEngine'

interface Props {
  authMode: PosAuthMode
  syncStatus: PosSyncStatus
  pendingCount: number
}

export function PosStatusBadge({ authMode, syncStatus, pendingCount }: Props) {
  let label: string
  let tone: 'ok' | 'warn' | 'error' | 'neutral'

  if (syncStatus === 'syncing') {
    label = 'SYNCING…'
    tone = 'neutral'
  } else if (syncStatus === 'sync-error') {
    label = 'SYNC ERROR'
    tone = 'error'
  } else if (syncStatus === 'offline' || authMode === 'offline') {
    label = 'OFFLINE'
    tone = 'warn'
  } else if (syncStatus === 'synced') {
    label = 'SYNCED'
    tone = 'ok'
  } else {
    label = pendingCount > 0 ? `${pendingCount} PENDING` : 'READY'
    tone = 'neutral'
  }

  return (
    <div className={`pos-status pos-status-${tone}`} role="status">
      <span className="pos-status-dot" aria-hidden="true" />
      {label}
      {pendingCount > 0 && syncStatus !== 'syncing' && tone !== 'error' && (
        <span className="pos-status-count"> ({pendingCount} queued)</span>
      )}
    </div>
  )
}
