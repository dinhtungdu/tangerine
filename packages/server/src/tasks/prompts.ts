// Helpers for building agent prompt blocks (system notes, escalation instructions).
// Centralised here so start.ts and any future callers (reconnect nudge, etc.) stay DRY.

import { DEFAULT_API_PORT } from "@tangerine/shared"

export interface SystemNotesInfo {
  setupCommand?: string
  taskType?: string
}

/** Build system notes prepended to the first prompt for a task. */
export function buildSystemNotes(taskId: string, info: SystemNotesInfo): string[] {
  const notes: string[] = []
  notes.push(`[TANGERINE: You are running inside a Tangerine task (task ID: ${taskId}). The Tangerine API is at http://localhost:3456. Load the tangerine-tasks skill (\`/tangerine-tasks\`) for full API reference and common workflows.]`)
  notes.push(`[STYLE: Be extremely short and concise in all responses — sacrifice grammar for brevity. Key info only, no walls of text. Applies to all conversations and reviews.]`)
  if (info.setupCommand) {
    const prefix = taskId.slice(0, 8)
    notes.push(`[NOTE: Project setup is running in the background (\`${info.setupCommand}\`). Before running builds, tests, or linters, check if setup is done: \`cat /tmp/tangerine-setup-${prefix}.status\` (running/done/failed). Log: \`cat /tmp/tangerine-setup-${prefix}.log\`]`)
  }
  // Reviewer tasks don't create PRs — they review existing ones on their branch.
  // The PR monitor completes them when the PR merges, so don't tell them to push/create PRs.
  if (info.taskType !== "reviewer") {
    notes.push(`[NOTE: When your work is complete, push your branch and create a pull request. Use \`git push origin HEAD\` then \`gh pr create\`. Do not stop at just committing.]`)
  }
  return notes
}

/** Build the escalation block appended to the initial prompt for worker tasks. */
export function buildEscalationBlock(orchestratorId: string, port = Number(process.env["PORT"] ?? DEFAULT_API_PORT)): string {
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
