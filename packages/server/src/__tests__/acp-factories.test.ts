import { describe, expect, test } from "bun:test"
import { createAgentFactories } from "../agent/factories"

describe("ACP agent factories", () => {
  test("default factory is ACP-only", () => {
    const factories = createAgentFactories()

    expect(Object.keys(factories)).toEqual(["acp"])
    expect(factories.acp?.metadata.displayName).toBe("ACP")
    expect(factories.opencode).toBeUndefined()
    expect(factories["claude-code"]).toBeUndefined()
    expect(factories.codex).toBeUndefined()
    expect(factories.pi).toBeUndefined()
  })

  test("are built from configured ACP agents", () => {
    const factories = createAgentFactories({
      agents: [
        { id: "codex", name: "Codex", command: "codex-acp", args: ["--model", "gpt-5"] },
        { id: "claude", name: "Claude", command: "claude-agent-acp" },
      ],
    })

    expect(Object.keys(factories)).toEqual(["codex", "claude"])
    expect(factories.codex?.metadata.displayName).toBe("Codex")
    expect(factories.codex?.metadata.cliCommand).toBe("codex-acp")
    expect(factories.claude?.metadata.displayName).toBe("Claude")
    expect(factories.claude?.metadata.cliCommand).toBe("claude-agent-acp")
  })
})
