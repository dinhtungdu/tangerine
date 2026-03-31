// Self-update: on-demand git remote checks to detect available updates.
// Actual updates are applied via the project update API endpoint.

import { Effect } from "effect"
import { createLogger } from "./logger"

const log = createLogger("self-update")

export interface UpdateStatus {
  available: boolean
  local: string
  remote: string
  checkedAt: string
}

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

/** Check a project repo for available updates on-demand. Does NOT pull or restart. */
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

/** Clear cached status after an update is applied. */
export function clearUpdateStatus(_repoDir: string): void {
  // No-op — kept for API compatibility after removing the poller cache.
  // The update-status endpoint now checks on-demand.
}
