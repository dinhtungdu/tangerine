import { describe, test, expect, afterEach, mock } from "bun:test"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { useEffect } from "react"
import { useAuth, AuthProvider } from "../context/AuthContext"
import { fetchAuthSession } from "../lib/api"
import { clearAuthToken, emitAuthFailure, setAuthToken } from "../lib/auth"

const originalFetch = global.fetch

function AuthProbe() {
  const auth = useAuth()
  return <pre data-testid="auth-state">{JSON.stringify(auth)}</pre>
}

afterEach(() => {
  cleanup()
  global.fetch = originalFetch
  clearAuthToken()
})

describe("auth", () => {
  test("fetchAuthSession sends bearer token from storage", async () => {
    let authHeader: string | null = null
    setAuthToken("secret-token")
    global.fetch = mock((_input: RequestInfo | URL, init?: RequestInit) => {
      authHeader = new Headers(init?.headers).get("Authorization")
      return Promise.resolve(new Response(JSON.stringify({ enabled: true, authenticated: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
    }) as typeof fetch

    await expect(fetchAuthSession()).resolves.toEqual({ enabled: true, authenticated: true })
    expect(authHeader).toBe("Bearer secret-token")
  })

  test("fetchAuthSession falls back to in-memory auth when localStorage throws", async () => {
    let authHeader: string | null = null
    const storageProto = Object.getPrototypeOf(window.localStorage) as {
      getItem: typeof window.localStorage.getItem
      setItem: typeof window.localStorage.setItem
    }
    const originalGetItem = storageProto.getItem
    const originalSetItem = storageProto.setItem

    storageProto.getItem = mock(() => {
      throw new Error("storage blocked")
    }) as typeof window.localStorage.getItem
    storageProto.setItem = mock(() => {
      throw new Error("storage blocked")
    }) as typeof window.localStorage.setItem

    try {
      setAuthToken("secret-token")
      global.fetch = mock((_input: RequestInfo | URL, init?: RequestInit) => {
        authHeader = new Headers(init?.headers).get("Authorization")
        return Promise.resolve(new Response(JSON.stringify({ enabled: true, authenticated: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }))
      }) as typeof fetch

      await expect(fetchAuthSession()).resolves.toEqual({ enabled: true, authenticated: true })
      expect(authHeader).toBe("Bearer secret-token")
    } finally {
      storageProto.getItem = originalGetItem
      storageProto.setItem = originalSetItem
    }
  })

  test("AuthProvider exposes unauthenticated protected state", async () => {
    global.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ enabled: true, authenticated: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
    ) as typeof fetch

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    )

    await waitFor(() => {
      const state = JSON.parse(screen.getByTestId("auth-state").textContent ?? "{}") as { loading: boolean }
      expect(state.loading).toBe(false)
    })

    const state = JSON.parse(screen.getByTestId("auth-state").textContent ?? "{}") as {
      enabled: boolean
      authenticated: boolean
      loading: boolean
    }
    expect(state.enabled).toBe(true)
    expect(state.authenticated).toBe(false)
    expect(state.loading).toBe(false)
  })

  test("login stores token and updates authenticated state", async () => {
    let calls = 0
    global.fetch = mock((_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1
      const authHeader = new Headers(init?.headers).get("Authorization")
      const body = calls === 1
        ? { enabled: true, authenticated: false }
        : { enabled: true, authenticated: authHeader === "Bearer secret-token" }
      return Promise.resolve(new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
    }) as typeof fetch

    function LoginProbe() {
      const auth = useAuth()
      useEffect(() => {
        if (!auth.loading && !auth.authenticated) {
          void auth.login("secret-token")
        }
      }, [auth])
      return <pre data-testid="auth-state">{JSON.stringify(auth)}</pre>
    }

    render(
      <AuthProvider>
        <LoginProbe />
      </AuthProvider>,
    )

    await waitFor(() => {
      const state = JSON.parse(screen.getByTestId("auth-state").textContent ?? "{}") as { authenticated: boolean; loading: boolean }
      expect(state.loading).toBe(false)
      expect(state.authenticated).toBe(true)
    })

    expect(localStorage.getItem("tangerine-auth-token")).toBe("secret-token")
  })

  test("AuthProvider preserves auth failure error after refresh", async () => {
    global.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ enabled: true, authenticated: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
    ) as typeof fetch

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    )

    await waitFor(() => {
      const state = JSON.parse(screen.getByTestId("auth-state").textContent ?? "{}") as { loading: boolean }
      expect(state.loading).toBe(false)
    })

    emitAuthFailure()

    await waitFor(() => {
      const state = JSON.parse(screen.getByTestId("auth-state").textContent ?? "{}") as { error: string | null }
      expect(state.error).toBe("Authentication required")
    })
  })
})
