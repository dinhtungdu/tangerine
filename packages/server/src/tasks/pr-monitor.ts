// PR monitor: extracts PR URLs from agent events and polls PR status.
// When a PR is merged → complete task. When closed without merge → cancel task.

import { Effect, Schedule } from "effect"
import type { Database } from "bun:sqlite"
import { createLogger } from "../logger"
import type { TaskRow } from "../db/types"
import type { CleanupDeps } from "./cleanup"
import { cleanupSession } from "./cleanup"
import { emitStatusChange } from "./events"

const log = createLogger("pr-monitor")

const PR_POLL_INTERVAL_MS = 60_000
const GITHUB_PR_URL_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/

/** Extract a GitHub PR URL from text, if present. */
export function extractPrUrl(text: string): string | null {
  const match = text.match(GITHUB_PR_URL_RE)
  return match ? match[0] : null
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

export interface PrMonitorDeps {
  db: Database
  listTasks(filter?: { status?: string }): Effect.Effect<TaskRow[], Error>
  updateTask(taskId: string, updates: Partial<Omit<TaskRow, "id">>): Effect.Effect<unknown, Error>
  logActivity(taskId: string, type: "lifecycle" | "file" | "system", event: string, content: string, metadata?: Record<string, unknown>): Effect.Effect<unknown, Error>
  cleanupDeps: CleanupDeps
}

/** Poll all running tasks with pr_url and act on merged/closed PRs. */
export function pollPrStatuses(deps: PrMonitorDeps): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const running = yield* deps.listTasks({ status: "running" }).pipe(
      Effect.catchAll(() => Effect.succeed([] as TaskRow[]))
    )

    const withPr = running.filter((t) => t.pr_url)
    if (withPr.length === 0) return

    log.debug("Polling PR statuses", { count: withPr.length })

    for (const task of withPr) {
      const state = yield* checkPrState(task.pr_url!)

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
    Effect.fork,
    Effect.asVoid,
  )
}
