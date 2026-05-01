import { describe, expect, it } from "bun:test"
import { buildSkillsCliArgs, detectSkillAgentsFromConfig, runSkillsAction } from "../cli/install"

describe("detectSkillAgentsFromConfig", () => {
  it("maps configured ACP adapter commands to real skills.sh agents", () => {
    const config = {
      agents: [
        { id: "claude", name: "Claude", command: "bunx", args: ["--bun", "@agentclientprotocol/claude-agent-acp"] },
        { id: "codex", name: "Codex", command: "codex-acp" },
        { id: "opencode", name: "OpenCode", command: "opencode", args: ["acp"] },
        { id: "pi", name: "Pi", command: "bunx --bun pi-acp" },
      ],
    }

    expect(detectSkillAgentsFromConfig(config)).toEqual(["claude-code", "codex", "opencode", "pi"])
  })

  it("deduplicates repeated adapter mappings", () => {
    const config = {
      agents: [
        { id: "pi-a", name: "Pi A", command: "pi-acp" },
        { id: "pi-b", name: "Pi B", command: "bunx", args: ["--bun", "pi-acp"] },
      ],
    }

    expect(detectSkillAgentsFromConfig(config)).toEqual(["pi"])
  })

  it("ignores unknown adapter commands", () => {
    const config = {
      agents: [
        { id: "custom", name: "Custom", command: "my-acp-adapter" },
      ],
    }

    expect(detectSkillAgentsFromConfig(config)).toEqual([])
  })
})

describe("runSkillsAction", () => {
  it("runs skills.sh with detected agents", () => {
    const calls: string[][] = []

    runSkillsAction("install", {
      agents: [{ id: "pi", name: "Pi", command: "pi-acp" }],
    }, (args) => {
      calls.push(args)
      return { exitCode: 0 }
    })

    expect(calls).toEqual([buildSkillsCliArgs("install", ["pi"])])
  })

  it("fails when config has no supported adapter commands", () => {
    expect(() => runSkillsAction("install", { agents: [] }, () => ({ exitCode: 0 }))).toThrow("No supported ACP adapter commands")
  })
})

describe("buildSkillsCliArgs", () => {
  it("builds skills.sh add args for detected real agents", () => {
    expect(buildSkillsCliArgs("install", ["pi", "claude-code"], "/repo")).toEqual([
      "add",
      "/repo",
      "--global",
      "--agent",
      "pi",
      "--agent",
      "claude-code",
      "--skill",
      "platform-setup",
      "--skill",
      "tangerine-tasks",
      "--skill",
      "release-semver",
      "-y",
    ])
  })

  it("builds skills.sh remove args for detected real agents", () => {
    expect(buildSkillsCliArgs("uninstall", ["codex", "opencode"], "/repo")).toEqual([
      "remove",
      "--global",
      "--agent",
      "codex",
      "--agent",
      "opencode",
      "--skill",
      "platform-setup",
      "--skill",
      "tangerine-tasks",
      "--skill",
      "release-semver",
      "-y",
    ])
  })
})
