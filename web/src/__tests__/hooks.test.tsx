import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test"
import { renderHook, act, waitFor } from "@testing-library/react"
import { useTasks } from "../hooks/useTasks"

const mockTasks = [
  {
    id: "1", projectId: "proj", source: "manual" as const, sourceId: null, sourceUrl: null,
    title: "Fix auth middleware", description: "Fix the JWT validation", status: "running" as const,
    provider: "opencode" as const, branch: "main", worktreePath: null, prUrl: null, type: "code" as const, parentTaskId: null, userId: null, agentSessionId: null,
    agentPid: null, previewUrl: null, error: null,
    createdAt: "2026-03-17T10:00:00Z", updatedAt: "2026-03-17T10:00:00Z",
    startedAt: "2026-03-17T10:01:00Z", completedAt: null,
    lastSeenAt: null, lastResultAt: null,
  },
  {
    id: "2", projectId: "proj", source: "github" as const, sourceId: null, sourceUrl: null,
    title: "Add API docs", description: null, status: "done" as const,
    provider: "opencode" as const, branch: "main", worktreePath: null, prUrl: null, type: "code" as const, parentTaskId: null, userId: null, agentSessionId: null,
    agentPid: null, previewUrl: null, error: null,
    createdAt: "2026-03-16T10:00:00Z", updatedAt: "2026-03-16T12:00:00Z",
    startedAt: "2026-03-16T10:01:00Z", completedAt: "2026-03-16T12:00:00Z",
    lastSeenAt: null, lastResultAt: null,
  },
]

const originalFetch = globalThis.fetch

beforeEach(() => {
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify(mockTasks), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }))
  ) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("useTasks", () => {
  test("fetches tasks on mount", async () => {
    const { result } = renderHook(() => useTasks())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.tasks).toHaveLength(2)
    expect(result.current.tasks[0].title).toBe("Fix auth middleware")
    expect(result.current.error).toBeNull()
  })

  test("passes filter params to fetch", async () => {
    const { result } = renderHook(() => useTasks({ project: "my-project", status: "running" }))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    const calls = (globalThis.fetch as ReturnType<typeof mock>).mock.calls as unknown[][]
    const url = calls[0]![0] as string
    expect(url).toContain("project=my-project")
    expect(url).toContain("status=running")
  })

  test("handles fetch error", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Internal Server Error", { status: 500 }))
    ) as typeof fetch

    const { result } = renderHook(() => useTasks())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.error).toBeTruthy()
    expect(result.current.tasks).toHaveLength(0)
  })

  test("refetch updates tasks", async () => {
    const { result } = renderHook(() => useTasks())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    // Change mock to return different data
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify([mockTasks[0]]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
    ) as typeof fetch

    await act(async () => {
      await result.current.refetch()
    })

    expect(result.current.tasks).toHaveLength(1)
  })
})
