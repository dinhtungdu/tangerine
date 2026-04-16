// PR monitor: extracts PR URLs from agent events and polls PR status.
// When a PR is merged or closed:
// - Running tasks: notify the agent so it can handle post-merge work, then self-complete
// - Non-running tasks (created, provisioning, failed): directly complete/cancel
// Also discovers PRs by polling the remote for each task's branch (catches PRs
// created outside the agent, e.g. manually or by another tool).

import { Effect, Schedule } from "effect"
import type { Database } from "bun:sqlite"
import { DEFAULT_API_PORT } from "@tangerine/shared"
import { createLogger } from "../logger"
import type { TaskRow } from "../db/types"
import type { CleanupDeps } from "./cleanup"
import { cleanupSession } from "./cleanup"
import { emitStatusChange, clearAgentWorkingState } from "./events"
import { clearQueue } from "../agent/prompt-queue"
import { clearTaskState } from "./task-state"
import { taskHasCapability } from "../api/helpers"
import { ghSpawnEnv, extractPrUrl, extractGithubSlug } from "../gh"
import { AUTH_CURL_FLAG } from "./api-auth"

export { extractPrUrl, extractGithubSlug }

interface RepoViewResult {
  nameWithOwner?: string
  isFork?: boolean
  parent?: { nameWithOwner?: string | null } | null
}

interface PrListItem {
  url?: string
  headRefName?: string
  headRepositoryOwner?: { login?: string | null } | null
}

const log = createLogger("pr-monitor")
const PR_POLL_INTERVAL_MS = 60_000

export type PrState = "open" | "merged" | "closed"

/** Check PR state using `gh pr view`. Returns null if check fails. */
export function checkPrState(prUrl: string): Effect.Effect<PrState | null, never> {
  return Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(["gh", "pr", "view", prUrl, "--json", "state", "--jq", ".state"], ghSpawnEnv())
      const text = await new Response(proc.stdout).text()
      const exitCode = await proc.exited
      if (exitCode !== 0) return null
      const state = text.trim().toUpperCase()
      if (state === "MERGED") return "merged"
      if (state === "CLOSED") return "closed"
      if (state === "OPEN") return "open"
      return null
    },
    catch: () => null,
  }).pipe(Effect.catchAll(() => Effect.succeed(null)))
}

/**
 * Verify a PR URL belongs to the given branch AND is still open.
 * Prevents false positives when an agent mentions another task's PR or a
 * closed/merged PR from a previous run on the same branch.
 */
export function verifyPrBranch(prUrl: string, expectedBranch: string): Effect.Effect<boolean, never> {
  return Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(
        ["gh", "pr", "view", prUrl, "--json", "headRefName,state"],
        ghSpawnEnv(),
      )
      const [text, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      const exitCode = await proc.exited
      if (exitCode !== 0) {
        log.warn("gh pr view failed in verifyPrBranch", { prUrl, exitCode, stderr: stderr.trim() })
        return false
      }
      const data = JSON.parse(text) as { headRefName?: string; state?: string }
      if (data.state?.toUpperCase() !== "OPEN") {
        log.info("Rejecting non-open PR in verifyPrBranch", { prUrl, state: data.state })
        return false
      }
      return data.headRefName === expectedBranch
    },
    catch: (err) => { log.warn("verifyPrBranch threw", { prUrl, error: String(err) }); return false },
  }).pipe(Effect.catchAll(() => Effect.succeed(false)))
}

export interface PrLookupTarget {
  repoSlug: string
  expectedHeadOwner?: string
}

/** Extract the repo owner from a slug. Handles both `owner/repo` and `host/owner/repo`. */
function getRepoOwner(repoSlug: string): string | null {
  const parts = repoSlug.split("/")
  // host/owner/repo → owner; owner/repo → owner
  return parts.length >= 3 ? (parts[1] ?? null) : (parts[0] ?? null)
}

/** Extract `host` from a host-qualified slug, or null for bare `owner/repo`. */
function getSlugHost(repoSlug: string): string | null {
  const parts = repoSlug.split("/")
  return parts.length >= 3 ? (parts[0] ?? null) : null
}

/** Build PR lookup order. For forks, search parent first but constrain head owner to the fork owner. */
export function getPrLookupTargets(repoSlug: string, repoView?: RepoViewResult | null): PrLookupTarget[] {
  const repoOwner = getRepoOwner(repoSlug)
  const host = getSlugHost(repoSlug)
  let parentSlug = repoView?.isFork ? (repoView.parent?.nameWithOwner ?? null) : null
  // nameWithOwner from gh is bare owner/repo — qualify with host for GHE.
  // Check structurally (2 parts = bare) rather than substring match.
  if (parentSlug && host && parentSlug.split("/").length === 2) {
    parentSlug = `${host}/${parentSlug}`
  }
  return parentSlug && parentSlug !== repoSlug
    ? [{ repoSlug: parentSlug, expectedHeadOwner: repoOwner ?? undefined }, { repoSlug }]
    : [{ repoSlug }]
}

async function getRepoView(repoSlug: string): Promise<RepoViewResult | null> {
  const proc = Bun.spawn(
    ["gh", "repo", "view", repoSlug, "--json", "nameWithOwner,isFork,parent"],
    ghSpawnEnv(),
  )
  const [text, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    log.warn("gh repo view failed in lookupPrByBranch", { repoSlug, exitCode, stderr: stderr.trim() })
    return null
  }

  try {
    return JSON.parse(text) as RepoViewResult
  } catch (error) {
    log.warn("Failed to parse gh repo view output in lookupPrByBranch", { repoSlug, error: String(error) })
    return null
  }
}

async function listPrUrl(repoSlug: string, branch: string, expectedHeadOwner?: string): Promise<string | null> {
  // Use --state open only: we must never discover a closed/merged PR for an active task.
  // Assigning a closed PR would cause Phase 2 to immediately cancel the task.
  // Phase 2 already handles state changes for PRs that were open when discovered.
  const proc = Bun.spawn(
    ["gh", "pr", "list", "--head", branch, "--repo", repoSlug, "--state", "open", "--json", "url,headRefName,headRepositoryOwner"],
    ghSpawnEnv(),
  )
  const [text, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    log.warn("gh pr list failed in lookupPrByBranch", { branch, repoSlug, expectedHeadOwner, exitCode, stderr: stderr.trim() })
    return null
  }

  try {
    const prs = JSON.parse(text) as PrListItem[]
    const match = prs.find((pr) => {
      if (pr.headRefName !== branch) return false
      if (!expectedHeadOwner) return true
      return pr.headRepositoryOwner?.login === expectedHeadOwner
    })
    return match?.url?.startsWith("https://") ? match.url : null
  } catch (error) {
    log.warn("Failed to parse gh pr list output in lookupPrByBranch", { branch, repoSlug, expectedHeadOwner, error: String(error) })
    return null
  }
}

/**
 * Look up an open PR for a branch on GitHub. Returns the PR URL if found, null otherwise.
 * For forks, search the upstream repo first since PRs usually target upstream.
 */
export function lookupPrByBranch(repoUrl: string, branch: string): Effect.Effect<string | null, never> {
  const repoSlug = extractGithubSlug(repoUrl)
  if (!repoSlug) return Effect.succeed(null)

  return Effect.tryPromise({
    try: async () => {
      const repoView = await getRepoView(repoSlug)
      for (const target of getPrLookupTargets(repoSlug, repoView)) {
        const prUrl = await listPrUrl(target.repoSlug, branch, target.expectedHeadOwner)
        if (prUrl) return prUrl
      }
      return null
    },
    catch: (err) => { log.warn("lookupPrByBranch threw", { branch, repoSlug, error: String(err) }); return null },
  }).pipe(Effect.catchAll(() => Effect.succeed(null)))
}

/** Read the current branch name from a git worktree. Returns null if the worktree is detached or unavailable. */
export function readWorktreeBranch(worktreePath: string): Effect.Effect<string | null, never> {
  return Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(["git", "-C", worktreePath, "branch", "--show-current"], {
        stdout: "pipe",
        stderr: "pipe",
      })
      const [text, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
      if (exitCode !== 0) return null
      const branch = text.trim()
      return branch.length > 0 ? branch : null
    },
    catch: () => null,
  }).pipe(Effect.catchAll(() => Effect.succeed(null)))
}

export interface PrMonitorDeps {
  db: Database
  listTasks(filter?: { status?: string }): Effect.Effect<TaskRow[], Error>
  updateTask(taskId: string, updates: Partial<Omit<TaskRow, "id">>): Effect.Effect<unknown, Error>
  logActivity(taskId: string, type: "lifecycle" | "file" | "system", event: string, content: string, metadata?: Record<string, unknown>): Effect.Effect<unknown, Error>
  hasActivityEvent(taskId: string, event: string): Effect.Effect<boolean, Error>
  sendPrompt(taskId: string, text: string): Effect.Effect<void, never>
  cleanupDeps: CleanupDeps
  /** Look up project config to get repo URL for PR discovery. */
  getProjectRepoUrl?: (projectId: string) => string | undefined
  /** Override PR state checker for testing. Defaults to `checkPrState` (shells out to `gh`). */
  checkPrState?: (prUrl: string) => Effect.Effect<PrState | null, never>
  /** Override branch PR lookup for testing. Defaults to `lookupPrByBranch` (shells out to `gh`). */
  lookupPrByBranch?: (repoUrl: string, branch: string) => Effect.Effect<string | null, never>
  /** Override worktree branch reader for testing. Defaults to `readWorktreeBranch` (shells out to `git`). */
  readWorktreeBranch?: (worktreePath: string) => Effect.Effect<string | null, never>
}

const TERMINATED_STATUSES = new Set(["done", "cancelled"])

/** Poll active tasks with pr_url and act on merged/closed PRs. */
export function pollPrStatuses(deps: PrMonitorDeps): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    // Fetch all tasks and filter out terminated ones — PR discovery and tracking
    // must cover all non-terminated statuses (created, provisioning, running, failed),
    // not just "running", so we catch PRs for tasks that idle, fail, or haven't started yet.
    const allTasks = yield* deps.listTasks().pipe(
      Effect.catchAll(() => Effect.succeed([] as TaskRow[]))
    )
    const active = allTasks.filter((t) => !TERMINATED_STATUSES.has(t.status))

    // Phase 0: sync task.branch with the actual git HEAD branch for tasks with a worktree.
    // Agents sometimes rename their branch directly via git without going through the rename-branch
    // API, which causes task.branch to drift from the real branch the worktree is on.
    const withWorktree = active.filter((t) => t.worktree_path && t.branch)
    if (withWorktree.length > 0) {
      const branchReader = deps.readWorktreeBranch ?? readWorktreeBranch
      for (const task of withWorktree) {
        const actualBranch = yield* branchReader(task.worktree_path!)
        if (actualBranch && actualBranch !== task.branch) {
          log.info("Syncing task branch from worktree HEAD", {
            taskId: task.id,
            dbBranch: task.branch,
            actualBranch,
          })
          yield* deps.updateTask(task.id, { branch: actualBranch }).pipe(Effect.ignoreLogged)
          // Update in-memory so Phase 1 uses the corrected branch for PR discovery this cycle
          task.branch = actualBranch
        }
      }
    }

    // Phase 1: discover PR URLs for tasks that have the "pr-track" capability but no URL yet
    const withoutPr = active.filter((t) => !t.pr_url && t.branch && taskHasCapability(t.type, t.capabilities, "pr-track"))
    if (withoutPr.length > 0) {
      const lookup = deps.lookupPrByBranch ?? lookupPrByBranch
      log.debug("Discovering PRs for tasks without pr_url", { count: withoutPr.length })
      for (const task of withoutPr) {
        const repoUrl = deps.getProjectRepoUrl?.(task.project_id)
        if (!repoUrl) continue
        const prUrl = yield* lookup(repoUrl, task.branch!)
        if (prUrl) {
          log.info("Discovered PR for task branch", { taskId: task.id, branch: task.branch, prUrl })
          yield* deps.updateTask(task.id, { pr_url: prUrl }).pipe(Effect.ignoreLogged)
          yield* deps.logActivity(task.id, "lifecycle", "pr.discovered", `PR discovered for branch ${task.branch}: ${prUrl}`).pipe(
            Effect.catchAll(() => Effect.void)
          )
          // Update in-memory so Phase 2 picks it up this cycle
          task.pr_url = prUrl
        }
      }
    }

    // Phase 2: check state of all active tasks that now have a pr_url
    const withPr = active.filter((t) => t.pr_url)
    if (withPr.length === 0) return

    log.debug("Polling PR statuses", { count: withPr.length })

    const apiPort = Number(process.env["TANGERINE_PORT"] ?? DEFAULT_API_PORT)
    const checker = deps.checkPrState ?? checkPrState
    for (const task of withPr) {
      const state = yield* checker(task.pr_url!)

      if (!state || state === "open") continue

      if (state === "merged") {
        // Check if we already handled this PR merge
        const alreadyHandled = yield* deps.hasActivityEvent(task.id, "pr.merged").pipe(
          Effect.catchAll(() => Effect.succeed(false))
        )
        if (alreadyHandled) continue

        // For running tasks: notify the agent so it can do post-merge work
        // For non-running tasks: directly complete (agent can't respond)
        if (task.status === "running") {
          log.info("PR merged, notifying agent", { taskId: task.id, prUrl: task.pr_url })

          yield* deps.logActivity(task.id, "lifecycle", "pr.merged", `PR merged: ${task.pr_url}`).pipe(
            Effect.catchAll(() => Effect.void)
          )

          yield* deps.sendPrompt(
            task.id,
            `[TANGERINE: Your PR has been merged (${task.pr_url}). ` +
            `If you have post-merge work to do (e.g., publish a release, update documentation), do it now. ` +
            `When you're done, call \`curl -X POST ${AUTH_CURL_FLAG} http://localhost:${apiPort}/api/tasks/${task.id}/done\` to complete the task.]`
          )
        } else {
          log.info("PR merged, completing non-running task", { taskId: task.id, prUrl: task.pr_url, status: task.status })

          yield* deps.updateTask(task.id, {
            status: "done",
            completed_at: new Date().toISOString(),
          }).pipe(Effect.ignoreLogged)

          yield* deps.logActivity(task.id, "lifecycle", "pr.merged", `PR merged: ${task.pr_url}`).pipe(
            Effect.catchAll(() => Effect.void)
          )
          yield* deps.logActivity(task.id, "lifecycle", "task.completed", `Task completed: PR merged (${task.pr_url})`).pipe(
            Effect.catchAll(() => Effect.void)
          )

          clearAgentWorkingState(task.id)
          yield* clearQueue(task.id)
          clearTaskState(task.id)
          emitStatusChange(task.id, "done")

          yield* cleanupSession(task.id, deps.cleanupDeps).pipe(Effect.ignoreLogged)
        }
      } else if (state === "closed") {
        // Check if we already handled this PR closure
        const alreadyHandled = yield* deps.hasActivityEvent(task.id, "pr.closed").pipe(
          Effect.catchAll(() => Effect.succeed(false))
        )
        if (alreadyHandled) continue

        // For running tasks: notify the agent so it can do cleanup
        // For non-running tasks: directly cancel (agent can't respond)
        if (task.status === "running") {
          log.info("PR closed without merge, notifying agent", { taskId: task.id, prUrl: task.pr_url })

          yield* deps.logActivity(task.id, "lifecycle", "pr.closed", `PR closed without merge: ${task.pr_url}`).pipe(
            Effect.catchAll(() => Effect.void)
          )

          yield* deps.sendPrompt(
            task.id,
            `[TANGERINE: Your PR has been closed without merge (${task.pr_url}). ` +
            `If you need to inform a parent task or do cleanup, do it now. ` +
            `When you're done, call \`curl -X POST ${AUTH_CURL_FLAG} http://localhost:${apiPort}/api/tasks/${task.id}/cancel\` to cancel the task.]`
          )
        } else {
          log.info("PR closed without merge, cancelling non-running task", { taskId: task.id, prUrl: task.pr_url, status: task.status })

          yield* deps.updateTask(task.id, {
            status: "cancelled",
            completed_at: new Date().toISOString(),
          }).pipe(Effect.ignoreLogged)

          yield* deps.logActivity(task.id, "lifecycle", "pr.closed", `PR closed without merge: ${task.pr_url}`).pipe(
            Effect.catchAll(() => Effect.void)
          )
          yield* deps.logActivity(task.id, "lifecycle", "task.cancelled", `Task cancelled: PR closed without merge (${task.pr_url})`).pipe(
            Effect.catchAll(() => Effect.void)
          )

          clearAgentWorkingState(task.id)
          yield* clearQueue(task.id)
          clearTaskState(task.id)
          emitStatusChange(task.id, "cancelled")

          yield* cleanupSession(task.id, deps.cleanupDeps).pipe(Effect.ignoreLogged)
        }
      }
    }
  }).pipe(Effect.catchAll(() => Effect.void))
}

/** Start a repeating PR status poll loop as a background fiber. */
export function startPrMonitor(deps: PrMonitorDeps): Effect.Effect<void, never> {
  return pollPrStatuses(deps).pipe(
    Effect.repeat(Schedule.fixed(`${PR_POLL_INTERVAL_MS} millis`)),
    Effect.catchAll(() => Effect.void),
    Effect.asVoid,
    Effect.forkDaemon,
    Effect.asVoid,
  )
}
