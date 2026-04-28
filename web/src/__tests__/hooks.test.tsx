import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test"
import { renderHook, act, waitFor } from "@testing-library/react"
import { useTasks } from "../hooks/useTasks"
import { applyActivityUpdate, applyAssistantStreamMessage, applyThinkingStreamMessage, applyUsageUpdate, mergeActivitySnapshot, useSession } from "../hooks/useSession"
import { useMentionPicker } from "../hooks/useMentionPicker"
import { useFileMentionPicker } from "../hooks/useFileMentionPicker"
import { useSlashCommandPicker } from "../hooks/useSlashCommandPicker"
import { usePanelActions } from "../hooks/usePanelActions"
import { useResizable } from "../hooks/useResizable"
import { getActions, getAction, setShortcutOverrides, _resetForTesting } from "../lib/actions"
import { defaultShortcuts } from "../lib/default-shortcuts"
import type { Task } from "@tangerine/shared"
import type { PointerEvent as ReactPointerEvent } from "react"
const mockTasks = [
  {
    id: "1", projectId: "proj", source: "manual" as const, sourceId: null, sourceUrl: null,
    title: "Fix auth middleware", description: "Fix the JWT validation", status: "running" as const,
    provider: "acp" as const, branch: "main", worktreePath: null, prUrl: null, parentTaskId: null, userId: null, agentSessionId: null,
    agentPid: null, suspended: false, error: null,
    createdAt: "2026-03-17T10:00:00Z", updatedAt: "2026-03-17T10:00:00Z",
    startedAt: "2026-03-17T10:01:00Z", completedAt: null,
    lastSeenAt: null, lastResultAt: null,
  },
  {
    id: "2", projectId: "proj", source: "github" as const, sourceId: null, sourceUrl: null,
    title: "Add API docs", description: null, status: "done" as const,
    provider: "acp" as const, branch: "main", worktreePath: null, prUrl: null, parentTaskId: null, userId: null, agentSessionId: null,
    agentPid: null, suspended: false, error: null,
    createdAt: "2026-03-16T10:00:00Z", updatedAt: "2026-03-16T12:00:00Z",
    startedAt: "2026-03-16T10:01:00Z", completedAt: "2026-03-16T12:00:00Z",
    lastSeenAt: null, lastResultAt: null,
  },
]

const originalFetch = globalThis.fetch

beforeEach(() => {
  globalThis.fetch = mock((url: string) => {
    if (url.includes("/api/tasks/counts")) {
      return Promise.resolve(new Response(JSON.stringify({ proj: 2 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
    }
    return Promise.resolve(new Response(JSON.stringify(mockTasks), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }))
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("applyAssistantStreamMessage", () => {
  test("merges streamed assistant chunks and replaces with final content", () => {
    const first = applyAssistantStreamMessage([], { content: "hel", timestamp: "2026-04-27T10:00:00.000Z" }, "assistant-active", "append")
    const second = applyAssistantStreamMessage(first, { content: "lo", timestamp: "2026-04-27T10:00:01.000Z" }, "assistant-active", "append")
    const complete = applyAssistantStreamMessage(second, { content: "hello", timestamp: "2026-04-27T10:00:02.000Z" }, "assistant-active", "complete")

    expect(complete).toEqual([{ id: "assistant-active", role: "assistant", content: "hello", timestamp: "2026-04-27T10:00:02.000Z" }])
  })
})

describe("applyThinkingStreamMessage", () => {
  test("merges streamed thinking chunks into one message", () => {
    const first = applyThinkingStreamMessage([], { messageId: "thought-1", content: "thi", timestamp: "2026-04-27T10:00:00.000Z" }, "append")
    const second = applyThinkingStreamMessage(first, { messageId: "thought-1", content: "nk", timestamp: "2026-04-27T10:00:01.000Z" }, "append")
    const complete = applyThinkingStreamMessage(second, { messageId: "thought-1", content: "think", timestamp: "2026-04-27T10:00:02.000Z" }, "complete")

    expect(complete).toEqual([{ id: "thinking-thought-1", role: "thinking", content: "think", timestamp: "2026-04-27T10:00:02.000Z" }])
  })
})

describe("applyActivityUpdate", () => {
  test("replaces existing activity rows by id", () => {
    const initial = [{
      id: 1,
      taskId: "task-1",
      type: "system" as const,
      event: "tool.bash",
      content: "Bash",
      metadata: { status: "running" },
      timestamp: "2026-04-27T10:00:00.000Z",
    }]
    const updated = {
      ...initial[0]!,
      metadata: { status: "success", output: "2 tests passed" },
    }

    expect(applyActivityUpdate(initial, updated)).toEqual([updated])
  })
})

describe("mergeActivitySnapshot", () => {
  test("keeps newer websocket activity when a stale REST snapshot resolves", () => {
    const live = [{
      id: 1,
      taskId: "task-1",
      type: "system" as const,
      event: "tool.bash",
      content: "Bash",
      metadata: { status: "success", output: "2 tests passed", lastProgressAt: "2026-04-27T10:00:03.000Z" },
      timestamp: "2026-04-27T10:00:00.000Z",
    }]
    const staleSnapshot = [{
      ...live[0]!,
      metadata: { status: "running", output: "1/2 tests passed", lastProgressAt: "2026-04-27T10:00:01.000Z" },
    }]

    expect(mergeActivitySnapshot(live, staleSnapshot)).toEqual(live)
  })

  test("uses a newer REST snapshot when websocket missed an update", () => {
    const current = [{
      id: 1,
      taskId: "task-1",
      type: "system" as const,
      event: "tool.bash",
      content: "Bash",
      metadata: { status: "running", output: "1/2 tests passed", lastProgressAt: "2026-04-27T10:00:01.000Z" },
      timestamp: "2026-04-27T10:00:00.000Z",
    }]
    const snapshot = [{
      ...current[0]!,
      metadata: { status: "success", output: "2 tests passed", lastProgressAt: "2026-04-27T10:00:03.000Z" },
    }]

    expect(mergeActivitySnapshot(current, snapshot)).toEqual(snapshot)
  })
})

describe("applyUsageUpdate", () => {
  test("updates context tokens and window max from ACP usage events", () => {
    expect(applyUsageUpdate(
      { contextTokens: 0, contextWindowMax: null },
      { contextTokens: 123, contextWindowMax: 1000 },
    )).toEqual({ contextTokens: 123, contextWindowMax: 1000 })
  })

  test("preserves previous values when usage event omits them", () => {
    expect(applyUsageUpdate(
      { contextTokens: 123, contextWindowMax: 1000 },
      {},
    )).toEqual({ contextTokens: 123, contextWindowMax: 1000 })
  })
})

describe("useSession", () => {
  test("keeps config options when slash-command fetch fails", async () => {
    const originalWebSocket = globalThis.WebSocket
    class TestWebSocket {
      static readonly CLOSING = 2
      readonly readyState = 0
      onopen: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      onclose: ((event: CloseEvent) => void) | null = null
      constructor(_url: string) { }
      send(_data: string) { }
      close() { }
    }
    globalThis.WebSocket = TestWebSocket as unknown as typeof WebSocket
    globalThis.fetch = mock((url: string) => {
      if (url.includes("/messages")) return Promise.resolve(new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } }))
      if (url.includes("/activities")) return Promise.resolve(new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } }))
      if (url.includes("/config-options")) {
        return Promise.resolve(new Response(JSON.stringify({ configOptions: [{ id: "model", name: "Model", category: "model", type: "select", currentValue: "gpt-5", options: [{ value: "gpt-5", name: "GPT-5" }] }] }), { status: 200, headers: { "Content-Type": "application/json" } }))
      }
      if (url.includes("/slash-commands")) return Promise.resolve(new Response("not found", { status: 404 }))
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } }))
    }) as typeof fetch

    try {
      const { result } = renderHook(() => useSession("task-1"))

      await waitFor(() => {
        expect(result.current.configOptions).toHaveLength(1)
      })
      expect(result.current.slashCommands).toEqual([])
    } finally {
      globalThis.WebSocket = originalWebSocket
    }
  })

  test("ignores slash-command responses from a previous task", async () => {
    const originalWebSocket = globalThis.WebSocket
    class TestWebSocket {
      static readonly CLOSING = 2
      readonly readyState = 0
      onopen: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      onclose: ((event: CloseEvent) => void) | null = null
      constructor(_url: string) { }
      send(_data: string) { }
      close() { }
    }
    globalThis.WebSocket = TestWebSocket as unknown as typeof WebSocket

    let resolveOldCommands: (() => void) | null = null
    globalThis.fetch = mock((url: string) => {
      if (url.includes("/messages") || url.includes("/activities")) {
        return Promise.resolve(new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } }))
      }
      if (url.includes("/config-options")) {
        return Promise.resolve(new Response(JSON.stringify({ configOptions: [] }), { status: 200, headers: { "Content-Type": "application/json" } }))
      }
      if (url.includes("/task-1/slash-commands")) {
        return new Promise<Response>((resolve) => {
          resolveOldCommands = () => resolve(new Response(JSON.stringify({ commands: [{ name: "old", description: "Old task command" }] }), { status: 200, headers: { "Content-Type": "application/json" } }))
        })
      }
      if (url.includes("/task-2/slash-commands")) {
        return new Promise<Response>(() => {})
      }
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } }))
    }) as typeof fetch

    try {
      const { result, rerender } = renderHook(({ taskId }) => useSession(taskId), { initialProps: { taskId: "task-1" } })

      await waitFor(() => expect(resolveOldCommands).toBeTruthy())
      rerender({ taskId: "task-2" })

      await act(async () => {
        resolveOldCommands?.()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(result.current.slashCommands).toEqual([])
    } finally {
      globalThis.WebSocket = originalWebSocket
    }
  })

  test("removes optimistic message from chat when queue update shows it was queued", async () => {
    const originalWebSocket = globalThis.WebSocket
    let wsInstance: { onmessage: ((event: MessageEvent) => void) | null; send: (data: string) => void } | null = null
    class TestWebSocket {
      static readonly CLOSING = 2
      readonly readyState = 1
      onopen: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      onclose: ((event: CloseEvent) => void) | null = null
      constructor(_url: string) {
        wsInstance = this
        setTimeout(() => this.onopen?.(new Event("open")), 0)
      }
      send(_data: string) { }
      close() { }
    }
    globalThis.WebSocket = TestWebSocket as unknown as typeof WebSocket
    globalThis.fetch = mock((url: string) => {
      if (url.includes("/messages") || url.includes("/activities") || url.includes("/queued-prompts")) {
        return Promise.resolve(new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } }))
      }
      if (url.includes("/config-options")) {
        return Promise.resolve(new Response(JSON.stringify({ configOptions: [] }), { status: 200, headers: { "Content-Type": "application/json" } }))
      }
      if (url.includes("/slash-commands")) {
        return Promise.resolve(new Response(JSON.stringify({ commands: [] }), { status: 200, headers: { "Content-Type": "application/json" } }))
      }
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } }))
    }) as typeof fetch

    try {
      const { result } = renderHook(() => useSession("task-1"))

      await waitFor(() => expect(wsInstance).toBeTruthy())

      // Simulate sending a message (client thinks agent is idle)
      act(() => {
        result.current.sendPrompt("hello world")
      })

      // Message should appear optimistically
      expect(result.current.messages).toHaveLength(1)
      expect(result.current.messages[0].role).toBe("user")
      expect(result.current.messages[0].content).toBe("hello world")

      // Simulate server queue update (agent was actually busy)
      act(() => {
        wsInstance?.onmessage?.(new MessageEvent("message", {
          data: JSON.stringify({
            type: "queue",
            queuedPrompts: [{ id: "q-1", text: "hello world", enqueuedAt: Date.now() }],
          }),
        }))
      })

      // Optimistic message should be removed from chat (it's now in queue)
      expect(result.current.messages).toHaveLength(0)
      expect(result.current.queuedPrompts).toHaveLength(1)
      expect(result.current.queuedPrompts[0].text).toBe("hello world")
    } finally {
      globalThis.WebSocket = originalWebSocket
    }
  })
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
    // Update mock to return counts for specific project
    globalThis.fetch = mock((url: string) => {
      if (url.includes("/api/tasks/counts")) {
        return Promise.resolve(new Response(JSON.stringify({ "my-project": 1 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }))
      }
      return Promise.resolve(new Response(JSON.stringify([mockTasks[0]]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
    }) as typeof fetch

    const { result } = renderHook(() => useTasks({ project: "my-project", status: "running" }))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    const calls = (globalThis.fetch as ReturnType<typeof mock>).mock.calls as unknown[][]
    // Find the tasks fetch call (second call onwards are per-project fetches)
    const tasksCalls = calls.filter(c => (c[0] as string).includes("/api/tasks?"))
    expect(tasksCalls.length).toBeGreaterThan(0)
    const tasksUrl = tasksCalls[0]![0] as string
    expect(tasksUrl).toContain("project=my-project")
    expect(tasksUrl).toContain("status=running")
  })

  test("handles fetch error", async () => {
    // Make counts fail to trigger error handling
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
    globalThis.fetch = mock((url: string) => {
      if (url.includes("/api/tasks/counts")) {
        return Promise.resolve(new Response(JSON.stringify({ proj: 1 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }))
      }
      return Promise.resolve(new Response(JSON.stringify([mockTasks[0]]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
    }) as typeof fetch

    await act(async () => {
      await result.current.refetch()
    })

    expect(result.current.tasks).toHaveLength(1)
  })

  test("loadMore appends tasks for a project", async () => {
    const { result } = renderHook(() => useTasks())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    // Mock loadMore response
    const additionalTask = { ...mockTasks[0], id: "3", title: "Additional task" }
    globalThis.fetch = mock((url: string) => {
      if (url.includes("/api/tasks/counts")) {
        return Promise.resolve(new Response(JSON.stringify({ proj: 3 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }))
      }
      return Promise.resolve(new Response(JSON.stringify([additionalTask]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
    }) as typeof fetch

    await act(async () => {
      await result.current.loadMore("proj")
    })

    expect(result.current.tasks.some(t => t.id === "3")).toBe(true)
  })

  test("refetch preserves loaded pages", async () => {
    const { result } = renderHook(() => useTasks())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    // Simulate having loaded more by calling loadMore first
    const additionalTask = { ...mockTasks[0], id: "3", title: "Additional task" }
    globalThis.fetch = mock((url: string) => {
      if (url.includes("/api/tasks/counts")) {
        return Promise.resolve(new Response(JSON.stringify({ proj: 3 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }))
      }
      return Promise.resolve(new Response(JSON.stringify([additionalTask]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
    }) as typeof fetch

    await act(async () => {
      await result.current.loadMore("proj")
    })

    const countAfterLoadMore = result.current.tasks.length

    // Now refetch - should preserve the loaded limit
    globalThis.fetch = mock((url: string) => {
      if (url.includes("/api/tasks/counts")) {
        return Promise.resolve(new Response(JSON.stringify({ proj: 3 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }))
      }
      // Return all 3 tasks since we should request with higher limit
      return Promise.resolve(new Response(JSON.stringify([...mockTasks, additionalTask]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
    }) as typeof fetch

    await act(async () => {
      await result.current.refetch()
    })

    // Should have at least as many tasks as after loadMore
    expect(result.current.tasks.length).toBeGreaterThanOrEqual(countAfterLoadMore)
  })

  test("returns counts per project", async () => {
    const { result } = renderHook(() => useTasks())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.counts).toHaveProperty("proj")
    expect(result.current.counts.proj).toBe(2)
  })
})

const mentionTasks: Task[] = [
  {
    id: "6536bda8-c097-4ff9-9521-38145bc9001c", projectId: "proj", type: "worker", source: "manual", sourceId: null, sourceUrl: null,
    title: "Fix auth middleware", description: null, status: "running",
    provider: "acp", model: null, reasoningEffort: null, branch: null, worktreePath: null, prUrl: null,
    parentTaskId: null, userId: null, agentSessionId: null, agentPid: null, error: null,
    createdAt: "2026-03-17T10:00:00Z", updatedAt: "2026-03-17T11:00:00Z",
    startedAt: null, completedAt: null, lastSeenAt: null, lastResultAt: null, capabilities: [],
  },
  {
    id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890", projectId: "proj", type: "worker", source: "manual", sourceId: null, sourceUrl: null,
    title: "Add API docs", description: null, status: "done",
    provider: "acp", model: null, reasoningEffort: null, branch: null, worktreePath: null, prUrl: null,
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

  test("opens when # is detected", () => {
    const { result } = renderHook(() => useMentionPicker(mentionTasks))
    act(() => result.current.onTextChange("#", 1))
    expect(result.current.state.isOpen).toBe(true)
    expect(result.current.filteredTasks).toHaveLength(2)
  })

  test("filters tasks by query after #", () => {
    const { result } = renderHook(() => useMentionPicker(mentionTasks))
    act(() => result.current.onTextChange("#auth", 5))
    expect(result.current.state.isOpen).toBe(true)
    expect(result.current.filteredTasks).toHaveLength(1)
    expect(result.current.filteredTasks[0].title).toBe("Fix auth middleware")
  })

  test("closes on escape", () => {
    const { result } = renderHook(() => useMentionPicker(mentionTasks))
    act(() => result.current.onTextChange("#", 1))
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
    act(() => result.current.onTextChange("#", 1))
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

  test("selectTask replaces #query with UUID", () => {
    const { result } = renderHook(() => useMentionPicker(mentionTasks))
    act(() => result.current.onTextChange("hello #auth", 11))

    let res: { newText: string; cursorPos: number } = { newText: "", cursorPos: 0 }
    act(() => {
      res = result.current.selectTask(mentionTasks[0], "hello #auth")
    })
    expect(res.newText).toBe("hello 6536bda8-c097-4ff9-9521-38145bc9001c")
    expect(res.cursorPos).toBe(42)
    expect(result.current.state.isOpen).toBe(false)
  })

  test("closes when text has no # trigger", () => {
    const { result } = renderHook(() => useMentionPicker(mentionTasks))
    act(() => result.current.onTextChange("#", 1))
    expect(result.current.state.isOpen).toBe(true)

    act(() => result.current.onTextChange("hello world", 11))
    expect(result.current.state.isOpen).toBe(false)
  })

  test("sorts active tasks before completed", () => {
    const { result } = renderHook(() => useMentionPicker(mentionTasks))
    act(() => result.current.onTextChange("#", 1))
    // First task should be the running one
    expect(result.current.filteredTasks[0].status).toBe("running")
    expect(result.current.filteredTasks[1].status).toBe("done")
  })

  test("clamps arrow navigation to filtered list bounds", () => {
    const { result } = renderHook(() => useMentionPicker(mentionTasks))
    // Filter to single result
    act(() => result.current.onTextChange("#auth", 5))
    expect(result.current.filteredTasks).toHaveLength(1)

    // ArrowDown should not go past last filtered item
    act(() => {
      result.current.onKeyDown({ key: "ArrowDown", preventDefault: () => {} })
    })
    expect(result.current.state.selectedIndex).toBe(0) // clamped to 0 (only 1 item)
  })

  test("does not consume Enter/Tab when no matches", () => {
    const { result } = renderHook(() => useMentionPicker(mentionTasks))
    act(() => result.current.onTextChange("#zzzznotask", 11))
    expect(result.current.state.isOpen).toBe(true)
    expect(result.current.filteredTasks).toHaveLength(0)

    // onKeyDown should NOT consume Enter when there are no matches
    const consumed = result.current.onKeyDown({ key: "Enter", preventDefault: () => {} })
    expect(consumed).toBe(false)
  })

  test("does not open for # preceded by non-whitespace", () => {
    const { result } = renderHook(() => useMentionPicker(mentionTasks))
    act(() => result.current.onTextChange("tag#auth", 8))
    expect(result.current.state.isOpen).toBe(false)
  })

  test("opens for # after whitespace", () => {
    const { result } = renderHook(() => useMentionPicker(mentionTasks))
    act(() => result.current.onTextChange("check #auth", 11))
    expect(result.current.state.isOpen).toBe(true)
    expect(result.current.state.query).toBe("auth")
  })
})

describe("useSlashCommandPicker", () => {
  const commands = [
    { name: "compact", description: "Compact conversation", input: { hint: "instructions" } },
    { name: "model", description: "Switch model" },
  ]

  test("opens and filters slash commands", () => {
    const { result } = renderHook(() => useSlashCommandPicker(commands))

    act(() => result.current.onTextChange("/comp", 5))

    expect(result.current.state.isOpen).toBe(true)
    expect(result.current.filteredCommands).toEqual([commands[0]])
  })

  test("selectCommand replaces query with slash command", () => {
    const { result } = renderHook(() => useSlashCommandPicker(commands))
    act(() => result.current.onTextChange("/comp", 5))

    let res: { newText: string; cursorPos: number } = { newText: "", cursorPos: 0 }
    act(() => {
      res = result.current.selectCommand(commands[0]!, "/comp")
    })

    expect(res.newText).toBe("/compact ")
    expect(res.cursorPos).toBe(9)
    expect(result.current.state.isOpen).toBe(false)
  })

  test("does not open for normal absolute paths", () => {
    const { result } = renderHook(() => useSlashCommandPicker(commands))

    act(() => result.current.onTextChange("see /tmp", 8))

    expect(result.current.state.isOpen).toBe(false)
  })

  test("opens after a newline", () => {
    const { result } = renderHook(() => useSlashCommandPicker(commands))

    act(() => result.current.onTextChange("note\n/model", 11))

    expect(result.current.state.isOpen).toBe(true)
    expect(result.current.filteredCommands).toEqual([commands[1]])
  })
})

describe("useFileMentionPicker", () => {
  test("fetches task files when @ query opens", async () => {
    globalThis.fetch = mock((url: string) => {
      if (url === "/api/tasks/task-1/files?query=Chat") {
        return Promise.resolve(new Response(JSON.stringify({ files: [{ path: "web/src/ChatInput.tsx" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }))
      }
      return Promise.resolve(new Response(JSON.stringify({ files: [] }), { status: 200 }))
    }) as typeof fetch

    const { result } = renderHook(() => useFileMentionPicker({ taskId: "task-1" }))
    act(() => result.current.onTextChange("see @Chat", 9))

    await waitFor(() => {
      expect(result.current.filteredFiles).toHaveLength(1)
    })
    expect(result.current.filteredFiles[0].path).toBe("web/src/ChatInput.tsx")
  })

  test("selectFile replaces @query with @path", () => {
    const { result } = renderHook(() => useFileMentionPicker({}))
    act(() => result.current.onTextChange("read @Chat", 10))

    let res: { newText: string; cursorPos: number } = { newText: "", cursorPos: 0 }
    act(() => {
      res = result.current.selectFile({ path: "web/src/ChatInput.tsx" }, "read @Chat")
    })

    expect(res.newText).toBe("read @web/src/ChatInput.tsx ")
    expect(res.cursorPos).toBe(28)
    expect(result.current.state.isOpen).toBe(false)
  })
})

const makeTask = (overrides: Partial<Task> = {}): Task => ({
  id: "task-1", projectId: "proj", type: "worker", source: "manual", sourceId: null, sourceUrl: null,
  title: "Test task", description: null, status: "running",
  provider: "acp", model: null, reasoningEffort: null, branch: null, worktreePath: null, prUrl: null,
  parentTaskId: null, userId: null, agentSessionId: null, agentPid: null, error: null,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  startedAt: null, completedAt: null, lastSeenAt: null, lastResultAt: null,
  capabilities: [],
  ...overrides,
})

describe("usePanelActions", () => {
  beforeEach(() => _resetForTesting())

  test("registers chat, terminal, activity actions when task has no diff capability", () => {
    const togglePane = mock(() => {})
    const task = makeTask({ capabilities: [] })
    renderHook(() => usePanelActions(task, togglePane))

    const ids = getActions().map((a) => a.id)
    expect(ids).toContain("panel.toggle-chat")
    expect(ids).toContain("panel.toggle-terminal")
    expect(ids).toContain("panel.toggle-activity")
    expect(ids).not.toContain("panel.toggle-diff")
  })

  test("registers diff action when task has diff capability", () => {
    const togglePane = mock(() => {})
    const task = makeTask({ capabilities: ["diff"] })
    renderHook(() => usePanelActions(task, togglePane))

    expect(getActions().map((a) => a.id)).toContain("panel.toggle-diff")
  })

  test("does not register diff action when task lacks diff capability", () => {
    const togglePane = mock(() => {})
    const task = makeTask({ capabilities: ["resolve"] })
    renderHook(() => usePanelActions(task, togglePane))

    expect(getActions().map((a) => a.id)).not.toContain("panel.toggle-diff")
  })

  test("handlers call togglePane with correct pane id", () => {
    const togglePane = mock(() => {})
    const task = makeTask({ capabilities: ["diff"] })
    renderHook(() => usePanelActions(task, togglePane))

    getAction("panel.toggle-chat")!.handler()
    getAction("panel.toggle-diff")!.handler()
    getAction("panel.toggle-terminal")!.handler()
    getAction("panel.toggle-activity")!.handler()

    expect(togglePane).toHaveBeenCalledTimes(4)
    const calls = (togglePane as ReturnType<typeof mock>).mock.calls as string[][]
    expect(calls[0][0]).toBe("chat")
    expect(calls[1][0]).toBe("diff")
    expect(calls[2][0]).toBe("terminal")
    expect(calls[3][0]).toBe("activity")
  })

  test("unregisters actions on unmount", () => {
    const togglePane = mock(() => {})
    const task = makeTask({ capabilities: [] })
    const { unmount } = renderHook(() => usePanelActions(task, togglePane))

    expect(getActions().length).toBeGreaterThan(0)
    unmount()
    expect(getActions().filter((a) => a.id.startsWith("panel.")).length).toBe(0)
  })

  test("all actions have section 'Panels'", () => {
    const togglePane = mock(() => {})
    const task = makeTask({ capabilities: ["diff"] })
    renderHook(() => usePanelActions(task, togglePane))

    const panelActions = getActions().filter((a) => a.id.startsWith("panel."))
    expect(panelActions.length).toBeGreaterThan(0)
    for (const action of panelActions) {
      expect(action.section).toBe("Panels")
    }
  })

  test("terminal action has a keyboard shortcut when defaults applied", () => {
    setShortcutOverrides(defaultShortcuts)
    const togglePane = mock(() => {})
    const task = makeTask({ capabilities: [] })
    renderHook(() => usePanelActions(task, togglePane))

    const terminalAction = getAction("panel.toggle-terminal")
    expect(terminalAction?.shortcut).toBeDefined()
  })

  test("handles null task gracefully", () => {
    const togglePane = mock(() => {})
    // Should not throw and should still register base actions
    renderHook(() => usePanelActions(null, togglePane))
    const ids = getActions().map((a) => a.id)
    expect(ids).toContain("panel.toggle-chat")
    expect(ids).not.toContain("panel.toggle-diff")
  })
})

describe("useResizable", () => {
  test("tracks drag delta across pointer moves", () => {
    const onResize = mock(() => {})
    const { result } = renderHook(() => useResizable({ onResize }))

    act(() => {
      result.current.onPointerDown({
        preventDefault: () => {},
        clientX: 120,
        pointerId: 7,
      } as unknown as ReactPointerEvent<HTMLElement>)
    })

    expect(document.body.style.cursor).toBe("col-resize")
    expect(document.body.style.userSelect).toBe("none")

    act(() => {
      const firstMove = Object.assign(new Event("pointermove"), { clientX: 150, pointerId: 7, pointerType: "mouse", buttons: 1 })
      const secondMove = Object.assign(new Event("pointermove"), { clientX: 165, pointerId: 7, pointerType: "mouse", buttons: 1 })
      window.dispatchEvent(firstMove)
      window.dispatchEvent(secondMove)
    })

    expect(onResize).toHaveBeenCalledTimes(2)
    const calls = (onResize as ReturnType<typeof mock>).mock.calls as number[][]
    expect(calls[0][0]).toBe(30)
    expect(calls[1][0]).toBe(15)

    act(() => {
      const pointerUp = Object.assign(new Event("pointerup"), { pointerId: 7 })
      window.dispatchEvent(pointerUp)
    })

    expect(document.body.style.cursor).toBe("")
    expect(document.body.style.userSelect).toBe("")
  })

  test("resets drag when mouse buttons are released without pointerup", () => {
    const onResize = mock(() => {})
    const { result } = renderHook(() => useResizable({ onResize }))

    act(() => {
      result.current.onPointerDown({
        preventDefault: () => {},
        clientX: 100,
        pointerId: 1,
      } as unknown as ReactPointerEvent<HTMLElement>)
    })

    expect(document.body.style.cursor).toBe("col-resize")

    // Simulate a pointermove with buttons=0 (mouse button released without pointerup)
    act(() => {
      const staleMove = Object.assign(new Event("pointermove"), { clientX: 200, pointerId: 1, pointerType: "mouse", buttons: 0 })
      window.dispatchEvent(staleMove)
    })

    expect(onResize).not.toHaveBeenCalled()
    expect(document.body.style.cursor).toBe("")
  })

  test("ignores unrelated pointers and resets styles on unmount", () => {
    const onResize = mock(() => {})
    const { result, unmount } = renderHook(() => useResizable({ onResize }))

    act(() => {
      result.current.onPointerDown({
        preventDefault: () => {},
        clientX: 80,
        pointerId: 3,
      } as unknown as ReactPointerEvent<HTMLElement>)
    })

    act(() => {
      const otherPointerMove = Object.assign(new Event("pointermove"), { clientX: 140, pointerId: 9, pointerType: "mouse", buttons: 1 })
      window.dispatchEvent(otherPointerMove)
    })
    expect(onResize).not.toHaveBeenCalled()

    unmount()
    expect(document.body.style.cursor).toBe("")
    expect(document.body.style.userSelect).toBe("")
  })
})
