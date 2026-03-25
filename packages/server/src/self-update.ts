// Self-update: polls git remote for new commits and restarts the server when behind.
// Enabled by setting TANGERINE_SELF_UPDATE=1. Restart is via process.exit(0) — the
// bin/tangerine-watch wrapper loop handles re-execution.

import { Effect } from "effect"
import { resolve } from "path"
import { createLogger } from "./logger"
import { Poller } from "./integrations/poller"

const log = createLogger("self-update")

// Repo root is 3 levels up from packages/server/src/
const REPO_DIR = resolve(import.meta.dir, "../../..")
const POLL_INTERVAL_MS = 60_000

function exec(cmd: string): Effect.Effect<string, Error> {
  return Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(["bash", "-c", cmd], {
        cwd: REPO_DIR,
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

export function checkAndUpdate(): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    yield* exec("git fetch origin").pipe(Effect.catchAll(() => Effect.void))

    const local = yield* exec("git rev-parse HEAD").pipe(Effect.orElse(() => Effect.succeed("")))
    // @{u} resolves to the upstream tracking branch (origin/main etc.)
    const remote = yield* exec("git rev-parse @{u}").pipe(Effect.orElse(() => Effect.succeed("")))

    if (!local || !remote || local === remote) return

    log.info("New commits on remote, pulling...", { from: local.slice(0, 8), to: remote.slice(0, 8) })

    yield* exec("git pull --rebase").pipe(
      Effect.tapError((e) => Effect.sync(() => log.error("git pull failed", { error: e.message }))),
      Effect.catchAll(() => Effect.void)
    )

    // Verify pull actually moved HEAD (rebase conflict or nothing to do)
    const pulled = yield* exec("git rev-parse HEAD").pipe(Effect.orElse(() => Effect.succeed("")))
    if (pulled === local) {
      log.warn("Pull did not advance HEAD, skipping restart")
      return
    }

    // Re-install only if lockfile changed in the pulled commits
    const lockChanged = yield* exec(`git diff ${local}..HEAD -- bun.lockb`).pipe(
      Effect.map((diff) => diff.length > 0),
      Effect.orElse(() => Effect.succeed(false))
    )
    if (lockChanged) {
      log.info("bun.lockb changed, running bun install")
      yield* exec("bun install").pipe(
        Effect.tapError((e) => Effect.sync(() => log.warn("bun install failed (non-fatal)", { error: e.message }))),
        Effect.catchAll(() => Effect.void)
      )
    }

    log.info("Update applied, restarting", { commit: pulled.slice(0, 8) })
    process.exit(0)
  }).pipe(Effect.catchAll(() => Effect.void))
}

export function startSelfUpdate(): Effect.Effect<void, never> {
  log.info("Self-update enabled", { repoDir: REPO_DIR, intervalMs: POLL_INTERVAL_MS })
  const poller = new Poller(POLL_INTERVAL_MS, checkAndUpdate())
  return poller.start()
}
