import { describe, test, expect } from "bun:test"
import {
  formatModelName,
  formatDuration,
  formatDate,
  formatRelativeTime,
  formatTimestamp,
  formatCronExpression,
} from "../lib/format"
import { getStatusConfig, STATUS_CONFIG } from "../lib/status"
import { getActivityStyle, getActivityDetail } from "../lib/activity"
import { searchModels } from "../lib/model-search"
import { copyToClipboard } from "../lib/clipboard"
import { buildSshEditorUri } from "../lib/ssh-editor"

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
    test("formats HH:MM:SS", () => {
      const result = formatTimestamp("2026-03-18T14:32:01Z")
      expect(result).toMatch(/\d{2}:\d{2}:\d{2}/)
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
