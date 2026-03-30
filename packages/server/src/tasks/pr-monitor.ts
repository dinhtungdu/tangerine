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

const log = createLogger("pr-monitor")

const PR_POLL_INTERVAL_MS = 60_000
const GITHUB_PR_URL_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/

/** Extract a GitHub PR URL from text, if present. */
export function extractPrUrl(text: string): string | null {
  const match = text.match(GITHUB_PR_URL_RE)
  return match ? match[0] : null
}

/** Extract `owner/repo` slug from a GitHub repo URL. Returns null for non-GitHub URLs. */
export function extractGithubSlug(repoUrl: string): string | null {
  const match = repoUrl.match(/github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?$/)
  return match ? match[1]! : null
}

export type PrState = "open" | "merged" | "closed"

/** Check PR state using `gh pr view`. Returns null if check fails. */
export function checkPrState(prUrl: string): Effect.Effect<PrState | null, never> {
  return Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(["gh", "pr", "view", prUrl, "--json", "state", "--jq", ".state"], {
        stdout: "pipe",
        stderr: "pipe",
      })
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
        { stdout: "pipe", stderr: "pipe" },
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

/**
 * Look up an open PR for a branch on GitHub. Returns the PR URL if found, null otherwise.
 * Uses `gh pr list --head <branch> --repo <owner/repo>`.
 */
export function lookupPrByBranch(repoUrl: string, branch: string): Effect.Effect<string | null, never> {
  const slug = extractGithubSlug(repoUrl)
  if (!slug) return Effect.succeed(null)

  return Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(
        ["gh", "pr", "list", "--head", branch, "--repo", slug, "--json", "url", "--jq", ".[0].url"],
        { stdout: "pipe", stderr: "pipe" },
      )
      const [text, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      const exitCode = await proc.exited
      if (exitCode !== 0) {
        log.warn("gh pr list failed in lookupPrByBranch", { branch, slug, exitCode, stderr: stderr.trim() })
        return null
      }
      const url = text.trim()
      return url.startsWith("https://") ? url : null
    },
    catch: (err) => { log.warn("lookupPrByBranch threw", { branch, slug, error: String(err) }); return null },
  }).pipe(Effect.catchAll(() => Effect.succeed(null)))
}

export interface PrMonitorDeps {
  db: Database
  listTasks(filter?: { status?: string }): Effect.Effect<TaskRow[], Error>
  updateTask(taskId: string, updates: Partial<Omit<TaskRow, "id">>): Effect.Effect<unknown, Error>
  logActivity(taskId: string, type: "lifecycle" | "file" | "system", event: string, content: string, metadata?: Record<string, unknown>): Effect.Effect<unknown, Error>
  cleanupDeps: CleanupDeps
  /** Override PR state checker for testing. Defaults to `checkPrState` (shells out to `gh`). */
  checkPrState?: (prUrl: string) => Effect.Effect<PrState | null, never>
  /** Override branch PR lookup for testing. Defaults to `lookupPrByBranch` (shells out to `gh`). */
  lookupPrByBranch?: (repoUrl: string, branch: string) => Effect.Effect<string | null, never>
}

/** Poll all running tasks with pr_url and act on merged/closed PRs. */
export function pollPrStatuses(deps: PrMonitorDeps): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const running = yield* deps.listTasks({ status: "running" }).pipe(
      Effect.catchAll(() => Effect.succeed([] as TaskRow[]))
    )

    // Phase 1: discover PR URLs for tasks that have the "pr" capability but no URL yet
    const withoutPr = running.filter((t) => !t.pr_url && t.branch && t.repo_url && taskHasCapability(t.type, t.capabilities, "pr"))
    if (withoutPr.length > 0) {
      const lookup = deps.lookupPrByBranch ?? lookupPrByBranch
      log.debug("Discovering PRs for tasks without pr_url", { count: withoutPr.length })
      for (const task of withoutPr) {
        const prUrl = yield* lookup(task.repo_url, task.branch!)
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

    // Phase 2: check state of all tasks that now have a pr_url
    const withPr = running.filter((t) => t.pr_url)
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
