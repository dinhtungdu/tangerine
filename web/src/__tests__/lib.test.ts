import { describe, test, expect, beforeEach } from "bun:test"
import {
  formatModelName,
  formatDuration,
  formatDate,
  formatRelativeTime,
  formatTimestamp,
  formatCronExpression,
  linkifyTaskIds,
} from "../lib/format"
import { getStatusConfig, STATUS_CONFIG } from "../lib/status"
import { getActivityStyle, getActivityDetail, resolveToolInput } from "../lib/activity"
import { searchModels } from "../lib/model-search"
import { copyToClipboard } from "../lib/clipboard"
import { buildSshEditorUri } from "../lib/ssh-editor"
import { getMostRecentTask, getRecentTasks } from "../lib/task-recency"
import {
  getResponsiveVisiblePanes,
  removePaneCapability,
  selectMobilePane,
  toggleDesktopPaneState,
  toggleDesktopVisiblePanes,
  toggleMobilePaneActionState,
  type ResponsivePaneState,
} from "../lib/panes"
import {
  registerActions,
  registerActionCombos,
  patchActionShortcut,
  setShortcutOverrides,
  executeAction,
  getActions,
  getAction,
  subscribe,
  matchesShortcut,
  formatShortcut,
  setContext,
  clearContext,
  getContext,
  _resetForTesting,
} from "../lib/actions"
import { isGithubRepo, isProviderAvailable, type AgentConfig, type Task, type SystemCapabilities } from "@tangerine/shared"
import { getConfiguredAgentIds, resolveAvailableAgent } from "../lib/agent-selection"
import { findTriggerToken } from "../lib/text-trigger"
import { resolvePickerKey } from "../lib/picker-keyboard"

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    projectId: "proj",
    type: "worker",
    source: "manual",
    sourceId: null,
    sourceUrl: null,
    title: "Test task",
    description: null,
    status: "running",
    provider: "acp",
    model: null,
    reasoningEffort: null,
    branch: null,
    worktreePath: null,
    prUrl: null,
    parentTaskId: null,
    userId: null,
    agentSessionId: null,
    agentPid: null,
    suspended: false,
    error: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    startedAt: null,
    completedAt: null,
    lastSeenAt: null,
    lastResultAt: null,
    capabilities: [],
    ...overrides,
  }
}

describe("resolvePickerKey", () => {
  test("moves selection within list bounds", () => {
    expect(resolvePickerKey("ArrowDown", 0, 2)).toEqual({ action: "select", selectedIndex: 1 })
    expect(resolvePickerKey("ArrowDown", 1, 2)).toEqual({ action: "select", selectedIndex: 1 })
    expect(resolvePickerKey("ArrowUp", 1, 2)).toEqual({ action: "select", selectedIndex: 0 })
  })

  test("closes on escape and ignores other keys", () => {
    expect(resolvePickerKey("Escape", 0, 2)).toEqual({ action: "close" })
    expect(resolvePickerKey("Enter", 0, 2)).toEqual({ action: "none" })
  })

  test("does not consume arrow keys when list is empty", () => {
    expect(resolvePickerKey("ArrowDown", 0, 0)).toEqual({ action: "none" })
    expect(resolvePickerKey("ArrowUp", 0, 0)).toEqual({ action: "none" })
  })
})

describe("findTriggerToken", () => {
  test("finds triggers at start or after whitespace", () => {
    expect(findTriggerToken("#auth", 5, "#")).toEqual({ triggerStart: 0, query: "auth" })
    expect(findTriggerToken("see @web/src", 12, "@")).toEqual({ triggerStart: 4, query: "web/src" })
  })

  test("supports line-start-only triggers", () => {
    expect(findTriggerToken("/compact", 8, "/", "line-start")).toEqual({ triggerStart: 0, query: "compact" })
    expect(findTriggerToken("note\n/model", 11, "/", "line-start")).toEqual({ triggerStart: 5, query: "model" })
    expect(findTriggerToken("see /tmp", 8, "/", "line-start")).toBeNull()
  })

  test("ignores triggers inside words", () => {
    expect(findTriggerToken("email@test", 10, "@")).toBeNull()
    expect(findTriggerToken("tag#task", 8, "#")).toBeNull()
  })
})

describe("format", () => {
  describe("formatModelName", () => {
    test("strips date suffix", () => {
      expect(formatModelName("anthropic/claude-sonnet-4-20250514")).toBe("anthropic/claude-sonnet-4")
    })

    test("strips date suffix without prefix", () => {
      expect(formatModelName("claude-sonnet-4-20250514")).toBe("claude-sonnet-4")
    })

    test("returns as-is without date suffix", () => {
      expect(formatModelName("claude-sonnet-4")).toBe("claude-sonnet-4")
    })

    test("returns as-is for model with slash but no date", () => {
      expect(formatModelName("openai/gpt-4")).toBe("openai/gpt-4")
    })
  })

  describe("formatDuration", () => {
    test("formats seconds", () => {
      const now = new Date()
      const start = new Date(now.getTime() - 35000).toISOString()
      expect(formatDuration(start, now.toISOString(), start)).toBe("0m 35s")
    })

    test("formats minutes and seconds", () => {
      const now = new Date()
      const start = new Date(now.getTime() - 245000).toISOString()
      expect(formatDuration(start, now.toISOString(), start)).toBe("4m 05s")
    })

    test("formats hours and minutes", () => {
      const now = new Date()
      const start = new Date(now.getTime() - 5400000).toISOString()
      expect(formatDuration(start, now.toISOString(), start)).toBe("1h 30m")
    })

    test("uses createdAt when startedAt is null", () => {
      const now = new Date()
      const created = new Date(now.getTime() - 60000).toISOString()
      expect(formatDuration(null, now.toISOString(), created)).toBe("1m 00s")
    })

    test("uses current time when completedAt is null", () => {
      const start = new Date(Date.now() - 120000).toISOString()
      const result = formatDuration(start, null, start)
      expect(result).toMatch(/^2m \d{2}s$/)
    })
  })

  describe("formatDate", () => {
    test("formats to short month + day", () => {
      expect(formatDate("2026-03-18T10:00:00Z")).toMatch(/Mar 18/)
    })
  })

  describe("formatRelativeTime", () => {
    test("returns 'just now' for recent timestamps", () => {
      expect(formatRelativeTime(new Date().toISOString())).toBe("just now")
    })

    test("returns minutes ago", () => {
      const fiveMinAgo = new Date(Date.now() - 5 * 60000).toISOString()
      expect(formatRelativeTime(fiveMinAgo)).toBe("5m ago")
    })

    test("returns hours ago", () => {
      const threeHoursAgo = new Date(Date.now() - 3 * 3600000).toISOString()
      expect(formatRelativeTime(threeHoursAgo)).toBe("3h ago")
    })

    test("returns days ago", () => {
      const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString()
      expect(formatRelativeTime(twoDaysAgo)).toBe("2d ago")
    })
  })

  describe("formatTimestamp", () => {
    test("includes date and time", () => {
      const result = formatTimestamp("2026-03-18T14:32:01Z")
      expect(result).toMatch(/Mar \d+ · \d{2}:\d{2}:\d{2}/)
    })
  })

  describe("formatCronExpression", () => {
    test("every minute", () => {
      expect(formatCronExpression("* * * * *")).toBe("Every minute")
    })

    test("every N minutes", () => {
      expect(formatCronExpression("*/5 * * * *")).toBe("Every 5 minutes")
    })

    test("daily at specific time", () => {
      expect(formatCronExpression("0 9 * * *")).toBe("Daily at 9:00 AM")
    })

    test("weekdays at specific time", () => {
      expect(formatCronExpression("0 9 * * 1-5")).toBe("Weekdays at 9:00 AM")
    })

    test("falls back to raw for complex expressions", () => {
      expect(formatCronExpression("0 9 1 * *")).toBe("0 9 1 * *")
    })

    test("returns raw for invalid field count", () => {
      expect(formatCronExpression("bad")).toBe("bad")
    })
  })
})

describe("status", () => {
  test("getStatusConfig returns config for known statuses", () => {
    expect(getStatusConfig("running").label).toBe("Running")
    expect(getStatusConfig("failed").label).toBe("Failed")
    expect(getStatusConfig("done").label).toBe("Completed")
    expect(getStatusConfig("created").label).toBe("Queued")
    expect(getStatusConfig("provisioning").label).toBe("Provisioning")
  })

  test("getStatusConfig returns default for unknown status", () => {
    const config = getStatusConfig("unknown_status")
    expect(config.label).toBe("Unknown")
    expect(config.color).toBeTruthy()
  })

  test("all statuses have color and textClass", () => {
    for (const [, config] of Object.entries(STATUS_CONFIG)) {
      expect(config.color).toBeTruthy()
      expect(config.textClass).toBeTruthy()
      expect(config.bgClass).toBeTruthy()
    }
  })
})

describe("activity", () => {
  test("getActivityStyle returns style for tool events", () => {
    const readStyle = getActivityStyle("tool.read")
    expect(readStyle.label).toBe("Read file")
    expect(readStyle.color).toBe("#3b82f6")

    const writeStyle = getActivityStyle("tool.write")
    expect(writeStyle.label).toBe("Write file")

    const bashStyle = getActivityStyle("tool.bash")
    expect(bashStyle.label).toBe("Bash")

    const thinkStyle = getActivityStyle("agent.thinking")
    expect(thinkStyle.label).toBe("Thinking")
  })

  test("getActivityStyle returns fallback for unknown events", () => {
    const style = getActivityStyle("unknown.event")
    expect(style.color).toBeDefined()
    expect(style.iconPaths.length).toBeGreaterThan(0)
  })

  test("getActivityDetail extracts file path from tool input", () => {
    const detail = getActivityDetail("tool.read", "Read", {
      toolInput: JSON.stringify({ file_path: "src/index.ts" }),
    })
    expect(detail).toBe("src/index.ts")
  })

  test("getActivityDetail extracts command from bash input", () => {
    const detail = getActivityDetail("tool.bash", "Bash", {
      toolInput: JSON.stringify({ command: "npm test" }),
    })
    expect(detail).toBe("npm test")
  })

  test("getActivityDetail falls back to content", () => {
    const detail = getActivityDetail("tool.other", "Some content", null)
    expect(detail).toBe("Some content")
  })

  test("getActivityDetail handles toolInput as object (not string)", () => {
    const detail = getActivityDetail("tool.read", "Read", {
      toolInput: { file_path: "src/index.ts" },
    })
    expect(detail).toBe("src/index.ts")
  })

  test("getActivityDetail handles bash toolInput as object", () => {
    const detail = getActivityDetail("tool.bash", "Bash", {
      toolInput: { command: "npm test" },
    })
    expect(detail).toBe("npm test")
  })

  test("getActivityDetail returns raw string when toolInput is truncated/invalid JSON", () => {
    const truncated = '{"command":"some very long command that got cut off at 500 chars...'
    const detail = getActivityDetail("tool.bash", "Bash", { toolInput: truncated })
    expect(detail).toBe(truncated)
  })

  test("getActivityDetail returns raw string for tool.read with invalid JSON", () => {
    const truncated = '{"file_path":"/some/very/long/path/that/got/truncated...'
    const detail = getActivityDetail("tool.read", "Read", { toolInput: truncated })
    expect(detail).toBe(truncated)
  })
})

describe("resolveToolInput", () => {
  test("parses JSON string to object", () => {
    expect(resolveToolInput(JSON.stringify({ file_path: "a.ts" }))).toEqual({ file_path: "a.ts" })
  })

  test("returns object as-is", () => {
    const obj = { command: "ls" }
    expect(resolveToolInput(obj)).toBe(obj)
  })

  test("returns null for invalid JSON string", () => {
    expect(resolveToolInput("not-json")).toBeNull()
  })

  test("returns null for null/undefined", () => {
    expect(resolveToolInput(null)).toBeNull()
    expect(resolveToolInput(undefined)).toBeNull()
  })

  test("returns null for arrays", () => {
    expect(resolveToolInput(["a"])).toBeNull()
  })
})

describe("model search", () => {
  test("matches compact fuzzy queries", () => {
    expect(searchModels(["openai/gpt-5.4", "openai/gpt-5-mini"], "g54")).toEqual(["openai/gpt-5.4"])
  })

  test("matches against formatted display names", () => {
    expect(searchModels(["anthropic/claude-sonnet-4-20250514"], "sonnet4")).toEqual(["anthropic/claude-sonnet-4-20250514"])
  })

  test("prefers prefix matches over broader fuzzy matches", () => {
    expect(searchModels(["openai/gpt-5-mini", "openai/gpt-5.4", "openrouter/gemma-3"], "gpt5m")).toEqual([
      "openai/gpt-5-mini",
    ])
  })
})

describe("task recency", () => {
  test("sorts active tasks by updatedAt descending", () => {
    const tasks = getRecentTasks([
      makeTask({ id: "done", status: "done", updatedAt: "2026-01-03T00:00:00Z" }),
      makeTask({ id: "older", status: "running", updatedAt: "2026-01-01T00:00:00Z" }),
      makeTask({ id: "newer", status: "provisioning", updatedAt: "2026-01-02T00:00:00Z" }),
    ])

    expect(tasks.map((task) => task.id)).toEqual(["newer", "older"])
  })

  test("returns most recent active task or null", () => {
    expect(getMostRecentTask([
      makeTask({ id: "done", status: "done", updatedAt: "2026-01-03T00:00:00Z" }),
      makeTask({ id: "running", status: "running", updatedAt: "2026-01-02T00:00:00Z" }),
    ])?.id).toBe("running")
    expect(getMostRecentTask([makeTask({ id: "done", status: "done" })])).toBeNull()
  })
})

describe("ssh-editor", () => {
  test("builds VS Code URI", () => {
    expect(buildSshEditorUri("vscode", "dev-vm", "/workspace/project/1")).toBe(
      "vscode://vscode-remote/ssh-remote+dev-vm/workspace/project/1"
    )
  })

  test("builds Cursor URI", () => {
    expect(buildSshEditorUri("cursor", "dev-vm", "/workspace/project/1")).toBe(
      "cursor://vscode-remote/ssh-remote+dev-vm/workspace/project/1"
    )
  })

  test("builds Zed URI with user", () => {
    expect(buildSshEditorUri("zed", "dev-vm", "/workspace/project/1", "tung.linux")).toBe(
      "zed://ssh/tung.linux@dev-vm/workspace/project/1"
    )
  })

  test("builds Zed URI without user", () => {
    expect(buildSshEditorUri("zed", "dev-vm", "/workspace/project/1")).toBe(
      "zed://ssh/dev-vm/workspace/project/1"
    )
  })

  test("VS Code URI does not include user", () => {
    const uri = buildSshEditorUri("vscode", "dev-vm", "/workspace/project/1", "tung.linux")
    expect(uri).not.toContain("tung.linux")
    expect(uri).toBe("vscode://vscode-remote/ssh-remote+dev-vm/workspace/project/1")
  })

  test("Cursor URI does not include user", () => {
    const uri = buildSshEditorUri("cursor", "dev-vm", "/workspace/project/1", "tung.linux")
    expect(uri).not.toContain("tung.linux")
    expect(uri).toBe("cursor://vscode-remote/ssh-remote+dev-vm/workspace/project/1")
  })
})

describe("clipboard", () => {
  test("falls back to execCommand when Clipboard API is unavailable over HTTP", async () => {
    const originalExecCommand = document.execCommand
    const originalClipboard = navigator.clipboard

    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: false,
    })

    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    })

    let copied = false
    document.execCommand = ((command: string) => {
      copied = command === "copy"
      return true
    }) as typeof document.execCommand

    await copyToClipboard("hello over http")

    expect(copied).toBe(true)

    document.execCommand = originalExecCommand
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: originalClipboard,
    })
  })
})

describe("actions", () => {
  beforeEach(() => {
    _resetForTesting()
  })

  test("registerActions adds actions to registry", () => {
    registerActions([
      { id: "test.one", label: "Test One", handler: () => {} },
      { id: "test.two", label: "Test Two", handler: () => {} },
    ])
    expect(getActions()).toHaveLength(2)
    expect(getAction("test.one")?.label).toBe("Test One")
  })

  test("registerActions returns unregister function", () => {
    const unregister = registerActions([
      { id: "test.temp", label: "Temporary", handler: () => {} },
    ])
    expect(getActions()).toHaveLength(1)
    unregister()
    expect(getActions()).toHaveLength(0)
  })

  test("executeAction calls the handler", async () => {
    let called = false
    registerActions([
      { id: "test.exec", label: "Execute Me", handler: () => { called = true } },
    ])
    await executeAction("test.exec")
    expect(called).toBe(true)
  })

  test("executeAction forwards args to handler", async () => {
    let received: Record<string, unknown> | undefined
    registerActions([
      { id: "test.args", label: "Args Test", handler: (args) => { received = args } },
    ])
    await executeAction("test.args", { taskId: "abc123" })
    expect(received).toEqual({ taskId: "abc123" })
  })

  test("executeAction with no args passes undefined to handler", async () => {
    let received: Record<string, unknown> | undefined = { sentinel: true }
    registerActions([
      { id: "test.noargs", label: "No Args", handler: (args) => { received = args } },
    ])
    await executeAction("test.noargs")
    expect(received).toBeUndefined()
  })

  test("executeAction with unknown id does nothing", async () => {
    await executeAction("nonexistent")
    // No error thrown
  })

  test("subscribe notifies on registration and unregistration", () => {
    let count = 0
    subscribe(() => { count++ })
    const unreg = registerActions([
      { id: "test.sub", label: "Sub", handler: () => {} },
    ])
    expect(count).toBe(1)
    unreg()
    expect(count).toBe(2)
  })

  test("matchesShortcut matches ctrl+key on non-Mac (test env)", () => {
    const shortcut = { key: "k", meta: true }
    // In test env (happy-dom), navigator.userAgent is not Mac, so meta = ctrlKey
    const ctrlMatch = { key: "k", metaKey: false, ctrlKey: true, shiftKey: false, altKey: false } as KeyboardEvent
    const noMatch = { key: "k", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false } as KeyboardEvent
    expect(matchesShortcut(ctrlMatch, shortcut)).toBe(true)
    expect(matchesShortcut(noMatch, shortcut)).toBe(false)
  })

  test("matchesShortcut ignores Super key on non-Mac", () => {
    const shortcut = { key: "k", meta: true }
    // Super/metaKey should NOT match on non-Mac — reserved for OS
    const superKey = { key: "k", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false } as KeyboardEvent
    expect(matchesShortcut(superKey, shortcut)).toBe(false)
  })

  test("matchesShortcut rejects extra modifiers", () => {
    const shortcut = { key: "n", meta: true }
    const withShift = { key: "n", metaKey: false, ctrlKey: true, shiftKey: true, altKey: false } as KeyboardEvent
    expect(matchesShortcut(withShift, shortcut)).toBe(false)
  })

  test("formatShortcut formats correctly", () => {
    const result = formatShortcut({ key: "k", meta: true })
    // Result depends on navigator.userAgent but should contain the key
    expect(result).toContain("K")
  })

  describe("registerActionCombos", () => {
    test("registers combo actions into registry", () => {
      registerActionCombos([
        { id: "combo.test", label: "Test Combo", sequence: ["a", "b"] },
      ])
      const action = getAction("combo.test")
      expect(action).toBeDefined()
      expect(action!.label).toBe("Test Combo")
      expect(action!.section).toBe("Combos")
    })

    test("combo handler executes sequence actions in order", async () => {
      const order: string[] = []
      registerActions([
        { id: "step.one", label: "One", handler: () => { order.push("one") } },
        { id: "step.two", label: "Two", handler: () => { order.push("two") } },
        { id: "step.three", label: "Three", handler: () => { order.push("three") } },
      ])
      registerActionCombos([
        { id: "combo.seq", label: "Sequence", sequence: ["step.one", "step.two", "step.three"] },
      ])
      await getAction("combo.seq")!.handler()
      expect(order).toEqual(["one", "two", "three"])
    })

    test("combo handler awaits async actions", async () => {
      const order: string[] = []
      registerActions([
        {
          id: "async.first", label: "First", handler: async () => {
            await new Promise((r) => setTimeout(r, 10))
            order.push("first")
          },
        },
        { id: "sync.second", label: "Second", handler: () => { order.push("second") } },
      ])
      registerActionCombos([
        { id: "combo.async", label: "Async Combo", sequence: ["async.first", "sync.second"] },
      ])
      await getAction("combo.async")!.handler()
      expect(order).toEqual(["first", "second"])
    })

    test("combo skips unknown action ids with warning", async () => {
      const warnings: string[] = []
      const origWarn = console.warn
      console.warn = (msg: string) => warnings.push(msg)

      let called = false
      registerActions([
        { id: "known.action", label: "Known", handler: () => { called = true } },
      ])
      registerActionCombos([
        { id: "combo.skip", label: "Skip Unknown", sequence: ["nonexistent", "known.action"] },
      ])
      await getAction("combo.skip")!.handler()

      expect(called).toBe(true)
      expect(warnings).toContain("Action combo: unknown action id 'nonexistent', skipping")

      console.warn = origWarn
    })

    test("combo unregister removes combo actions", () => {
      const unreg = registerActionCombos([
        { id: "combo.temp", label: "Temporary", sequence: ["a"] },
      ])
      expect(getAction("combo.temp")).toBeDefined()
      unreg()
      expect(getAction("combo.temp")).toBeUndefined()
    })

    test("combo skips self-referencing action ids", async () => {
      const warnings: string[] = []
      const origWarn = console.warn
      console.warn = (msg: string) => warnings.push(msg)

      let called = false
      registerActions([
        { id: "other.action", label: "Other", handler: () => { called = true } },
      ])
      registerActionCombos([
        { id: "combo.self", label: "Self Ref", sequence: ["combo.self", "other.action"] },
      ])
      await getAction("combo.self")!.handler()

      expect(called).toBe(true)
      expect(warnings).toContain("Action combo: skipping self-reference 'combo.self'")

      console.warn = origWarn
    })

    test("combo with colliding id is rejected", () => {
      const warnings: string[] = []
      const origWarn = console.warn
      console.warn = (msg: string) => warnings.push(msg)

      registerActions([
        { id: "task.create", label: "Original", handler: () => {} },
      ])
      registerActionCombos([
        { id: "task.create", label: "Overwrite", sequence: ["a"] },
      ])
      // Original action should still be there
      expect(getAction("task.create")!.label).toBe("Original")
      expect(warnings).toContain("Action combo: id 'task.create' collides with existing action, skipping")

      console.warn = origWarn
    })

    test("combo with shortcut is registered", () => {
      registerActionCombos([
        { id: "combo.shortcut", label: "With Shortcut", shortcut: { key: "t", meta: true }, sequence: ["a"] },
      ])
      const action = getAction("combo.shortcut")
      expect(action!.shortcut).toEqual({ key: "t", meta: true })
    })
  })

  test("context-scoped actions are hidden when no context is set", () => {
    registerActions([
      { id: "global", label: "Global", handler: () => {} },
      { id: "scoped", label: "Scoped", context: "task-1", handler: () => {} },
    ])
    expect(getActions()).toHaveLength(1)
    expect(getActions()[0].id).toBe("global")
  })

  test("context-scoped actions appear when context matches", () => {
    registerActions([
      { id: "global", label: "Global", handler: () => {} },
      { id: "scoped", label: "Scoped", context: "task-1", handler: () => {} },
    ])
    setContext("task-1")
    expect(getActions()).toHaveLength(2)
    expect(getActions().map((a) => a.id)).toContain("scoped")
  })

  test("context-scoped actions are hidden when context does not match", () => {
    registerActions([
      { id: "scoped", label: "Scoped", context: "task-1", handler: () => {} },
    ])
    setContext("task-2")
    expect(getActions()).toHaveLength(0)
  })

  test("clearContext hides context-scoped actions", () => {
    registerActions([
      { id: "scoped", label: "Scoped", context: "task-1", handler: () => {} },
    ])
    setContext("task-1")
    expect(getActions()).toHaveLength(1)
    clearContext()
    expect(getActions()).toHaveLength(0)
  })

  test("setContext and getContext round-trip", () => {
    expect(getContext()).toBeNull()
    setContext("task-1")
    expect(getContext()).toBe("task-1")
    clearContext()
    expect(getContext()).toBeNull()
  })

  test("setContext notifies subscribers", () => {
    let count = 0
    subscribe(() => { count++ })
    setContext("task-1")
    expect(count).toBe(1)
    clearContext()
    expect(count).toBe(2)
  })

  test("getAction returns context-scoped actions regardless of context", () => {
    registerActions([
      { id: "scoped", label: "Scoped", context: "task-1", handler: () => {} },
    ])
    // getAction bypasses context filtering (for direct execution)
    expect(getAction("scoped")?.label).toBe("Scoped")
  })

  describe("patchActionShortcut", () => {
    test("overrides shortcut of an existing action", () => {
      registerActions([
        { id: "task.create", label: "New task", shortcut: { key: "n", meta: true, shift: true }, handler: () => {} },
      ])
      const patched = patchActionShortcut("task.create", { key: "t", meta: true })
      expect(patched).toBe(true)
      expect(getAction("task.create")?.shortcut).toEqual({ key: "t", meta: true })
    })

    test("returns false for unknown action id", () => {
      const patched = patchActionShortcut("nonexistent.action", { key: "x" })
      expect(patched).toBe(false)
    })

    test("preserves handler when patching shortcut", async () => {
      let called = false
      registerActions([
        { id: "task.test", label: "Test", shortcut: { key: "a" }, handler: () => { called = true } },
      ])
      patchActionShortcut("task.test", { key: "b", meta: true })
      await executeAction("task.test")
      expect(called).toBe(true)
      expect(getAction("task.test")?.shortcut).toEqual({ key: "b", meta: true })
    })

    test("notifies subscribers when shortcut is patched", () => {
      registerActions([
        { id: "task.sub", label: "Sub", handler: () => {} },
      ])
      let count = 0
      subscribe(() => { count++ })
      patchActionShortcut("task.sub", { key: "s", meta: true })
      expect(count).toBe(1)
    })
  })

  describe("setShortcutOverrides", () => {
    test("patches already-registered actions", () => {
      registerActions([
        { id: "task.create", label: "New task", shortcut: { key: "n", meta: true, shift: true }, handler: () => {} },
      ])
      setShortcutOverrides({ "task.create": { key: "t", meta: true } })
      expect(getAction("task.create")?.shortcut).toEqual({ key: "t", meta: true })
    })

    test("overrides are applied to actions registered later", () => {
      setShortcutOverrides({ "late.action": { key: "l", alt: true } })
      // Action registered after overrides are set
      registerActions([
        { id: "late.action", label: "Late", shortcut: { key: "x" }, handler: () => {} },
      ])
      expect(getAction("late.action")?.shortcut).toEqual({ key: "l", alt: true })
    })

    test("overrides survive action re-registration", () => {
      setShortcutOverrides({ "task.create": { key: "t", meta: true } })
      const unreg = registerActions([
        { id: "task.create", label: "New task", shortcut: { key: "n", meta: true, shift: true }, handler: () => {} },
      ])
      expect(getAction("task.create")?.shortcut).toEqual({ key: "t", meta: true })
      // Simulate re-registration (like a React effect re-run)
      unreg()
      registerActions([
        { id: "task.create", label: "New task", shortcut: { key: "n", meta: true, shift: true }, handler: () => {} },
      ])
      expect(getAction("task.create")?.shortcut).toEqual({ key: "t", meta: true })
    })

    test("preserves handler when applying overrides", async () => {
      let called = false
      setShortcutOverrides({ "task.test": { key: "b" } })
      registerActions([
        { id: "task.test", label: "Test", shortcut: { key: "a" }, handler: () => { called = true } },
      ])
      await executeAction("task.test")
      expect(called).toBe(true)
    })

    test("clearing overrides does not revert existing shortcuts", () => {
      registerActions([
        { id: "task.create", label: "New task", shortcut: { key: "n" }, handler: () => {} },
      ])
      setShortcutOverrides({ "task.create": { key: "t" } })
      expect(getAction("task.create")?.shortcut).toEqual({ key: "t" })
      setShortcutOverrides({})
      // Existing action keeps the last-applied shortcut
      expect(getAction("task.create")?.shortcut).toEqual({ key: "t" })
    })
  })
})

describe("linkifyTaskIds", () => {
  const tasks = [
    { id: "abc12345-0000-0000-0000-000000000001" },
    { id: "abc12345-0000-0000-0000-000000000002" },
  ]

  test("replaces known UUID with short anchor tag", () => {
    const result = linkifyTaskIds("abc12345-0000-0000-0000-000000000001", tasks)
    expect(result).toContain('<a href="/tasks/abc12345-0000-0000-0000-000000000001"')
    expect(result).toContain("abc12345</a>")
  })

  test("does not linkify unknown UUIDs", () => {
    const result = linkifyTaskIds("deadbeef-0000-0000-0000-000000000099", tasks)
    expect(result).toBe("deadbeef-0000-0000-0000-000000000099")
    expect(result).not.toContain("<a")
  })

  test("handles empty tasks list — no links", () => {
    const result = linkifyTaskIds("abc12345-0000-0000-0000-000000000001", [])
    expect(result).not.toContain("<a")
  })

  test("linkifies UUID embedded in surrounding text", () => {
    const result = linkifyTaskIds("See task abc12345-0000-0000-0000-000000000001 for details", tasks)
    expect(result).toContain("See task ")
    expect(result).toContain('<a href="/tasks/abc12345-0000-0000-0000-000000000001"')
    expect(result).toContain(" for details")
  })

  test("linkifies UUID adjacent to punctuation", () => {
    const result = linkifyTaskIds("(abc12345-0000-0000-0000-000000000001)", tasks)
    expect(result).toContain('<a href="/tasks/abc12345-0000-0000-0000-000000000001"')
  })

  test("does not linkify UUIDs inside URL paths", () => {
    const url = "/api/tasks/abc12345-0000-0000-0000-000000000001/messages"
    const result = linkifyTaskIds(url, tasks)
    expect(result).toBe(url)
    expect(result).not.toContain("<a")
  })

  test("does not linkify UUIDs in full URLs", () => {
    const url = "http://localhost:3456/api/tasks/abc12345-0000-0000-0000-000000000001"
    const result = linkifyTaskIds(url, tasks)
    expect(result).toBe(url)
    expect(result).not.toContain("<a")
  })

  test("does not linkify UUIDs followed by a path segment", () => {
    const text = "abc12345-0000-0000-0000-000000000001/logs"
    const result = linkifyTaskIds(text, tasks)
    expect(result).toBe(text)
    expect(result).not.toContain("<a")
  })

  test("is case-insensitive and uses canonical task ID in href", () => {
    const result = linkifyTaskIds("ABC12345-0000-0000-0000-000000000001", tasks)
    // Link is produced and href uses canonical lowercase ID, not the matched text
    expect(result).toContain('<a href="/tasks/abc12345-0000-0000-0000-000000000001"')
    expect(result).toContain("abc12345</a>")
  })
})

// --- isGithubRepo & isProviderAvailable (shared utilities) ---

describe("isGithubRepo", () => {
  test("matches github.com URLs", () => {
    expect(isGithubRepo("https://github.com/owner/repo")).toBe(true)
    expect(isGithubRepo("github.com/owner/repo")).toBe(true)
  })

  test("matches GitHub Enterprise URLs", () => {
    expect(isGithubRepo("https://github.example.com/owner/repo")).toBe(true)
    expect(isGithubRepo("github.acme.co/org/project")).toBe(true)
  })

  test("matches owner/repo shorthand", () => {
    expect(isGithubRepo("owner/repo")).toBe(true)
  })

  test("rejects non-GitHub URLs", () => {
    expect(isGithubRepo("https://gitlab.com/owner/repo")).toBe(false)
    expect(isGithubRepo("bare-name")).toBe(false)
  })
})

describe("isProviderAvailable", () => {
  const caps: SystemCapabilities = {
    git: { available: true },
    gh: { available: true, authenticated: true },
    providers: {
      "acp": { available: true, cliCommand: "acp-agent" },
      "custom-agent": { available: false, cliCommand: "custom-acp" },
    },
  }

  test("returns true when capabilities are null (unknown)", () => {
    expect(isProviderAvailable(null, "anything")).toBe(true)
  })

  test("returns true for available provider", () => {
    expect(isProviderAvailable(caps, "acp")).toBe(true)
  })

  test("returns false for unavailable provider", () => {
    expect(isProviderAvailable(caps, "custom-agent")).toBe(false)
  })

  test("returns true for unknown provider (not in capabilities)", () => {
    expect(isProviderAvailable(caps, "acp")).toBe(true)
  })
})

describe("agent selection", () => {
  const agents: AgentConfig[] = [
    { id: "acp", name: "ACP", command: "acp-agent" },
    { id: "reviewer", name: "Reviewer", command: "reviewer-acp" },
  ]
  const caps: SystemCapabilities = {
    git: { available: true },
    gh: { available: true, authenticated: true },
    providers: {
      acp: { available: true, cliCommand: "acp-agent" },
      reviewer: { available: false, cliCommand: "reviewer-acp" },
    },
  }

  test("returns configured agent ids", () => {
    expect(getConfiguredAgentIds(agents)).toEqual(["acp", "reviewer"])
  })

  test("keeps preferred configured agent when available", () => {
    expect(resolveAvailableAgent({ agents, systemCapabilities: caps, preferred: "acp" })).toBe("acp")
  })

  test("falls back when preferred agent is not configured", () => {
    expect(resolveAvailableAgent({ agents, systemCapabilities: caps, preferred: "missing" })).toBe("acp")
  })

  test("falls back to project default before global default", () => {
    expect(resolveAvailableAgent({
      agents,
      systemCapabilities: caps,
      project: { defaultAgent: "acp" },
      globalDefaultAgent: "reviewer",
    })).toBe("acp")
  })
})

describe("toggleDesktopVisiblePanes", () => {
  test("adds a pane when it is currently hidden", () => {
    const next = toggleDesktopVisiblePanes(new Set(["chat", "activity"]), "terminal")
    expect([...next]).toEqual(["chat", "activity", "terminal"])
  })

  test("removes a pane when it is currently visible", () => {
    const next = toggleDesktopVisiblePanes(new Set(["chat", "terminal"]), "terminal")
    expect([...next]).toEqual(["chat"])
  })

  test("keeps chat visible when toggling off the last pane", () => {
    const next = toggleDesktopVisiblePanes(new Set(["chat"]), "chat")
    expect([...next]).toEqual(["chat"])
  })

  test("can allow an empty persisted set when another pane stays synced", () => {
    const next = toggleDesktopVisiblePanes(new Set(["chat"]), "chat", null)
    expect([...next]).toEqual([])
  })

  test("does not mutate the previous set", () => {
    const prev = new Set(["chat", "activity"])
    toggleDesktopVisiblePanes(prev, "terminal")
    expect([...prev]).toEqual(["chat", "activity"])
  })
})

describe("getResponsiveVisiblePanes", () => {
  test("includes the current mobile pane in desktop rendering", () => {
    const next = getResponsiveVisiblePanes(new Set(["chat", "activity"]), "terminal")
    expect([...next]).toEqual(["chat", "activity", "terminal"])
  })

  test("preserves the saved desktop layout when there is no mobile sync pane", () => {
    const next = getResponsiveVisiblePanes(new Set(["terminal", "activity"]), null)
    expect([...next]).toEqual(["terminal", "activity"])
  })

  test("does not mutate the persisted desktop pane set", () => {
    const prev = new Set(["chat", "activity"])
    getResponsiveVisiblePanes(prev, "terminal")
    expect([...prev]).toEqual(["chat", "activity"])
  })
})

function makeResponsivePaneState(overrides: Partial<ResponsivePaneState> = {}): ResponsivePaneState {
  return {
    visiblePanes: new Set(["chat", "activity"]),
    mobilePane: "chat",
    desktopSyncPane: null,
    ...overrides,
  }
}

describe("selectMobilePane", () => {
  test("tracks the selected mobile pane as a temporary desktop sync pane", () => {
    const next = selectMobilePane(makeResponsivePaneState(), "terminal")
    expect(next.mobilePane).toBe("terminal")
    expect(next.desktopSyncPane).toBe("terminal")
    expect([...next.visiblePanes]).toEqual(["chat", "activity"])
  })
})

describe("toggleMobilePaneActionState", () => {
  test("keeps mobile selection while toggling the persisted desktop set", () => {
    const next = toggleMobilePaneActionState(makeResponsivePaneState(), "terminal")
    expect(next.mobilePane).toBe("terminal")
    expect(next.desktopSyncPane).toBe("terminal")
    expect([...next.visiblePanes]).toEqual(["chat", "activity", "terminal"])
  })
})

describe("toggleDesktopPaneState", () => {
  test("hides the temporary synced pane without persisting it", () => {
    const next = toggleDesktopPaneState(makeResponsivePaneState({ desktopSyncPane: "terminal" }), "terminal")
    expect(next.desktopSyncPane).toBeNull()
    expect([...next.visiblePanes]).toEqual(["chat", "activity"])
  })

  test("preserves the synced pane when toggling another desktop pane", () => {
    const next = toggleDesktopPaneState(makeResponsivePaneState({ desktopSyncPane: "terminal" }), "activity")
    expect(next.desktopSyncPane).toBe("terminal")
    expect([...next.visiblePanes]).toEqual(["chat"])
  })

  test("promotes the synced pane into the persisted desktop layout when it becomes the only visible pane", () => {
    const next = toggleDesktopPaneState(makeResponsivePaneState({ visiblePanes: new Set(["chat"]), desktopSyncPane: "terminal" }), "chat")
    expect(next.desktopSyncPane).toBe("terminal")
    expect([...next.visiblePanes]).toEqual(["terminal"])
  })
})

describe("removePaneCapability", () => {
  test("drops the pane from all responsive pane state", () => {
    const next = removePaneCapability(
      makeResponsivePaneState({
        visiblePanes: new Set(["chat", "diff"]),
        mobilePane: "diff",
        desktopSyncPane: "diff",
      }),
      "diff",
    )
    expect([...next.visiblePanes]).toEqual(["chat"])
    expect(next.mobilePane).toBe("chat")
    expect(next.desktopSyncPane).toBeNull()
  })
})

// DiffViewer
import { getDiffStats } from "../components/DiffViewer"

describe("getDiffStats", () => {
  test("counts additions and deletions correctly", () => {
    const oldStr = "line1\nline2\nline3"
    const newStr = "line1\nline2-modified\nline3\nline4"
    const stats = getDiffStats(oldStr, newStr)
    expect(stats.additions).toBe(2)
    expect(stats.deletions).toBe(1)
  })

  test("handles no changes", () => {
    const str = "line1\nline2"
    const stats = getDiffStats(str, str)
    expect(stats.additions).toBe(0)
    expect(stats.deletions).toBe(0)
  })

  test("handles empty to new content", () => {
    const stats = getDiffStats("", "new line")
    expect(stats.additions).toBe(1)
    expect(stats.deletions).toBe(1) // empty string is one empty line
  })

  test("calculates totalLines", () => {
    const oldStr = "a\nb"
    const newStr = "a\nb\nc"
    const stats = getDiffStats(oldStr, newStr)
    expect(stats.totalLines).toBeGreaterThan(0)
  })

  test("handles reordered lines without hanging", () => {
    const oldStr = "a\nb"
    const newStr = "b\na"
    const stats = getDiffStats(oldStr, newStr)
    expect(stats.additions + stats.deletions).toBeGreaterThan(0)
    expect(stats.totalLines).toBeGreaterThan(0)
  })
})

