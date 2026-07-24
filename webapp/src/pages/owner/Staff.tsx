import { useState } from 'react'
import type { FormEvent } from 'react'
import { DataTable } from '../../components/DataTable'
import type { Column } from '../../components/DataTable'
import { useApi } from '../../lib/useApi'
import { api } from '../../api/client'
import { formatTimestamp } from '../../lib/format'
import { BRANCHES } from '../../lib/branches'
import type { PosStaff } from '../../api/types'

const PIN_RE = /^\d{4}$/

// Owner-only, same trust as Users/Devices (RequireOwnerAdmin server-side). The
// cashiers listed here drive the POS picker: a branch's tills show a
// tap-your-name + PIN picker once the branch has at least one active cashier,
// and fall back to the old free-text staff-name input while it has none - so
// rollout (and rollback) is per-branch, just by editing this list.
export function Staff() {
  const { data, loading, error, reload } = useApi<PosStaff[]>('/api/staff')

  const [branchName, setBranchName] = useState<string>(BRANCHES[0])
  const [staffName, setStaffName] = useState('')
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState('')
  const [notice, setNotice] = useState('')

  // Same contract as Devices.act(): swallows the error into a banner, returns
  // whether it succeeded so callers only clear the form on success.
  async function act(what: () => Promise<unknown>, ok: string): Promise<boolean> {
    setFormError('')
    setNotice('')
    setBusy(true)
    try {
      await what()
      setNotice(ok)
      reload()
      return true
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Request failed.')
      return false
    } finally {
      setBusy(false)
    }
  }

  function create(e: FormEvent) {
    e.preventDefault()
    const name = staffName.trim()
    if (!PIN_RE.test(pin)) {
      setNotice('')
      setFormError('PIN must be exactly 4 digits.')
      return
    }
    void act(
      () => api.post('/api/staff', { branchName, staffName: name, pin }),
      `Added ${name} (${branchName}).`,
    ).then((ok) => {
      if (!ok) return // keep the fields so the owner can fix and retry
      setStaffName('')
      setPin('')
    })
  }

  function resetPin(s: PosStaff) {
    const entered = window.prompt(`New 4-digit PIN for ${s.staffName}:`)
    if (entered == null) return
    if (!PIN_RE.test(entered)) {
      setNotice('')
      setFormError('PIN must be exactly 4 digits.')
      return
    }
    void act(() => api.post(`/api/staff/${s.staffId}/pin`, { pin: entered }), `PIN reset for ${s.staffName}.`)
  }

  const columns: Column<PosStaff>[] = [
    { header: 'Branch', cell: (s) => s.branchName },
    { header: 'Name', cell: (s) => s.staffName },
    {
      header: 'Status',
      cell: (s) =>
        s.isActive ? (
          <span className="pill ok">active</span>
        ) : (
          <span className="pill bad">disabled</span>
        ),
    },
    { header: 'Created', cell: (s) => formatTimestamp(s.createdAt) },
    {
      header: '',
      cell: (s) => (
        <span className="row-actions">
          <button className="btn neutral" disabled={busy} onClick={() => resetPin(s)}>
            Reset PIN
          </button>
          {s.isActive ? (
            <button
              className="btn destructive"
              disabled={busy}
              onClick={() =>
                void act(() => api.patch(`/api/staff/${s.staffId}/deactivate`), `Disabled ${s.staffName}.`)
              }
            >
              Disable
            </button>
          ) : (
            <button
              className="btn neutral"
              disabled={busy}
              onClick={() =>
                void act(() => api.patch(`/api/staff/${s.staffId}/activate`), `Enabled ${s.staffName}.`)
              }
            >
              Enable
            </button>
          )}
          <button
            className="btn destructive"
            disabled={busy}
            onClick={() => {
              if (!window.confirm(`Delete ${s.staffName} (${s.branchName})? Their past sales keep the name.`)) return
              void act(() => api.del(`/api/staff/${s.staffId}`), `Deleted ${s.staffName}.`)
            }}
          >
            Delete
          </button>
        </span>
      ),
    },
  ]

  return (
    <section>
      <h1>Staff</h1>
      <p className="muted">
        The cashiers each branch's POS can ring sales as. Once a branch has at least one active
        cashier here, its tills switch from the free-text staff-name box to a tap-your-name +
        4-digit-PIN picker (works offline); a branch with none listed keeps the free-text box.
        PINs are for honest attribution, not security — anyone at the counter can see the list.
      </p>

      <form className="inline-form" onSubmit={create}>
        <label className="inline">
          Branch
          <select value={branchName} onChange={(e) => setBranchName(e.target.value)}>
            {BRANCHES.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
        <label className="inline">
          Staff name
          <input
            value={staffName}
            onChange={(e) => setStaffName(e.target.value)}
            placeholder="e.g. Ana"
          />
        </label>
        <label className="inline">
          PIN
          <input
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            inputMode="numeric"
            maxLength={4}
            placeholder="4 digits"
          />
        </label>
        <button className="btn primary" disabled={busy || staffName.trim().length < 2 || pin.length < 4}>
          Add cashier
        </button>
      </form>

      {formError && <p className="error">{formError}</p>}
      {notice && <p className="notice">{notice}</p>}

      <DataTable
        columns={columns}
        rows={data}
        loading={loading}
        error={error}
        rowKey={(s) => String(s.staffId)}
      />
    </section>
  )
}
