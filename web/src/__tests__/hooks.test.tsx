import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test"
import { renderHook, act, waitFor } from "@testing-library/react"
import { useTasks } from "../hooks/useTasks"
import { useMentionPicker } from "../hooks/useMentionPicker"
import type { Task } from "@tangerine/shared"
const mockTasks = [
  {
    id: "1", projectId: "proj", source: "manual" as const, sourceId: null, sourceUrl: null,
    title: "Fix auth middleware", description: "Fix the JWT validation", status: "running" as const,
    provider: "opencode" as const, branch: "main", worktreePath: null, prUrl: null, parentTaskId: null, userId: null, agentSessionId: null,
    agentPid: null, error: null,
    createdAt: "2026-03-17T10:00:00Z", updatedAt: "2026-03-17T10:00:00Z",
    startedAt: "2026-03-17T10:01:00Z", completedAt: null,
    lastSeenAt: null, lastResultAt: null,
  },
  {
    id: "2", projectId: "proj", source: "github" as const, sourceId: null, sourceUrl: null,
    title: "Add API docs", description: null, status: "done" as const,
    provider: "opencode" as const, branch: "main", worktreePath: null, prUrl: null, parentTaskId: null, userId: null, agentSessionId: null,
    agentPid: null, error: null,
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

const mentionTasks: Task[] = [
  {
    id: "6536bda8-c097-4ff9-9521-38145bc9001c", projectId: "proj", type: "worker", source: "manual", sourceId: null, sourceUrl: null,
    title: "Fix auth middleware", description: null, status: "running",
    provider: "opencode", model: null, reasoningEffort: null, branch: null, worktreePath: null, prUrl: null,
    parentTaskId: null, userId: null, agentSessionId: null, agentPid: null, error: null,
    createdAt: "2026-03-17T10:00:00Z", updatedAt: "2026-03-17T11:00:00Z",
    startedAt: null, completedAt: null, lastSeenAt: null, lastResultAt: null, capabilities: [],
  },
  {
    id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890", projectId: "proj", type: "worker", source: "manual", sourceId: null, sourceUrl: null,
    title: "Add API docs", description: null, status: "done",
    provider: "opencode", model: null, reasoningEffort: null, branch: null, worktreePath: null, prUrl: null,
    parentTaskId: null, userId: null, agentSessionId: null, agentPid: null, error: null,
    createdAt: "2026-03-16T10:00:00Z", updatedAt: "2026-03-16T12:00:00Z",
    startedAt: null, completedAt: null, lastSeenAt: null, lastResultAt: null, capabilities: [],
  },
]

describe("useMentionPicker", () => {
  test("starts closed", () => {
    const { result } = renderHook(() => useMentionPicker(mentionTasks))
    expect(result.current.state.isOpen).toBe(false)
    expect(result.current.filteredTasks).toHaveLength(0)
  })

  test("opens when @ is detected", () => {
    const { result } = renderHook(() => useMentionPicker(mentionTasks))
    act(() => result.current.onTextChange("@", 1))
    expect(result.current.state.isOpen).toBe(true)
    expect(result.current.filteredTasks).toHaveLength(2)
  })

  test("filters tasks by query after @", () => {
    const { result } = renderHook(() => useMentionPicker(mentionTasks))
    act(() => result.current.onTextChange("@auth", 5))
    expect(result.current.state.isOpen).toBe(true)
    expect(result.current.filteredTasks).toHaveLength(1)
    expect(result.current.filteredTasks[0].title).toBe("Fix auth middleware")
  })

  test("closes on escape", () => {
    const { result } = renderHook(() => useMentionPicker(mentionTasks))
    act(() => result.current.onTextChange("@", 1))
    expect(result.current.state.isOpen).toBe(true)

    const prevented = { called: false }
    act(() => {
      result.current.onKeyDown({ key: "Escape", preventDefault: () => { prevented.called = true } })
    })
    expect(result.current.state.isOpen).toBe(false)
    expect(prevented.called).toBe(true)
  })

  test("navigates with arrow keys", () => {
    const { result } = renderHook(() => useMentionPicker(mentionTasks))
    act(() => result.current.onTextChange("@", 1))
    expect(result.current.state.selectedIndex).toBe(0)

    act(() => {
      result.current.onKeyDown({ key: "ArrowDown", preventDefault: () => {} })
    })
    expect(result.current.state.selectedIndex).toBe(1)

    act(() => {
      result.current.onKeyDown({ key: "ArrowUp", preventDefault: () => {} })
    })
    expect(result.current.state.selectedIndex).toBe(0)
  })

  test("selectTask replaces @query with UUID", () => {
    const { result } = renderHook(() => useMentionPicker(mentionTasks))
    act(() => result.current.onTextChange("hello @auth", 11))

    let res: { newText: string; cursorPos: number } = { newText: "", cursorPos: 0 }
    act(() => {
      res = result.current.selectTask(mentionTasks[0], "hello @auth")
    })
    expect(res.newText).toBe("hello 6536bda8-c097-4ff9-9521-38145bc9001c")
    expect(res.cursorPos).toBe(42)
    expect(result.current.state.isOpen).toBe(false)
  })

  test("closes when text has no @ trigger", () => {
    const { result } = renderHook(() => useMentionPicker(mentionTasks))
    act(() => result.current.onTextChange("@", 1))
    expect(result.current.state.isOpen).toBe(true)

    act(() => result.current.onTextChange("hello world", 11))
    expect(result.current.state.isOpen).toBe(false)
  })

  test("sorts active tasks before completed", () => {
    const { result } = renderHook(() => useMentionPicker(mentionTasks))
    act(() => result.current.onTextChange("@", 1))
    // First task should be the running one
    expect(result.current.filteredTasks[0].status).toBe("running")
    expect(result.current.filteredTasks[1].status).toBe("done")
  })

  test("clamps arrow navigation to filtered list bounds", () => {
    const { result } = renderHook(() => useMentionPicker(mentionTasks))
    // Filter to single result
    act(() => result.current.onTextChange("@auth", 5))
    expect(result.current.filteredTasks).toHaveLength(1)

    // ArrowDown should not go past last filtered item
    act(() => {
      result.current.onKeyDown({ key: "ArrowDown", preventDefault: () => {} })
    })
    expect(result.current.state.selectedIndex).toBe(0) // clamped to 0 (only 1 item)
  })

  test("does not consume Enter/Tab when no matches", () => {
    const { result } = renderHook(() => useMentionPicker(mentionTasks))
    act(() => result.current.onTextChange("@zzzznotask", 11))
    expect(result.current.state.isOpen).toBe(true)
    expect(result.current.filteredTasks).toHaveLength(0)

    // onKeyDown should NOT consume Enter when there are no matches
    const consumed = result.current.onKeyDown({ key: "Enter", preventDefault: () => {} })
    expect(consumed).toBe(false)
  })

  test("does not open for @ preceded by non-whitespace", () => {
    const { result } = renderHook(() => useMentionPicker(mentionTasks))
    act(() => result.current.onTextChange("email@auth", 10))
    expect(result.current.state.isOpen).toBe(false)
  })

  test("opens for @ after whitespace", () => {
    const { result } = renderHook(() => useMentionPicker(mentionTasks))
    act(() => result.current.onTextChange("check @auth", 11))
    expect(result.current.state.isOpen).toBe(true)
    expect(result.current.state.query).toBe("auth")
  })
})