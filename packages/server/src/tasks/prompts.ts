// Helpers for building agent prompt blocks (system notes, escalation instructions).
// Centralised here so start.ts and any future callers (reconnect nudge, etc.) stay DRY.
//
// Prompts are split into two layers:
// - System layer: operational scaffolding (identity, PR workflow, escalation, delegation).
//   Always injected, not configurable per project.
// - User layer: behavioral guidance (style, setup notes, custom instructions).
//   Configurable per project via taskTypes config.

import { DEFAULT_API_PORT } from "@tangerine/shared"

const apiPort = () => Number(process.env["PORT"] ?? DEFAULT_API_PORT)

export interface SystemNotesInfo {
  setupCommand?: string
  taskType?: string
  prMode?: "ready" | "draft" | "none"
  /** Custom system prompt from taskTypes config (already resolved by caller). */
  customSystemPrompt?: string
}

const DEFAULT_STYLE = `[STYLE: Be extremely short and concise in all responses — sacrifice grammar for brevity. Key info only, no walls of text. Applies to all conversations and reviews.]`

/**
 * Build the PR workflow instruction: rename branch, push, create PR.
 * Used in initial prompts, reconnect nudges, and PR nudges.
 */
export function buildPrWorkflowNote(taskId: string, port = apiPort(), prMode: "ready" | "draft" | "none" = "none"): string {
  const prCommand =
    prMode === "none"
      ? "nothing — prMode is none, do NOT push or create a PR."
      : prMode === "ready"
        ? "`git push -u origin HEAD` then `gh pr create`."
        : "`git push -u origin HEAD` then `gh pr create --draft`."
  return (
    `1) Rename your branch via: curl -X POST http://localhost:${port}/api/tasks/${taskId}/rename-branch ` +
    `-H "Content-Type: application/json" -d '{"branch":"fix/<descriptive-slug>"}'. ` +
    `2) Push and create a PR with ${prCommand}`
  )
}

/** Build a mandatory prMode instruction injected into the system prompt. */
export function buildPrModeInstruction(prMode: "ready" | "draft" | "none"): string {
  if (prMode === "ready") {
    return `This project's prMode is "ready". You MUST create a ready-to-review PR: \`gh pr create\`. Never use --draft.`
  }
  if (prMode === "none") {
    return `This project's prMode is "none". Do NOT push or create a PR. Just commit your work and stop.`
  }
  return `This project's prMode is "draft". You MUST pass --draft when creating PRs: \`gh pr create --draft\`. Never create a ready PR.`
}

/**
 * System layer: operational notes that are always injected, not configurable.
 * Includes: Tangerine identity, PR workflow (workers), delegation rules (orchestrators).
 */
export function buildSystemLayer(taskId: string, info: SystemNotesInfo, port = apiPort()): string[] {
  const notes: string[] = []
  notes.push(`[TANGERINE: You are running inside a Tangerine task (task ID: ${taskId}). The Tangerine API is at http://localhost:${port}. Load the tangerine-tasks skill for full API reference and common workflows.]`)

  if (info.taskType === "worker") {
    const prMode = info.prMode ?? "none"
    const prModeInstruction = buildPrModeInstruction(prMode)
    notes.push(`[PR MODE — CRITICAL: ${prModeInstruction}]`)
    if (prMode !== "none") {
      notes.push(`[NOTE: When your work is complete: ${buildPrWorkflowNote(taskId, port, prMode)} Do not stop at just committing.]`)
      notes.push(`[PR TEMPLATE: Before running \`gh pr create\`, check for a PR template: \`cat .github/pull_request_template.md 2>/dev/null || cat .github/PULL_REQUEST_TEMPLATE.md 2>/dev/null\`. If a PR template exists in the repo, you MUST use it as the structure for your PR body. Follow it strictly — do not skip sections, do not add sections not in the template.]`)
    }
  }

  if (info.taskType === "orchestrator") {
    notes.push(`[DELEGATION — CRITICAL: All implementation and review work must go through sub-tasks. Never implement, review diffs, or read code directly. The orchestrator only coordinates.]`)
    notes.push(`[CONTEXT: Every file read, git diff, tool call, and message fetch consumes your context window and shortens your session life. Keep interactions with the API minimal and purposeful.]`)
  }

  return notes
}

/**
 * User layer: behavioral notes configurable per project.
 * When a custom system prompt is provided via taskTypes config, it replaces the defaults.
 */
export function buildUserLayer(taskId: string, info: SystemNotesInfo): string[] {
  if (info.customSystemPrompt) {
    return [info.customSystemPrompt]
  }

  // Defaults when no custom prompt is configured
  const notes: string[] = []
  notes.push(DEFAULT_STYLE)
  if (info.setupCommand) {
    const prefix = taskId.slice(0, 8)
    notes.push(`[NOTE: Project setup is running in the background (\`${info.setupCommand}\`). Before running builds, tests, or linters, check if setup is done: \`cat /tmp/tangerine-setup-${prefix}.status\` (running/done/failed). Log: \`cat /tmp/tangerine-setup-${prefix}.log\`]`)
  }
  return notes
}

/** Build system notes prepended to the first prompt for a task. */
export function buildSystemNotes(taskId: string, info: SystemNotesInfo, port = apiPort()): string[] {
  return [
    ...buildSystemLayer(taskId, info, port),
    ...buildUserLayer(taskId, info),
  ]
}

/** Build the escalation block appended to the initial prompt for worker tasks. */
export function buildEscalationBlock(orchestratorId: string, port = apiPort()): string {
  return [
    "",
    "---",
    "## Out-of-scope issues",
    "",
    `If you discover issues outside your task scope, first mention them to the user in your conversation, then send them to the orchestrator (task ID: ${orchestratorId}) for triage — do NOT create tasks yourself:`,
    "",
    "```bash",
    `curl -X POST http://localhost:${port}/api/tasks/${orchestratorId}/prompt \\`,
    '  -H "Content-Type: application/json" \\',
    `  -d '{"text": "Discovered out-of-scope issue: <brief description>"}'`,
    "```",
  ].join("\n")
}
