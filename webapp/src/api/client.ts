// The single fetch wrapper for the whole app. Every call goes through here so
// there is exactly one place that knows about cookies, JSON handling and the
// expired-session redirect.

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: string,
  ) {
    super(body || `Request failed (${status})`)
    this.name = 'ApiError'
  }
}

// Fired when the server rejects a request for want of a valid session. The auth
// context listens and bounces the user to /login?next=<where they were>, which
// is nicer than each caller having to handle 401 itself.
export const AUTH_EXPIRED_EVENT = 'skc:auth-expired'

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    // Same-origin in both dev (Vite proxy) and production (skc-api serves the
    // SPA), so the session cookie rides along without any CORS story.
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT))
  }

  if (!res.ok) {
    // Errors come back as plain strings (Results.BadRequest) or as a
    // ProblemDetails object (Results.Problem) - unwrap both to one message.
    const raw = await res.text()
    let message = raw
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        message = parsed.detail ?? parsed.title ?? parsed.error ?? raw
      }
    } catch {
      /* not JSON - the raw text is already the message */
    }
    throw new ApiError(res.status, message)
  }

  if (res.status === 204) return undefined as T
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
}
