import { useState } from 'react'
import type { FormEvent } from 'react'
import { DataTable } from '../../components/DataTable'
import type { Column } from '../../components/DataTable'
import { useApi } from '../../lib/useApi'
import { api } from '../../api/client'
import { formatTimestamp } from '../../lib/format'
import { BRANCHES } from '../../lib/branches'
import type { AppDevice, Role } from '../../api/types'

// Owner-only, same trust as Users: the server requires an Owner *session* AND an
// owner device (RequireOwnerAdmin, no cookie-less fallback). This page is where
// the owner assigns each Tailscale IP a tier instead of it being hardcoded in
// Program.cs. Tier is a ceiling: a device caps what any account signed in on it
// can do (Owner > Office > Branch), so an admin on an owner-tier PC still only
// gets office access. A branch with no device row here stays ungated (fail-open).
export function Devices() {
  const { data, loading, error, reload } = useApi<AppDevice[]>('/api/devices')

  const [tailscaleIp, setTailscaleIp] = useState('')
  const [tier, setTier] = useState<Role>('Office')
  const [branchName, setBranchName] = useState<string>(BRANCHES[0])
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState('')
  const [notice, setNotice] = useState('')

  // Returns whether it succeeded - same contract as Users.act(): it swallows the
  // error into a banner so the promise always fulfills, so callers that clear the
  // form must check the result rather than clearing unconditionally.
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
    const ip = tailscaleIp.trim()
    void act(
      () =>
        api.post('/api/devices', {
          tailscaleIp: ip,
          tier,
          // The server ignores branchName unless tier is Branch, but sending it
          // only when relevant keeps the request honest about intent.
          branchName: tier === 'Branch' ? branchName : null,
          label: label.trim() || null,
        }),
      `Added ${ip}.`,
    ).then((ok) => {
      if (!ok) return // keep the fields so the owner can fix and retry
      setTailscaleIp('')
      setLabel('')
    })
  }

  const columns: Column<AppDevice>[] = [
    { header: 'IP', cell: (d) => d.tailscaleIp },
    { header: 'Tier', cell: (d) => d.tier },
    { header: 'Branch', cell: (d) => d.branchName || '' },
    { header: 'Label', cell: (d) => d.label || '' },
    {
      header: 'Status',
      cell: (d) =>
        d.isActive ? (
          <span className="pill ok">active</span>
        ) : (
          <span className="pill bad">disabled</span>
        ),
    },
    { header: 'Created', cell: (d) => formatTimestamp(d.createdAt) },
    {
      header: '',
      cell: (d) => (
        <span className="row-actions">
          {d.isActive ? (
            <button
              className="btn destructive"
              disabled={busy}
              onClick={() =>
                void act(() => api.patch(`/api/devices/${d.deviceId}/deactivate`), `Disabled ${d.tailscaleIp}.`)
              }
            >
              Disable
            </button>
          ) : (
            <button
              className="btn neutral"
              disabled={busy}
              onClick={() =>
                void act(() => api.patch(`/api/devices/${d.deviceId}/activate`), `Enabled ${d.tailscaleIp}.`)
              }
            >
              Enable
            </button>
          )}
          <button
            className="btn destructive"
            disabled={busy}
            onClick={() => {
              if (!window.confirm(`Delete device ${d.tailscaleIp}?`)) return
              void act(() => api.del(`/api/devices/${d.deviceId}`), `Deleted ${d.tailscaleIp}.`)
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
      <h1>Devices</h1>
      <p className="muted">
        Assign each Tailscale IP a tier. The tier is a ceiling on what any account signed in on that
        device can do (Owner &gt; Office &gt; Branch) — an owner device can never be used for owner
        work by a non-owner account, and vice versa. Editing this list needs one of the owner's own
        devices, like the Users page.
      </p>

      <form className="inline-form" onSubmit={create}>
        <label className="inline">
          Tailscale IP
          <input
            value={tailscaleIp}
            onChange={(e) => setTailscaleIp(e.target.value)}
            placeholder="100.x.x.x"
          />
        </label>
        <label className="inline">
          Tier
          <select value={tier} onChange={(e) => setTier(e.target.value as Role)}>
            <option value="Office">Office</option>
            <option value="Branch">Branch</option>
            <option value="Owner">Owner</option>
          </select>
        </label>
        {tier === 'Branch' && (
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
        )}
        <label className="inline">
          Label
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Yoho till 2"
          />
        </label>
        <button className="btn primary" disabled={busy || !tailscaleIp.trim()}>
          Add device
        </button>
      </form>

      {formError && <p className="error">{formError}</p>}
      {notice && <p className="notice">{notice}</p>}

      <DataTable
        columns={columns}
        rows={data}
        loading={loading}
        error={error}
        rowKey={(d) => String(d.deviceId)}
      />
    </section>
  )
}
