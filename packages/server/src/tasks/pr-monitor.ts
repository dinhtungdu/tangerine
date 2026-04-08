// PR monitor: extracts PR URLs from agent events and polls PR status.
// When a PR is merged → complete task. When closed without merge → cancel task.
// Also discovers PRs by polling the remote for each task's branch (catches PRs
// created outside the agent, e.g. manually or by another tool).

import { Effect, Schedule } from "effect"
import type { Database } from "bun:sqlite"
import { createLogger } from "../logger"
import type { TaskRow } from "../db/types"
import type { CleanupDeps } from "./cleanup"
import { cleanupSession } from "./cleanup"
import { emitStatusChange, clearAgentWorkingState } from "./events"
import { taskHasCapability } from "../api/helpers"
import { ghSpawnEnv, extractPrUrl, extractGithubSlug } from "../gh"

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
 * Verify a PR URL actually belongs to the given branch.
 * Prevents false positives when an agent mentions another task's PR in its output.
 */
export function verifyPrBranch(prUrl: string, expectedBranch: string): Effect.Effect<boolean, never> {
  return Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(
        ["gh", "pr", "view", prUrl, "--json", "headRefName", "--jq", ".headRefName"],
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
      return text.trim() === expectedBranch
    },
    catch: (err) => { log.warn("verifyPrBranch threw", { prUrl, error: String(err) }); return false },
  }).pipe(Effect.catchAll(() => Effect.succeed(false)))
}

export interface PrLookupTarget {
  repoSlug: string
  expectedHeadOwner?: string
}

function getRepoOwner(repoSlug: string): string | null {
  return repoSlug.split("/")[0] ?? null
}

/** Build PR lookup order. For forks, search parent first but constrain head owner to the fork owner. */
export function getPrLookupTargets(repoSlug: string, repoView?: RepoViewResult | null): PrLookupTarget[] {
  const repoOwner = getRepoOwner(repoSlug)
  const parentSlug = repoView?.isFork ? (repoView.parent?.nameWithOwner ?? null) : null
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
  const proc = Bun.spawn(
    ["gh", "pr", "list", "--head", branch, "--repo", repoSlug, "--json", "url,headRefName,headRepositoryOwner"],
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

export interface PrMonitorDeps {
  db: Database
  listTasks(filter?: { status?: string }): Effect.Effect<TaskRow[], Error>
  updateTask(taskId: string, updates: Partial<Omit<TaskRow, "id">>): Effect.Effect<unknown, Error>
  logActivity(taskId: string, type: "lifecycle" | "file" | "system", event: string, content: string, metadata?: Record<string, unknown>): Effect.Effect<unknown, Error>
  cleanupDeps: CleanupDeps
  /** Resolve repo URL from project config when task row has no repo_url. */
  getRepoUrl?: (projectId: string) => string | null
  /** Override PR state checker for testing. Defaults to `checkPrState` (shells out to `gh`). */
  checkPrState?: (prUrl: string) => Effect.Effect<PrState | null, never>
  /** Override branch PR lookup for testing. Defaults to `lookupPrByBranch` (shells out to `gh`). */
  lookupPrByBranch?: (repoUrl: string, branch: string) => Effect.Effect<string | null, never>
}

const TERMINATED_STATUSES = new Set(["done", "cancelled"])

/** Poll active tasks with pr_url and act on merged/closed PRs. */
export function pollPrStatuses(deps: PrMonitorDeps): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    // Fetch all tasks and filter out terminal ones — PR discovery and tracking
    // must cover all non-terminated statuses (created, provisioning, running, failed),
    // not just "running", so we catch PRs for tasks that idle, fail, or haven't started yet.
    const allTasks = yield* deps.listTasks().pipe(
      Effect.catchAll(() => Effect.succeed([] as TaskRow[]))
    )
    const active = allTasks.filter((t) => !TERMINATED_STATUSES.has(t.status))

    // Phase 1: discover PR URLs for tasks that have the "pr-track" capability but no URL yet
    const withoutPr = active.filter((t) => !t.pr_url && t.branch && taskHasCapability(t.type, t.capabilities, "pr-track"))
    if (withoutPr.length > 0) {
      const lookup = deps.lookupPrByBranch ?? lookupPrByBranch
      log.debug("Discovering PRs for tasks without pr_url", { count: withoutPr.length })
      for (const task of withoutPr) {
        const repoUrl = task.repo_url || deps.getRepoUrl?.(task.project_id) || null
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

    const checker = deps.checkPrState ?? checkPrState
    for (const task of withPr) {
      const state = yield* checker(task.pr_url!)

      if (!state || state === "open") continue

      if (state === "merged") {
        log.info("PR merged, completing task", { taskId: task.id, prUrl: task.pr_url })

        yield* deps.updateTask(task.id, {
          status: "done",
          completed_at: new Date().toISOString(),
        }).pipe(Effect.ignoreLogged)

        yield* deps.logActivity(task.id, "lifecycle", "task.completed", `Task completed: PR merged (${task.pr_url})`).pipe(
          Effect.catchAll(() => Effect.void)
        )

        clearAgentWorkingState(task.id)
        emitStatusChange(task.id, "done")

        yield* cleanupSession(task.id, deps.cleanupDeps).pipe(Effect.ignoreLogged)
      } else if (state === "closed") {
        log.info("PR closed without merge, cancelling task", { taskId: task.id, prUrl: task.pr_url })

        yield* deps.updateTask(task.id, {
          status: "cancelled",
          completed_at: new Date().toISOString(),
        }).pipe(Effect.ignoreLogged)

        yield* deps.logActivity(task.id, "lifecycle", "task.cancelled", `Task cancelled: PR closed without merge (${task.pr_url})`).pipe(
          Effect.catchAll(() => Effect.void)
        )

        clearAgentWorkingState(task.id)
        emitStatusChange(task.id, "cancelled")

        yield* cleanupSession(task.id, deps.cleanupDeps).pipe(Effect.ignoreLogged)
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
