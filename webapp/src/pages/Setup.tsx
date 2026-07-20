import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import type { SetupNeeded } from '../api/types'

// One-time first-run screen: the owner types their own password on an owner
// device. Nothing seeds a plaintext password anywhere, so this is the only way
// the account ever becomes usable. Succeeding also signs them in.
export function Setup() {
  const { refresh } = useAuth()
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api
      .get<SetupNeeded>('/api/auth/setup-needed')
      .then((r) => {
        if (!r.needed) navigate('/login', { replace: true })
      })
      .catch(() => setError('Could not reach the server.'))
  }, [navigate])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    if (password !== confirm) return setError('The two passwords do not match.')
    setBusy(true)
    try {
      await api.post('/api/auth/bootstrap', { password })
      await refresh()
      navigate('/', { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="centered">
      <form className="card" onSubmit={submit}>
        <h1>Set the owner password</h1>
        <p className="muted">
          First-time setup. This must be done from the owner's own laptop or phone.
        </p>
        <label>
          New password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
          />
        </label>
        <label>
          Confirm password
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="btn primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save and sign in'}
        </button>
      </form>
    </div>
  )
}
