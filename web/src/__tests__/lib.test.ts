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
import { getActivityStyle, getActivityDetail } from "../lib/activity"
import { searchModels } from "../lib/model-search"
import { copyToClipboard } from "../lib/clipboard"
import { buildSshEditorUri } from "../lib/ssh-editor"
import {
  registerActions,
  registerActionCombos,
  patchActionShortcut,
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

  test("is case-insensitive and uses canonical task ID in href", () => {
    const result = linkifyTaskIds("ABC12345-0000-0000-0000-000000000001", tasks)
    // Link is produced and href uses canonical lowercase ID, not the matched text
    expect(result).toContain('<a href="/tasks/abc12345-0000-0000-0000-000000000001"')
    expect(result).toContain("abc12345</a>")
  })
})

