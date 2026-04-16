const AUTH_TOKEN_STORAGE_KEY = "tangerine-auth-token"
const AUTH_FAILURE_EVENT = "tangerine-auth-failure"
let memoryAuthToken: string | null = null

function readStoredToken(): string | null {
  if (typeof window === "undefined") return memoryAuthToken
  try {
    return window.localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)
  } catch {
    return memoryAuthToken
  }
}

export function getAuthToken(): string | null {
  return readStoredToken()
}

export function setAuthToken(token: string): void {
  memoryAuthToken = token
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token)
  } catch {
    // Ignore storage failures and fall back to in-memory auth for this tab.
  }
}

export function clearAuthToken(): void {
  memoryAuthToken = null
  if (typeof window === "undefined") return
  try {
    window.localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY)
  } catch {
    // Ignore storage failures and clear the in-memory fallback only.
  }
}

export function buildAuthHeaders(init?: HeadersInit): Headers {
  const headers = new Headers(init)
  const token = getAuthToken()
  if (token) {
    headers.set("Authorization", `Bearer ${token}`)
  }
  return headers
}

export function emitAuthFailure(): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(new Event(AUTH_FAILURE_EVENT))
}

export function subscribeAuthFailure(handler: () => void): () => void {
  if (typeof window === "undefined") return () => {}
  window.addEventListener(AUTH_FAILURE_EVENT, handler)
  return () => window.removeEventListener(AUTH_FAILURE_EVENT, handler)
}
