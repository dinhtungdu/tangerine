// Self-update: polls git remote to detect available updates (check-only).
// Actual updates are applied via the project update API endpoint.
// Enabled by setting TANGERINE_SELF_UPDATE=1.

import { Effect } from "effect"
import { createLogger } from "./logger"
import { Poller } from "./integrations/poller"

const log = createLogger("self-update")

const POLL_INTERVAL_MS = 5 * 60_000

export interface UpdateStatus {
  available: boolean
  local: string
  remote: string
  checkedAt: string
}

// Per-project update status (keyed by repo dir)
const updateStatuses = new Map<string, UpdateStatus>()

function execInDir(cmd: string, cwd: string): Effect.Effect<string, Error> {
  return Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(["bash", "-c", cmd], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        proc.exited,
      ])
      if (exitCode !== 0) throw new Error(`Command failed (exit ${exitCode}): ${cmd}`)
      return stdout.trim()
    },
    catch: (e) => e instanceof Error ? e : new Error(String(e)),
  })
}

/** Check a project repo for available updates. Does NOT pull or restart. */
export function checkForUpdate(repoDir: string, defaultBranch: string): Effect.Effect<UpdateStatus, never> {
  return Effect.gen(function* () {
    yield* execInDir("git fetch origin", repoDir).pipe(Effect.catchAll(() => Effect.void))

    const local = yield* execInDir("git rev-parse HEAD", repoDir).pipe(Effect.orElse(() => Effect.succeed("")))
    const remote = yield* execInDir(`git rev-parse origin/${defaultBranch}`, repoDir).pipe(Effect.orElse(() => Effect.succeed("")))

    const status: UpdateStatus = {
      available: !!(local && remote && local !== remote),
      local: local.slice(0, 8),
      remote: remote.slice(0, 8),
      checkedAt: new Date().toISOString(),
    }

    updateStatuses.set(repoDir, status)
    if (status.available) {
      log.info("Update available", { repoDir, from: status.local, to: status.remote })
    }

    return status
  }).pipe(Effect.catchAll(() => Effect.succeed({
    available: false,
    local: "",
    remote: "",
    checkedAt: new Date().toISOString(),
  })))
}

/** Get cached update status for a repo dir. */
export function getUpdateStatus(repoDir: string): UpdateStatus | null {
  return updateStatuses.get(repoDir) ?? null
}

/** Clear cached status after an update is applied. */
export function clearUpdateStatus(repoDir: string): void {
  updateStatuses.delete(repoDir)
}

/** Start polling all project repos for updates. */
export function startUpdateChecker(
  projects: { name: string; repoDir: string; defaultBranch: string }[],
): Effect.Effect<void, never> {
  log.info("Update checker enabled", { projects: projects.map((p) => p.name), intervalMs: POLL_INTERVAL_MS })

  const checkAll = Effect.gen(function* () {
    for (const project of projects) {
      yield* checkForUpdate(project.repoDir, project.defaultBranch)
    }
  }).pipe(Effect.catchAll(() => Effect.void))

  const poller = new Poller(POLL_INTERVAL_MS, checkAll)
  return poller.start()
}
