import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

describe("terminal panes", () => {
  test("keeps the shell terminal inside a padded rounded surface", () => {
    const source = readFileSync(new URL("../components/TerminalPane.tsx", import.meta.url), "utf8")

    expect(source).toContain("flex min-h-0 min-w-0 flex-1 p-3 pb-0 md:pb-3")
    expect(source).toContain("relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg md:rounded-lg rounded-b-none bg-card")
    expect(source).toContain("absolute inset-0 bg-card p-1")
  })

  test("keeps the agent TUI inside a padded rounded surface", () => {
    const source = readFileSync(new URL("../components/TuiPane.tsx", import.meta.url), "utf8")

    expect(source).toContain("flex min-h-0 min-w-0 flex-1 p-3 pb-0 md:pb-3")
    expect(source).toContain("relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg md:rounded-lg rounded-b-none bg-card")
    expect(source).toContain("absolute inset-0 bg-card p-1")
  })
})
