// Status indicator for the web POS (webapp-pos-plan.md Increment 5): OFFLINE /
// SYNCING / SYNCED / SYNC ERROR / SIGN-IN-TO-SYNC. Auth mode takes priority
// over sync status when both apply - "sign in when convenient" is the
// actionable thing to tell the cashier, not the sync plumbing underneath it.
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

  if (authMode === 'signin-required') {
    label = 'SIGN-IN TO SYNC'
    tone = 'warn'
  } else if (syncStatus === 'syncing') {
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
