import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'

interface ApiState<T> {
  data: T | null
  loading: boolean
  error: string
  reload: () => void
}

// Fetches on mount and whenever `path` changes; pass null to hold off (e.g.
// while a required filter is still empty). A 401 is not handled here - the
// client wrapper raises the auth-expired event and AuthContext redirects.
export function useApi<T>(path: string | null): ApiState<T> {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (path == null) return
    let cancelled = false
    setLoading(true)
    setError('')
    api
      .get<T>(path)
      .then((result) => {
        // Guard against a slow earlier request landing after a newer one and
        // repainting the table with stale rows.
        if (!cancelled) setData(result)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Request failed.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [path, nonce])

  const reload = useCallback(() => setNonce((n) => n + 1), [])
  return { data, loading, error, reload }
}
