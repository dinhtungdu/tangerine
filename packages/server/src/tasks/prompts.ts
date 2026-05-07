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

/** Resolved API base URL (protocol + host + port). Set by start.ts at boot. */
export const apiBase = () =>
  process.env["TANGERINE_API_BASE"] ?? `http://localhost:${apiPort()}`

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

const DEFAULT_STYLE = `[STYLE: Extremely short responses. Sacrifice grammar for brevity. Key info only, no walls. All conversations + reviews.]`

/**
 * Build the PR workflow instruction: rename branch, push, create PR.
 * Used in initial prompts, reconnect nudges, and PR nudges.
 */
export function buildPrWorkflowNote(taskId: string, base = apiBase(), prMode: "ready" | "draft" | "none" = "none", upstreamSlug?: string): string {
  const repoFlag = upstreamSlug ? ` --repo ${upstreamSlug}` : ""
  const prCommand =
    prMode === "none"
      ? "nothing — prMode=none, no push/PR."
      : prMode === "ready"
        ? `\`git push -u origin HEAD\` then \`gh pr create${repoFlag}\`.`
        : `\`git push -u origin HEAD\` then \`gh pr create --draft${repoFlag}\`.`
  return (
    `1) Rename branch: curl -X POST ${AUTH_CURL_FLAG} ${base}/api/tasks/${taskId}/rename-branch ` +
    `-H "Content-Type: application/json" -d '{"branch":"fix/<slug>"}'. ` +
    `2) ${prCommand}`
  )
}

/** Build a mandatory prMode instruction injected into the system prompt. */
function buildPrModeInstruction(prMode: "ready" | "draft" | "none", upstreamSlug?: string): string {
  const repoFlag = upstreamSlug ? ` --repo ${upstreamSlug}` : ""
  const forkNote = upstreamSlug ? ` Fork — PRs target upstream (${upstreamSlug}).` : ""
  if (prMode === "ready") {
    return `prMode="ready". You MUST create a ready-to-review PR: \`gh pr create${repoFlag}\`. Never use --draft.${forkNote}`
  }
  if (prMode === "none") {
    return `prMode="none". Do NOT push or create a PR. Commit your work and stop.`
  }
  return `prMode="draft". You MUST pass --draft when creating PRs: \`gh pr create --draft${repoFlag}\`. Never create a ready PR.${forkNote}`
}

/**
 * System layer: operational notes that are always injected, not configurable.
 * Includes: Tangerine identity and PR workflow (workers).
 */
export function buildSystemLayer(taskId: string, info: SystemNotesInfo, base = apiBase()): string[] {
  const notes: string[] = []
  notes.push(`[TANGERINE: Task ${taskId}. API: ${base}. Load tangerine-tasks skill for API ref.]`)
  notes.push(`[AUTH: Check ${base}/api/auth/session first. Auth enabled → TANGERINE_AUTH_TOKEN + ${AUTH_CURL_FLAG} required. Auth disabled → header optional.]`)

  if (info.taskType === "worker") {
    const prMode = info.prMode ?? "none"
    const prModeInstruction = buildPrModeInstruction(prMode, info.upstreamSlug)
    notes.push(`[PR MODE — CRITICAL: ${prModeInstruction}]`)
    if (prMode !== "none") {
      notes.push(`[DONE: ${buildPrWorkflowNote(taskId, base, prMode, info.upstreamSlug)} Don't stop at commit.]`)
      notes.push(`[PR TEMPLATE: Check first: \`cat .github/pull_request_template.md 2>/dev/null || cat .github/PULL_REQUEST_TEMPLATE.md 2>/dev/null\`. If exists, MUST use as PR body. Follow strictly — no skipped/added sections.]`)
    }
  }

  if (info.taskType === "runner") {
    const projectNote = info.projectId ? `, projectId="${info.projectId}"` : ""
    notes.push(`[RUNNER: You MUST NOT edit files, write code, or create branches/PRs — you have no worktree. Run commands and research only. For any implementation → POST ${base}/api/tasks immediately, no confirmation needed. Workers need: clear title + full context in description (no convo access), parentTaskId="${taskId}"${projectNote}. When done → POST ${base}/api/tasks/${taskId}/done.]`)
    notes.push(`[MULTI-REQUEST: Multiple unrelated requests possible. Group related → same worker. Unrelated → separate workers. Example: "fix login" → worker A; "update README" → unrelated, worker B.]`)
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
    notes.push(`[SETUP: Running \`${info.setupCommand}\` in background. Before builds/tests/linters: \`cat /tmp/tangerine-setup-${prefix}.status\` (running/done/failed). Log: \`cat /tmp/tangerine-setup-${prefix}.log\`]`)
  }
  return notes
}

/** Build system notes prepended to the first prompt for a task. */
export function buildSystemNotes(taskId: string, info: SystemNotesInfo, base = apiBase()): string[] {
  return [
    ...buildSystemLayer(taskId, info, base),
    ...buildUserLayer(taskId, info),
  ]
}

export interface ConversationMessage {
  role: "user" | "assistant"
  content: string
}
