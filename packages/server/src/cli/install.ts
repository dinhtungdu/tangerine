// CLI entrypoint: one-time setup for Tangerine.
// Creates local directories and installs Tangerine skills into real agent directories.

import { existsSync, mkdirSync, readFileSync } from "fs"
import { join, resolve } from "path"
import { CONFIG_PATH, readRawConfig, TANGERINE_HOME } from "../config"

const TANGERINE_SKILLS = ["platform-setup", "tangerine-tasks", "release-semver"] as const
const SUPPORTED_SKILL_AGENTS = ["claude-code", "codex", "opencode", "pi"] as const

type SkillAction = "install" | "uninstall"
type SkillAgent = (typeof SUPPORTED_SKILL_AGENTS)[number]

export interface SkillsCliResult {
  exitCode: number
}

export type SkillsCliRunner = (args: string[]) => SkillsCliResult

// Walk up from this file to find the package root (directory with package.json
// containing the package name). Works from both source and bundled locations.
function findProjectRoot(): string {
  let dir = import.meta.dir
  for (let i = 0; i < 5; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: unknown }
      if (pkg.name === "@dinhtungdu/tangerine") return dir
    } catch { /* not this directory */ }
    dir = resolve(dir, "..")
  }
  return resolve(import.meta.dir, "../../../../")
}
const PROJECT_ROOT = findProjectRoot()

function check(label: string, ok: boolean, hint?: string): void {
  if (ok) {
    console.log(`  ✓ ${label}`)
  } else {
    console.log(`  ✗ ${label}`)
    if (hint) console.log(`    → ${hint}`)
  }
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string")
}

export function detectSkillAgentFromCommand(command: string, args: string[] = []): SkillAgent | null {
  const invocation = [command, ...args].join(" ").toLowerCase()

  if (invocation.includes("@agentclientprotocol/claude-agent-acp") || invocation.includes("claude-agent-acp")) {
    return "claude-code"
  }
  if (invocation.includes("@zed-industries/codex-acp") || invocation.includes("codex-acp")) {
    return "codex"
  }
  if (invocation.includes("opencode-ai") || (/\bopencode\b/.test(invocation) && /\bacp\b/.test(invocation))) {
    return "opencode"
  }
  if (invocation.includes("pi-acp")) {
    return "pi"
  }

  return null
}

export function detectSkillAgentsFromConfig(config: unknown): SkillAgent[] {
  if (!isRecord(config) || !Array.isArray(config["agents"])) return []

  const detected: SkillAgent[] = []
  for (const agent of config["agents"]) {
    if (!isRecord(agent) || typeof agent["command"] !== "string") continue
    const skillAgent = detectSkillAgentFromCommand(agent["command"], stringArray(agent["args"]))
    if (skillAgent && !detected.includes(skillAgent)) detected.push(skillAgent)
  }
  return detected
}

export function buildSkillsCliArgs(action: SkillAction, agents: string[], source = PROJECT_ROOT): string[] {
  const args = action === "install" ? ["add", source, "--global"] : ["remove", "--global"]

  for (const agent of agents) {
    args.push("--agent", agent)
  }
  for (const skill of TANGERINE_SKILLS) {
    args.push("--skill", skill)
  }
  args.push("-y")

  return args
}

function defaultSkillsCliRunner(args: string[]): SkillsCliResult {
  try {
    const result = Bun.spawnSync(["npx", "-y", "skills", ...args], {
      stdout: "inherit",
      stderr: "inherit",
      env: process.env,
    })
    return { exitCode: result.exitCode }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Unable to run skills CLI: ${message}`, { cause: error })
  }
}

export function runSkillsAction(action: SkillAction, config: unknown, runner: SkillsCliRunner = defaultSkillsCliRunner): void {
  const agents = detectSkillAgentsFromConfig(config)
  if (agents.length === 0) {
    throw new Error(
      `No supported ACP adapter commands found in ${CONFIG_PATH}. Configure one of: claude-agent-acp, codex-acp, opencode acp, pi-acp. Supported skill targets: ${SUPPORTED_SKILL_AGENTS.join(", ")}.`
    )
  }

  const skillsDir = join(PROJECT_ROOT, "skills")
  if (!existsSync(skillsDir)) {
    throw new Error(`Tangerine skills directory not found at ${skillsDir}`)
  }

  check(`target agents: ${agents.join(", ")}`, true)
  check(`skills: ${TANGERINE_SKILLS.join(", ")}`, true)

  const args = buildSkillsCliArgs(action, agents)
  const result = runner(args)
  if (result.exitCode !== 0) {
    throw new Error(`skills CLI failed with exit code ${result.exitCode}`)
  }
}

export async function install(): Promise<void> {
  console.log("\nTangerine install\n")

  console.log("Directories:")
  ensureDir(TANGERINE_HOME)
  check(`${TANGERINE_HOME}`, true)

  console.log("\nAgent skills:")
  runSkillsAction("install", readRawConfig())

  console.log()
}

export async function uninstall(): Promise<void> {
  console.log("\nTangerine uninstall\n")

  console.log("Agent skills:")
  runSkillsAction("uninstall", readRawConfig())

  console.log()
}
