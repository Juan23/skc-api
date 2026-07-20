import { useState } from 'react'
import type { FormEvent } from 'react'
import { DataTable } from '../../components/DataTable'
import type { Column } from '../../components/DataTable'
import { useApi } from '../../lib/useApi'
import { api } from '../../api/client'
import { formatTimestamp } from '../../lib/format'
import { BRANCHES } from '../../lib/branches'
import { useAuth } from '../../auth/AuthContext'
import type { AppUser, Role } from '../../api/types'

// Owner-only, and doubly so: the server requires an Owner *session* AND an owner
// device (IsOwnerIp). Unlike the other gates there's no cookie-less fallback, so
// this page is the one place where being signed in genuinely matters - see
// RequireOwnerAdmin in Program.cs.
export function Users() {
  const { user } = useAuth()
  const { data, loading, error, reload } = useApi<AppUser[]>('/api/users')

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<Role>('Office')
  const [branchName, setBranchName] = useState<string>(BRANCHES[0])
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState('')
  const [notice, setNotice] = useState('')

  // Returns whether it succeeded. It has to: this swallows the error to show a
  // banner, so the promise always fulfills - callers that clear form fields must
  // check the result rather than chaining .then() unconditionally, or a rejected
  // duplicate username would wipe what the owner just typed.
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
    const name = username.trim()
    void act(
      () =>
        api.post('/api/users', {
          username: name,
          password,
          role,
          // The server ignores branchName unless role is Branch, but sending it
          // only when relevant keeps the request honest about intent.
          branchName: role === 'Branch' ? branchName : null,
        }),
      `Created ${name}.`,
    ).then((ok) => {
      if (!ok) return // keep the fields so the owner can fix and retry
      setUsername('')
      setPassword('')
    })
  }

  function resetPassword(u: AppUser) {
    const next = window.prompt(`New password for ${u.username} (at least 8 characters):`)
    if (!next) return
    void act(
      () => api.post(`/api/users/${u.userId}/reset-password`, { newPassword: next }),
      `${u.username} must now set a new password, and their other sessions were signed out.`,
    )
  }

  const columns: Column<AppUser>[] = [
    { header: 'User', cell: (u) => u.username },
    { header: 'Role', cell: (u) => u.role },
    { header: 'Branch', cell: (u) => u.branchName || '' },
    {
      header: 'Status',
      cell: (u) =>
        !u.isActive ? (
          <span className="pill bad">disabled</span>
        ) : u.mustChangePassword ? (
          <span className="pill warn">must set password</span>
        ) : (
          <span className="pill ok">active</span>
        ),
    },
    { header: 'Created', cell: (u) => formatTimestamp(u.createdAt) },
    {
      header: '',
      cell: (u) => (
        <span className="row-actions">
          <button className="btn neutral" disabled={busy} onClick={() => resetPassword(u)}>
            Reset password
          </button>
          {u.isActive ? (
            <button
              className="btn destructive"
              // Disabling yourself would end your own session on the next
              // request; the server also refuses to disable the last Owner.
              disabled={busy || u.username === user?.username}
              onClick={() =>
                void act(() => api.patch(`/api/users/${u.userId}/deactivate`), `Disabled ${u.username}.`)
              }
            >
              Disable
            </button>
          ) : (
            <button
              className="btn neutral"
              disabled={busy}
              onClick={() => void act(() => api.patch(`/api/users/${u.userId}/activate`), `Enabled ${u.username}.`)}
            >
              Enable
            </button>
          )}
        </span>
      ),
    },
  ]

  return (
    <section>
      <h1>Users</h1>
      <p className="muted">
        Owner actions also require one of the owner's own devices — this page returns 403 from the
        office PC even when signed in as the owner.
      </p>

      <form className="inline-form" onSubmit={create}>
        <label className="inline">
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label className="inline">
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <label className="inline">
          Role
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="Office">Office</option>
            <option value="Branch">Branch</option>
            <option value="Owner">Owner</option>
          </select>
        </label>
        {role === 'Branch' && (
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
        <button className="btn primary" disabled={busy || !username.trim() || !password}>
          Add user
        </button>
      </form>
      <p className="muted">
        New accounts start with “must set password”, so whoever uses the account replaces the one you
        typed at their first sign-in.
      </p>

      {formError && <p className="error">{formError}</p>}
      {notice && <p className="notice">{notice}</p>}

      <DataTable
        columns={columns}
        rows={data}
        loading={loading}
        error={error}
        rowKey={(u) => String(u.userId)}
      />
    </section>
  )
}
