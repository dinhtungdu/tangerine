import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react"
import { fetchAuthSession, type AuthSession } from "../lib/api"
import { clearAuthToken, setAuthToken, subscribeAuthFailure } from "../lib/auth"

interface AuthContextValue extends AuthSession {
  loading: boolean
  error: string | null
  login: (token: string) => Promise<void>
  logout: () => void
  refreshSession: (unauthenticatedError?: string | null) => Promise<void>
}

const AuthContext = createContext<AuthContextValue>({
  enabled: false,
  authenticated: true,
  loading: true,
  error: null,
  login: async () => {},
  logout: () => {},
  refreshSession: async () => {},
})

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Failed to reach Tangerine"
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabled] = useState(false)
  const [authenticated, setAuthenticated] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const applySession = useCallback((session: AuthSession, nextError: string | null = null) => {
    setEnabled(session.enabled)
    setAuthenticated(session.authenticated)
    setError(nextError)
    setLoading(false)
  }, [])

  const refreshSession = useCallback(async (unauthenticatedError: string | null = null) => {
    setLoading(true)
    try {
      const session = await fetchAuthSession()
      if (session.enabled && !session.authenticated) {
        clearAuthToken()
        applySession(session, unauthenticatedError)
        return
      }
      applySession(session)
    } catch (err) {
      setError(getErrorMessage(err))
      setLoading(false)
      throw err
    }
  }, [applySession])

  useEffect(() => {
    refreshSession().catch(() => {})
  }, [refreshSession])

  useEffect(() => {
    return subscribeAuthFailure(() => {
      clearAuthToken()
      void refreshSession("Authentication required").catch(() => {})
    })
  }, [refreshSession])

  const login = useCallback(async (token: string) => {
    setAuthToken(token)
    setError(null)
    setLoading(true)
    try {
      const session = await fetchAuthSession()
      if (!session.authenticated) {
        clearAuthToken()
        setEnabled(session.enabled)
        setAuthenticated(false)
        setError("Invalid auth token")
        setLoading(false)
        return
      }
      applySession(session)
    } catch (err) {
      clearAuthToken()
      setAuthenticated(false)
      setError(getErrorMessage(err))
      setLoading(false)
    }
  }, [applySession])

  const logout = useCallback(() => {
    clearAuthToken()
    setAuthenticated(false)
    setError(null)
  }, [])

  return (
    <AuthContext.Provider value={{ enabled, authenticated, loading, error, login, logout, refreshSession }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext)
}
