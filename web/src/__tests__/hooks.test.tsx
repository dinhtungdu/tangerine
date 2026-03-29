import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test"
import { renderHook, act, waitFor } from "@testing-library/react"
import { useTasks } from "../hooks/useTasks"
import { useSwipe } from "../hooks/useSwipe"

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

/* ── useSwipe ── */

function makeTouchEvent(x: number, y: number, target?: Partial<HTMLElement>) {
  const el = {
    tagName: "DIV",
    isContentEditable: false,
    closest: () => null,
    scrollWidth: 100,
    clientWidth: 100,
    parentElement: null,
    ...target,
  }
  return {
    touches: [{ clientX: x, clientY: y }],
    changedTouches: [{ clientX: x, clientY: y }],
    target: el,
  } as unknown as React.TouchEvent
}

describe("useSwipe", () => {
  test("calls onSwipeLeft when swiped left beyond threshold", () => {
    const onSwipeLeft = mock(() => {})
    const { result } = renderHook(() => useSwipe({ onSwipeLeft }))

    act(() => {
      result.current.onTouchStart(makeTouchEvent(200, 100))
      result.current.onTouchEnd(makeTouchEvent(100, 100))
    })

    expect(onSwipeLeft).toHaveBeenCalledTimes(1)
  })

  test("calls onSwipeRight when swiped right beyond threshold", () => {
    const onSwipeRight = mock(() => {})
    const { result } = renderHook(() => useSwipe({ onSwipeRight }))

    act(() => {
      result.current.onTouchStart(makeTouchEvent(100, 100))
      result.current.onTouchEnd(makeTouchEvent(200, 100))
    })

    expect(onSwipeRight).toHaveBeenCalledTimes(1)
  })

  test("does not trigger if horizontal distance is below threshold", () => {
    const onSwipeLeft = mock(() => {})
    const { result } = renderHook(() => useSwipe({ onSwipeLeft }))

    act(() => {
      result.current.onTouchStart(makeTouchEvent(100, 100))
      result.current.onTouchEnd(makeTouchEvent(70, 100))
    })

    expect(onSwipeLeft).not.toHaveBeenCalled()
  })

  test("does not trigger if vertical distance exceeds maxVertical", () => {
    const onSwipeLeft = mock(() => {})
    const { result } = renderHook(() => useSwipe({ onSwipeLeft }))

    act(() => {
      result.current.onTouchStart(makeTouchEvent(200, 100))
      result.current.onTouchEnd(makeTouchEvent(100, 200))
    })

    expect(onSwipeLeft).not.toHaveBeenCalled()
  })

  test("ignores touches on input elements", () => {
    const onSwipeLeft = mock(() => {})
    const { result } = renderHook(() => useSwipe({ onSwipeLeft }))

    act(() => {
      result.current.onTouchStart(makeTouchEvent(200, 100, { tagName: "INPUT" }))
      result.current.onTouchEnd(makeTouchEvent(100, 100))
    })

    expect(onSwipeLeft).not.toHaveBeenCalled()
  })

  test("ignores touches on textarea elements", () => {
    const onSwipeLeft = mock(() => {})
    const { result } = renderHook(() => useSwipe({ onSwipeLeft }))

    act(() => {
      result.current.onTouchStart(makeTouchEvent(200, 100, { tagName: "TEXTAREA" }))
      result.current.onTouchEnd(makeTouchEvent(100, 100))
    })

    expect(onSwipeLeft).not.toHaveBeenCalled()
  })

  test("ignores touches on elements with data-swipe-ignore ancestor", () => {
    const onSwipeLeft = mock(() => {})
    const { result } = renderHook(() => useSwipe({ onSwipeLeft }))

    const target = {
      tagName: "DIV",
      isContentEditable: false,
      closest: (sel: string) => sel === "[data-swipe-ignore]" ? {} : null,
      scrollWidth: 100,
      clientWidth: 100,
      parentElement: null,
    }

    act(() => {
      result.current.onTouchStart(makeTouchEvent(200, 100, target as Partial<HTMLElement>))
      result.current.onTouchEnd(makeTouchEvent(100, 100))
    })

    expect(onSwipeLeft).not.toHaveBeenCalled()
  })

  test("ignores touches inside horizontally-scrollable containers", () => {
    const onSwipeLeft = mock(() => {})
    const { result } = renderHook(() => useSwipe({ onSwipeLeft }))

    act(() => {
      result.current.onTouchStart(makeTouchEvent(200, 100, { scrollWidth: 500, clientWidth: 100 }))
      result.current.onTouchEnd(makeTouchEvent(100, 100))
    })

    expect(onSwipeLeft).not.toHaveBeenCalled()
  })

  test("respects custom threshold", () => {
    const onSwipeLeft = mock(() => {})
    const { result } = renderHook(() => useSwipe({ onSwipeLeft }, { threshold: 100 }))

    act(() => {
      result.current.onTouchStart(makeTouchEvent(200, 100))
      result.current.onTouchEnd(makeTouchEvent(120, 100))
    })

    expect(onSwipeLeft).not.toHaveBeenCalled()

    act(() => {
      result.current.onTouchStart(makeTouchEvent(200, 100))
      result.current.onTouchEnd(makeTouchEvent(50, 100))
    })

    expect(onSwipeLeft).toHaveBeenCalledTimes(1)
  })

  test("returns stable callback references across renders", () => {
    const { result, rerender } = renderHook(
      ({ handler }) => useSwipe({ onSwipeLeft: handler }),
      { initialProps: { handler: () => {} } },
    )

    const first = result.current
    rerender({ handler: () => {} })

    expect(result.current.onTouchStart).toBe(first.onTouchStart)
    expect(result.current.onTouchEnd).toBe(first.onTouchEnd)
  })
})
