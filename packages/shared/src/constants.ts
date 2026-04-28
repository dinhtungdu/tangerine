export const DEFAULT_API_PORT = 3456
export const DEFAULT_SSL_PORT = 3443
export const DEFAULT_POLL_INTERVAL_MINUTES = 60
export const DEFAULT_IDLE_TIMEOUT_MS = 600_000
export const HEALTH_CHECK_INTERVAL_MS = 30_000
export const MAX_RETRY_ATTEMPTS = 3
export const WS_HEARTBEAT_INTERVAL_MS = 15_000
export const WS_HEARTBEAT_TIMEOUT_MS = 45_000
export const DEFAULT_AGENT_ID = "acp" as const

/** Reserved task name for the per-project orchestrator (always pinned to slot 0). */
export const ORCHESTRATOR_TASK_NAME = "_orchestrator"

/** Task statuses that represent a completed lifecycle (no longer active). */
export const TERMINAL_STATUSES = new Set(["done", "failed", "cancelled"])

/** Check if a repo string refers to a GitHub-hosted repo (including GHE). */
export function isGithubRepo(repo: string): boolean {
  return /github(?:\.[a-z0-9-]+)*\.[a-z]+/.test(repo) || /^[^/]+\/[^/]+$/.test(repo)
}
