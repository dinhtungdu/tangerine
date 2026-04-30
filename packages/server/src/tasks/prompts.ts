// Helpers for building agent prompt blocks (system notes).
// Centralised here so start.ts and any future callers (reconnect nudge, etc.) stay DRY.
//
// Prompts are split into two layers:
// - System layer: operational scaffolding (identity, PR workflow).
//   Always injected, not configurable per project.
// - User layer: behavioral guidance (style, setup notes, custom instructions).
//   Configurable per project via taskTypes config.

import { DEFAULT_API_PORT, type TaskType } from "@tangerine/shared"
import { AUTH_CURL_FLAG } from "./api-auth"

const apiPort = () => Number(process.env["TANGERINE_PORT"] ?? DEFAULT_API_PORT)

export interface SystemNotesInfo {
  setupCommand?: string
  taskType?: TaskType
  prMode?: "ready" | "draft" | "none"
  /** Custom system prompt from taskTypes config (already resolved by caller). */
  customSystemPrompt?: string
  /** For fork repos: the upstream repo slug (owner/repo) to target PRs against. */
  upstreamSlug?: string
  /** Current task's project ID (used for runner delegation). */
  projectId?: string
}

const DEFAULT_STYLE = `[STYLE: Be extremely short and concise in all responses — sacrifice grammar for brevity. Key info only, no walls of text. Applies to all conversations and reviews.]`

/**
 * Build the PR workflow instruction: rename branch, push, create PR.
 * Used in initial prompts, reconnect nudges, and PR nudges.
 */
export function buildPrWorkflowNote(taskId: string, port = apiPort(), prMode: "ready" | "draft" | "none" = "none", upstreamSlug?: string): string {
  const repoFlag = upstreamSlug ? ` --repo ${upstreamSlug}` : ""
  const prCommand =
    prMode === "none"
      ? "nothing — prMode is none, do NOT push or create a PR."
      : prMode === "ready"
        ? `\`git push -u origin HEAD\` then \`gh pr create${repoFlag}\`.`
        : `\`git push -u origin HEAD\` then \`gh pr create --draft${repoFlag}\`.`
  return (
    `1) Rename your branch via: curl -X POST ${AUTH_CURL_FLAG} http://localhost:${port}/api/tasks/${taskId}/rename-branch ` +
    `-H "Content-Type: application/json" -d '{"branch":"fix/<descriptive-slug>"}'. ` +
    `2) Push and create a PR with ${prCommand}`
  )
}

/** Build a mandatory prMode instruction injected into the system prompt. */
function buildPrModeInstruction(prMode: "ready" | "draft" | "none", upstreamSlug?: string): string {
  const repoFlag = upstreamSlug ? ` --repo ${upstreamSlug}` : ""
  const forkNote = upstreamSlug ? ` This is a fork — PRs must target the upstream repo (${upstreamSlug}).` : ""
  if (prMode === "ready") {
    return `This project's prMode is "ready". You MUST create a ready-to-review PR: \`gh pr create${repoFlag}\`. Never use --draft.${forkNote}`
  }
  if (prMode === "none") {
    return `This project's prMode is "none". Do NOT push or create a PR. Just commit your work and stop.`
  }
  return `This project's prMode is "draft". You MUST pass --draft when creating PRs: \`gh pr create --draft${repoFlag}\`. Never create a ready PR.${forkNote}`
}

/**
 * System layer: operational notes that are always injected, not configurable.
 * Includes: Tangerine identity and PR workflow (workers).
 */
export function buildSystemLayer(taskId: string, info: SystemNotesInfo, port = apiPort()): string[] {
  const notes: string[] = []
  notes.push(`[TANGERINE: You are running inside a Tangerine task (task ID: ${taskId}). The Tangerine API is at http://localhost:${port}. Load the tangerine-tasks skill for full API reference and common workflows.]`)
  notes.push(`[AUTH: Always include ${AUTH_CURL_FLAG} on Tangerine API curl calls. When auth is disabled the server ignores this header.]`)

  if (info.taskType === "worker") {
    const prMode = info.prMode ?? "none"
    const prModeInstruction = buildPrModeInstruction(prMode, info.upstreamSlug)
    notes.push(`[PR MODE — CRITICAL: ${prModeInstruction}]`)
    if (prMode !== "none") {
      notes.push(`[NOTE: When your work is complete: ${buildPrWorkflowNote(taskId, port, prMode, info.upstreamSlug)} Do not stop at just committing.]`)
      notes.push(`[PR TEMPLATE: Before running \`gh pr create\`, check for a PR template: \`cat .github/pull_request_template.md 2>/dev/null || cat .github/PULL_REQUEST_TEMPLATE.md 2>/dev/null\`. If a PR template exists in the repo, you MUST use it as the structure for your PR body. Follow it strictly — do not skip sections, do not add sections not in the template.]`)
    }
  }

  if (info.taskType === "runner") {
    const projectNote = info.projectId ? `, projectId to "${info.projectId}"` : ""
    notes.push(`[RUNNER TASK: This task runs without a dedicated worktree or branch — no PR creation. You can run commands on the project root but CANNOT make code changes directly. For any implementation work (code changes, fixes, features), immediately create a worker sub-task via POST /api/tasks — do NOT ask for confirmation, just delegate. When creating worker tasks: use a clear title, include full context and requirements in description (the worker has no access to this conversation), and set parentTaskId to "${taskId}"${projectNote}. Complete when done by calling POST /api/tasks/${taskId}/done.]`)
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

export interface ConversationMessage {
  role: "user" | "assistant"
  content: string
}
