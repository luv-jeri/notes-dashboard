const API_BASE = import.meta.env.VITE_API_URL ?? '/api'

export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

const UNREACHABLE = "Can't reach the notes server. Check that the backend is running."
const OFFLINE = "You're offline. Check your connection."

/** fetch() with JSON in and out. Any failure becomes an ApiError with a readable message. */
export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: init.body ? { 'Content-Type': 'application/json', ...init.headers } : init.headers,
    })
  } catch (error) {
    // TanStack Query aborts stale requests on purpose; let that through untouched.
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new ApiError(0, navigator.onLine ? UNREACHABLE : OFFLINE)
  }

  if (!response.ok) throw new ApiError(response.status, await readErrorMessage(response))
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    // FastAPI sends { detail: "..." } for HTTP errors and
    // { detail: [{ msg: "..." }] } for validation errors.
    const { detail } = (await response.json()) as { detail?: unknown }
    if (typeof detail === 'string') return detail
    if (Array.isArray(detail) && typeof detail[0]?.msg === 'string') return detail[0].msg
  } catch {
    // Not JSON. A gateway error from the dev proxy means the backend is down.
  }
  return response.status >= 500 ? UNREACHABLE : `The server answered ${response.status}.`
}
