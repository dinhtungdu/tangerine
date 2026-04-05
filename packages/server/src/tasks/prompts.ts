// Helpers for building agent prompt blocks (system notes, escalation instructions).
// Centralised here so start.ts and any future callers (reconnect nudge, etc.) stay DRY.

import { DEFAULT_API_PORT } from "@tangerine/shared"

const apiPort = () => Number(process.env["PORT"] ?? DEFAULT_API_PORT)

export interface SystemNotesInfo {
  setupCommand?: string
  taskType?: string
  prMode?: "ready" | "draft" | "none"
}

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

/** Build system notes prepended to the first prompt for a task. */
export function buildSystemNotes(taskId: string, info: SystemNotesInfo, port = apiPort()): string[] {
  const notes: string[] = []
  notes.push(`[TANGERINE: You are running inside a Tangerine task (task ID: ${taskId}). The Tangerine API is at http://localhost:${port}. Load the tangerine-tasks skill (\`/tangerine-tasks\`) for full API reference and common workflows.]`)
  notes.push(`[STYLE: Be extremely short and concise in all responses — sacrifice grammar for brevity. Key info only, no walls of text. Applies to all conversations and reviews.]`)
  if (info.setupCommand) {
    const prefix = taskId.slice(0, 8)
    notes.push(`[NOTE: Project setup is running in the background (\`${info.setupCommand}\`). Before running builds, tests, or linters, check if setup is done: \`cat /tmp/tangerine-setup-${prefix}.status\` (running/done/failed). Log: \`cat /tmp/tangerine-setup-${prefix}.log\`]`)
  }
  // Only workers rename their branch, push, and open a PR.
  // Reviewers review existing PRs on an existing branch; orchestrators run on the project default branch.
  if (info.taskType === "worker") {
    const prMode = info.prMode ?? "none"
    const prModeInstruction = buildPrModeInstruction(prMode)
    notes.push(`[PR MODE — CRITICAL: ${prModeInstruction}]`)
    if (prMode !== "none") {
      notes.push(`[NOTE: When your work is complete: ${buildPrWorkflowNote(taskId, port, prMode)} Do not stop at just committing.]`)
      notes.push(`[PR TEMPLATE: Before running \`gh pr create\`, check for a PR template: \`cat .github/pull_request_template.md 2>/dev/null || cat .github/PULL_REQUEST_TEMPLATE.md 2>/dev/null\`. If a PR template exists in the repo, you MUST use it as the structure for your PR body. Follow it strictly — do not skip sections, do not add sections not in the template.]`)
    }
  }
  return notes
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
