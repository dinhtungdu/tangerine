import { describe, expect, it } from "bun:test"
import { join } from "path"
import { homedir } from "os"
import { createAgentFactories } from "../agent/factories"

describe("agent provider skill metadata", () => {
  it("exposes skill directories for all providers", () => {
    const factories = createAgentFactories()

    expect(factories.opencode.metadata.skills.directory).toBe(join(homedir(), ".claude", "skills"))
    expect(factories["claude-code"].metadata.skills.directory).toBe(join(homedir(), ".claude", "skills"))
    expect(factories.codex.metadata.skills.directory).toBe(join(homedir(), ".codex", "skills"))
    expect(factories.pi.metadata.skills.directory).toBe(join(homedir(), ".pi", "agent", "skills"))
  })
})
