import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api, ApiError } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import type { SetupNeeded } from '../api/types'

export function Login() {
  const { user, login } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const next = params.get('next') || '/'

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // Fresh install: nobody can log in until the owner sets their password, so
  // send them to the one-time setup screen instead of an unusable form.
  useEffect(() => {
    void api
      .get<SetupNeeded>('/api/auth/setup-needed')
      .then((r) => {
        if (r.needed) navigate('/setup', { replace: true })
      })
      .catch(() => {
        /* setup check is advisory - a failure just leaves the login form up */
      })
  }, [navigate])

  useEffect(() => {
    if (user) navigate(next, { replace: true })
  }, [user, next, navigate])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      await login(username, password)
      navigate(next, { replace: true })
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 429
          ? 'Too many attempts. Wait a few minutes and try again.'
          : err instanceof Error
            ? err.message
            : 'Sign-in failed.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="centered">
      <form className="card" onSubmit={submit}>
        <h1>Sign in</h1>
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="btn primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}
