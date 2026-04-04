import { describe, expect, it } from "bun:test"
import { join } from "path"
import { homedir } from "os"
import { PROVIDER_DISPLAY_NAMES, SUPPORTED_PROVIDERS } from "@tangerine/shared"
import { createAgentFactories } from "../agent/factories"

describe("agent provider skill metadata", () => {
  it("exposes display names and skill directories for all providers", () => {
    const factories = createAgentFactories()

    expect(SUPPORTED_PROVIDERS).toEqual(["opencode", "claude-code", "codex", "pi"])
    expect(factories.opencode.metadata.displayName).toBe(PROVIDER_DISPLAY_NAMES.opencode)
    expect(factories["claude-code"].metadata.displayName).toBe(PROVIDER_DISPLAY_NAMES["claude-code"])
    expect(factories.codex.metadata.displayName).toBe(PROVIDER_DISPLAY_NAMES.codex)
    expect(factories.pi.metadata.displayName).toBe(PROVIDER_DISPLAY_NAMES.pi)
    expect(factories.opencode.metadata.skills.directory).toBe(join(homedir(), ".claude", "skills"))
    expect(factories["claude-code"].metadata.skills.directory).toBe(join(homedir(), ".claude", "skills"))
    expect(factories.codex.metadata.skills.directory).toBe(join(homedir(), ".codex", "skills"))
    expect(factories.pi.metadata.skills.directory).toBe(join(homedir(), ".pi", "agent", "skills"))
  })
})
