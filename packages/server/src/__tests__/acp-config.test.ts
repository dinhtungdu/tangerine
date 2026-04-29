import { describe, expect, test } from "bun:test"
import { resolveTaskTypeConfig, tangerineConfigSchema } from "@tangerine/shared"
import { resolveTaskPermissionMode } from "../tasks/lifecycle"

describe("ACP agent config", () => {
  test("parses configured ACP agents and default agent", () => {
    const config = tangerineConfigSchema.parse({
      defaultAgent: "codex",
      agents: [
        {
          id: "codex",
          name: "Codex",
          command: "codex-acp",
          args: ["--model", "gpt-5"],
          env: { FOO: "bar" },
          tui: { command: "codex", args: ["resume", "{sessionId}"], env: { SESSION: "{sessionId}" } },
        },
      ],
      projects: [
        { name: "app", repo: "org/app", setup: "bun install", defaultAgent: "codex" },
      ],
    })

    expect(config.defaultAgent).toBe("codex")
    expect(config.agents).toEqual([
      {
        id: "codex",
        name: "Codex",
        command: "codex-acp",
        args: ["--model", "gpt-5"],
        env: { FOO: "bar" },
      },
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
            runner: { agent: "codex", model: "gpt-5", reasoningEffort: "high" },
          },
        },
      ],
    })

    expect(config.projects[0]?.taskTypes?.runner?.agent).toBe("codex")
    expect(config.projects[0]?.taskTypes?.runner?.model).toBe("gpt-5")
    expect(config.projects[0]?.taskTypes?.runner?.reasoningEffort).toBe("high")
  })

  test("parses task-type permission mode defaults", () => {
    const config = tangerineConfigSchema.parse({
      defaultAgent: "acp",
      agents: [{ id: "acp", name: "Default ACP", command: "acp-agent" }],
      projects: [
        {
          name: "app",
          repo: "org/app",
          setup: "bun install",
          taskTypes: {
            worker: { permissionMode: "skipPermissions" },
            reviewer: { permissionMode: "autoAccept" },
          },
        },
      ],
    })

    expect(resolveTaskTypeConfig(config.projects[0]!, "worker").permissionMode).toBe("skipPermissions")
    expect(resolveTaskTypeConfig(config.projects[0]!, "reviewer").permissionMode).toBe("autoAccept")
    expect(resolveTaskTypeConfig(config.projects[0]!, "runner").permissionMode).toBe("skipPermissions")
    expect(resolveTaskPermissionMode(config.projects[0]!, "runner")).toBe("skipPermissions")
  })

  test("rejects legacy autoApprove task-type config", () => {
    const parsed = tangerineConfigSchema.safeParse({
      defaultAgent: "acp",
      agents: [{ id: "acp", name: "Default ACP", command: "acp-agent" }],
      projects: [
        {
          name: "app",
          repo: "org/app",
          setup: "bun install",
          taskTypes: {
            worker: { autoApprove: false },
          },
        },
      ],
    })

    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues[0]?.message).toContain("permissionMode")
  })
})
