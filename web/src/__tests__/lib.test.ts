import { describe, test, expect } from "bun:test"
import {
  formatModelName,
  formatDuration,
  formatDate,
  formatRelativeTime,
  formatTimestamp,
} from "../lib/format"
import { getStatusConfig, STATUS_CONFIG } from "../lib/status"
import { getEventType, getEventStyle, EVENT_STYLES } from "../lib/activity"

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
  test("getEventType detects read events", () => {
    expect(getEventType("Read file src/index.ts")).toBe("read")
    expect(getEventType("file-search for config")).toBe("read")
  })

  test("getEventType detects write events", () => {
    expect(getEventType("Write file src/app.tsx")).toBe("write")
    expect(getEventType("file-pen update")).toBe("write")
  })

  test("getEventType detects bash events", () => {
    expect(getEventType("Bash: npm install")).toBe("bash")
    expect(getEventType("Terminal command executed")).toBe("bash")
  })

  test("getEventType detects search events", () => {
    expect(getEventType("Search for pattern")).toBe("search")
    expect(getEventType("Grep results")).toBe("search")
  })

  test("getEventType detects test events", () => {
    expect(getEventType("Running test suite")).toBe("test")
  })

  test("getEventType returns default for unknown", () => {
    expect(getEventType("Some random message")).toBe("default")
  })

  test("getEventStyle returns classes for all types", () => {
    const style = getEventStyle("Read file foo")
    expect(style.bgClass).toBeDefined()
    expect(style.dotClass).toBeDefined()
  })

  test("all event styles have bgClass and dotClass", () => {
    for (const [, style] of Object.entries(EVENT_STYLES)) {
      expect(style.bgClass).toBeDefined()
      expect(style.dotClass).toBeDefined()
    }
  })
})
