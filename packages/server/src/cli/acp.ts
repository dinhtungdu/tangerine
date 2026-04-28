import { loadConfig } from "../config"
import { probeAcpAgents } from "../agent/acp-probe"
import type { AcpProbeResult } from "../agent/acp-probe"
import { parseArgs, printTable } from "./helpers"

export async function runAcp(args: string[]): Promise<void> {
  const parsed = parseArgs(args, {
    agent: { alias: "a" },
    cwd: {},
    prompt: { alias: "p" },
    timeout: { alias: "t" },
    json: {},
  })

  if (parsed.flags.help === "true" || parsed.command !== "probe") {
    printAcpHelp()
    return
  }

  const app = loadConfig()
  let agents = app.config.agents
  const selectedAgent = parsed.flags.agent
  if (selectedAgent) agents = agents.filter((agent) => agent.id === selectedAgent)
  if (agents.length === 0) {
    throw new Error(selectedAgent ? `No configured ACP agent: ${selectedAgent}` : "No ACP agents configured")
  }

  const timeoutMs = parsePositiveInt(parsed.flags.timeout, 5_000)
  const results = await probeAcpAgents(agents, {
    cwd: parsed.flags.cwd ?? process.cwd(),
    prompt: parsed.flags.prompt,
    timeoutMs,
  })

  if (parsed.flags.json === "true") {
    console.log(JSON.stringify(results, null, 2))
    return
  }

  printProbeTable(results)
}

function printAcpHelp(): void {
  console.log(`
Usage: tangerine acp probe [options]

Options:
  --agent, -a <id>     Probe one configured ACP agent
  --cwd <path>         Working directory for session/new (default: current dir)
  --prompt, -p <text>  Also run session/prompt and summarize stream events
  --timeout, -t <ms>   Per-agent timeout (default: 5000)
  --json               Print raw JSON probe result
  --help, -h           Show help text

Examples:
  tangerine acp probe
  tangerine acp probe --agent claude --prompt "Say hi" --json
`)
}

function printProbeTable(results: AcpProbeResult[]): void {
  printTable(
    ["Agent", "Init", "Session", "Config", "Prompt", "Events", "Error"],
    results.map((result) => [
      result.agentId,
      result.initialized ? "ok" : "fail",
      result.sessionStarted ? "ok" : "fail",
      formatConfig(result),
      result.promptRan ? "ok" : "skip",
      formatEvents(result),
      result.error ?? "",
    ]),
  )
}

function formatConfig(result: AcpProbeResult): string {
  const parts: string[] = []
  if (result.session?.hasLegacyModels) parts.push("models")
  if (result.session?.hasLegacyModes) parts.push("modes")
  for (const category of result.session?.configOptionCategories ?? []) {
    if (!parts.includes(category)) parts.push(category)
  }
  return parts.length > 0 ? parts.join(",") : "none"
}

function formatEvents(result: AcpProbeResult): string {
  const entries = Object.entries(result.events.rawUpdateCounts)
  return entries.length > 0 ? entries.map(([name, count]) => `${name}:${count}`).join(",") : "none"
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}
