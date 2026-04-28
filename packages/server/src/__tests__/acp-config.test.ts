import { describe, expect, test } from "bun:test"
import { tangerineConfigSchema } from "@tangerine/shared"

describe("ACP agent config", () => {
  test("parses configured ACP agents and default agent", () => {
    const config = tangerineConfigSchema.parse({
      defaultAgent: "codex",
      agents: [
        { id: "codex", name: "Codex", command: "codex-acp", args: ["--model", "gpt-5"], env: { FOO: "bar" } },
      ],
      projects: [
        { name: "app", repo: "org/app", setup: "bun install", defaultAgent: "codex" },
      ],
    })

    expect(config.defaultAgent).toBe("codex")
    expect(config.agents).toEqual([
      { id: "codex", name: "Codex", command: "codex-acp", args: ["--model", "gpt-5"], env: { FOO: "bar" } },
    ])
    expect(config.projects[0]?.defaultAgent).toBe("codex")
  })

  test("parses task-type agent and model defaults", () => {
    const config = tangerineConfigSchema.parse({
      defaultAgent: "acp",
      agents: [
        { id: "acp", name: "Default ACP", command: "acp-agent" },
        { id: "codex", name: "Codex", command: "codex-acp" },
      ],
      projects: [
        {
          name: "app",
          repo: "org/app",
          setup: "bun install",
          defaultAgent: "acp",
          taskTypes: {
            orchestrator: { agent: "codex", model: "gpt-5", reasoningEffort: "high" },
          },
        },
      ],
    })

    expect(config.projects[0]?.taskTypes?.orchestrator?.agent).toBe("codex")
    expect(config.projects[0]?.taskTypes?.orchestrator?.model).toBe("gpt-5")
    expect(config.projects[0]?.taskTypes?.orchestrator?.reasoningEffort).toBe("high")
  })
})
