import { Effect } from "effect"
import { Hono } from "hono"
import type { AppDeps } from "../app"
import { mapTaskRow } from "../helpers"
import { runEffect, runEffectVoid } from "../effect-helpers"
import { projectConfigSchema, tangerineConfigSchema, TERMINAL_STATUSES } from "@tangerine/shared"
import { ProjectNotFoundError, ProjectExistsError, ConfigValidationError } from "../../errors"
import { checkForUpdate, clearUpdateStatus } from "../../self-update"
import { getRepoDir } from "../../config"
import { createLogger } from "../../logger"
import { resolveGithubSlug, getRepoForkInfo, syncForkRepo } from "../../gh"
import { listTasks } from "../../db/queries"
import { deletePoolForProject, localExec } from "../../tasks/worktree-pool"
import type { WorktreeSlotRow } from "../../db/types"
import { DAEMON_RESTART_EXIT_CODE } from "../../daemon-exit"

const log = createLogger("project-routes")

// Cache fork info to avoid hitting GitHub API on every 30s poll
const FORK_CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes
const forkInfoCache = new Map<string, { info: { isFork: boolean; parentSlug: string | null }; expiresAt: number }>()

async function getCachedForkInfo(slug: string, repoUrl?: string): Promise<{ isFork: boolean; parentSlug: string | null }> {
  const cached = forkInfoCache.get(slug)
  if (cached && Date.now() < cached.expiresAt) return cached.info
  try {
    const info = await getRepoForkInfo(slug, repoUrl)
    forkInfoCache.set(slug, { info, expiresAt: Date.now() + FORK_CACHE_TTL_MS })
    return info
  } catch {
    return { isFork: false, parentSlug: null }
  }
}

function shellExec(cmd: string, cwd: string) {
  return Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(["bash", "-c", cmd], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      if (exitCode !== 0) throw new Error(stderr.trim() || stdout.trim() || `exit ${exitCode}`)
      return stdout.trim()
    },
    catch: (e) => e instanceof Error ? e : new Error(String(e)),
  })
}

function buildProjectsResponse(deps: AppDeps) {
  const modelsByProvider: Record<string, string[]> = {}
  const contextWindowByModel: Record<string, number> = {}
  const providerMetadata: Record<string, {
    displayName: string
    abbreviation: string
    reasoningEfforts: { value: string; label: string; description: string }[]
  }> = {}

  for (const [key, factory] of Object.entries(deps.agentFactories)) {
    const models = factory.listModels()
    modelsByProvider[key] = models.map((m) => m.id)
    for (const m of models) {
      if (m.contextWindow) contextWindowByModel[m.id] = m.contextWindow
    }
    providerMetadata[key] = {
      displayName: factory.metadata.displayName,
      abbreviation: factory.metadata.abbreviation,
      reasoningEfforts: factory.metadata.reasoningEfforts,
    }
  }

  return {
    projects: deps.config.config.projects,
    model: deps.config.config.model,
    modelsByProvider,
    contextWindowByModel,
    providerMetadata,
    systemCapabilities: deps.systemCapabilities,
    sshHost: deps.config.config.sshHost,
    sshUser: deps.config.config.sshUser,
    editor: deps.config.config.editor,
    actionCombos: deps.config.config.actionCombos,
    shortcuts: deps.config.config.shortcuts,
  }
}

export function projectRoutes(deps: AppDeps): Hono {
  const app = new Hono()

  // List all configured projects + available models from providers
  app.get("/", (c) => {
    return c.json(buildProjectsResponse(deps))
  })

  // Get a single project by name
  app.get("/:name", (c) => {
    const name = c.req.param("name")
    const project = deps.config.config.projects.find((p) => p.name === name)
    if (!project) {
      return c.json({ error: "Project not found" }, 404)
    }
    return c.json(project)
  })

  // Register a new project
  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    return runEffect(c,
      Effect.gen(function* () {
        // Validate the project config shape
        const parsed = projectConfigSchema.safeParse(body)
        if (!parsed.success) {
          return yield* Effect.fail(new ConfigValidationError({ message: parsed.error.message }))
        }
        const project = parsed.data

        // Check for duplicate
        if (deps.config.config.projects.some((p) => p.name === project.name)) {
          return yield* Effect.fail(new ProjectExistsError({ name: project.name }))
        }

        // Read disk config, add project, validate full config, write back
        const raw = deps.configStore.read()
        if (!raw.projects) raw.projects = []
        raw.projects.push(project as unknown as Record<string, unknown>)

        const fullParsed = tangerineConfigSchema.safeParse(raw)
        if (!fullParsed.success) {
          return yield* Effect.fail(new ConfigValidationError({ message: fullParsed.error.message }))
        }

        deps.configStore.write(raw)
        deps.config.config = fullParsed.data

        return project
      }),
      { status: 201 }
    )
  })

  // Update an existing project (name is immutable)
  app.put("/:name", async (c) => {
    const name = c.req.param("name")
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    return runEffect(c,
      Effect.gen(function* () {
        const index = deps.config.config.projects.findIndex((p) => p.name === name)
        if (index === -1) {
          return yield* Effect.fail(new ProjectNotFoundError({ name }))
        }

        // Merge fields — name is immutable, taskTypes is deep-merged per task type
        const existing = deps.config.config.projects[index]!
        const merged = { ...existing, ...body, name }
        if (body.taskTypes && typeof body.taskTypes === "object") {
          const prev = (existing.taskTypes ?? {}) as Record<string, Record<string, unknown>>
          const next = body.taskTypes as Record<string, Record<string, unknown>>
          merged.taskTypes = { ...prev }
          for (const [tt, val] of Object.entries(next)) {
            const ttMerged = { ...prev[tt], ...val }
            // Null values signal deletion — remove them so Zod sees undefined
            for (const k of Object.keys(ttMerged)) {
              if (ttMerged[k] === null) delete ttMerged[k]
            }
            ;(merged.taskTypes as Record<string, unknown>)[tt] = ttMerged
          }
        }

        const parsed = projectConfigSchema.safeParse(merged)
        if (!parsed.success) {
          return yield* Effect.fail(new ConfigValidationError({ message: parsed.error.message }))
        }

        // Update disk config
        const raw = deps.configStore.read()
        const rawIndex = (raw.projects ?? []).findIndex((p) => p.name === name)
        if (rawIndex !== -1) {
          raw.projects![rawIndex] = merged as unknown as Record<string, unknown>
        }

        const fullParsed = tangerineConfigSchema.safeParse(raw)
        if (!fullParsed.success) {
          return yield* Effect.fail(new ConfigValidationError({ message: fullParsed.error.message }))
        }

        deps.configStore.write(raw)
        deps.config.config = fullParsed.data

        return parsed.data
      })
    )
  })

  // Remove a project
  app.delete("/:name", (c) => {
    const name = c.req.param("name")
    return runEffectVoid(c,
      Effect.gen(function* () {
        const index = deps.config.config.projects.findIndex((p) => p.name === name)
        if (index === -1) {
          return yield* Effect.fail(new ProjectNotFoundError({ name }))
        }

        if (deps.config.config.projects.length <= 1) {
          return yield* Effect.fail(new ConfigValidationError({ message: "Cannot remove the last project" }))
        }

        // Update disk config
        const raw = deps.configStore.read()
        raw.projects = (raw.projects ?? []).filter((p) => p.name !== name)

        const fullParsed = tangerineConfigSchema.safeParse(raw)
        if (!fullParsed.success) {
          return yield* Effect.fail(new ConfigValidationError({ message: fullParsed.error.message }))
        }

        deps.configStore.write(raw)
        deps.config.config = fullParsed.data
      })
    )
  })

  // Ensure an orchestrator task exists for a project (lazy create/reuse/recreate).
  // Returns the task without starting it — the UI triggers start explicitly.
  app.post("/:name/orchestrator", async (c) => {
    const name = c.req.param("name")
    const project = deps.config.config.projects.find((p) => p.name === name)
    if (!project) return c.json({ error: `Project not found: ${name}` }, 404)

    const body = await c.req.json().catch(() => ({})) as { provider?: string; model?: string; reasoningEffort?: string }
    return runEffect(c,
      deps.taskManager.ensureOrchestrator(name, body.provider, body.model, body.reasoningEffort).pipe(
        Effect.map(mapTaskRow),
      ),
      { status: 200 }
    )
  })

  // Check for updates on-demand (runs git fetch + compare)
  app.get("/:name/update-status", async (c) => {
    const name = c.req.param("name")
    const project = deps.config.config.projects.find((p) => p.name === name)
    if (!project) return c.json({ error: "Project not found" }, 404)

    const repoDir = getRepoDir(deps.config.config, name)
    const defaultBranch = project.defaultBranch ?? "main"
    const slug = resolveGithubSlug(project.repo)
    const [status, forkInfo] = await Promise.all([
      Effect.runPromise(checkForUpdate(repoDir, defaultBranch)),
      slug ? getCachedForkInfo(slug, project.repo) : Promise.resolve({ isFork: false, parentSlug: null }),
    ])

    return c.json({ ...status, ...forkInfo })
  })

  // Pull latest from remote and run postUpdateCommand
  app.post("/:name/update", async (c) => {
    const name = c.req.param("name")
    return runEffect(c,
      Effect.gen(function* () {
        const project = deps.config.config.projects.find((p) => p.name === name)
        if (!project) return yield* Effect.fail(new ProjectNotFoundError({ name }))

        const repoDir = getRepoDir(deps.config.config, name)
        const defaultBranch = project.defaultBranch ?? "main"
        const exec = (cmd: string) => shellExec(cmd, repoDir)

        // Get current HEAD before pull
        const from = yield* exec("git rev-parse --short HEAD").pipe(
          Effect.orElse(() => Effect.succeed("unknown"))
        )

        // If the repo is a fork, sync from upstream first
        const slug = resolveGithubSlug(project.repo)
        if (slug) {
          const forkInfo = yield* Effect.tryPromise({
            try: () => getRepoForkInfo(slug, project.repo),
            catch: () => new Error("Failed to check fork status"),
          }).pipe(Effect.catchAll(() => Effect.succeed({ isFork: false, parentSlug: null })))

          if (forkInfo.isFork) {
            log.info("Syncing fork from upstream before pull", { name, slug })
            yield* Effect.tryPromise({
              try: () => syncForkRepo(slug, project.repo),
              catch: (e) => e instanceof Error ? e : new Error(String(e)),
            }).pipe(Effect.catchAll((e) => {
              log.warn("Fork sync failed, continuing with normal pull", { name, error: e.message })
              return Effect.void
            }))
            // gh repo sync updated the GitHub fork — the subsequent fetch+reset will pull it locally
          }
        }

        // Fetch and reset to remote (source of truth)
        yield* exec("git fetch origin")
        yield* exec(`git reset --hard origin/${defaultBranch}`)

        // Get new HEAD
        const to = yield* exec("git rev-parse --short HEAD").pipe(
          Effect.orElse(() => Effect.succeed("unknown"))
        )

        const updated = from !== to
        clearUpdateStatus(repoDir)
        log.info("Project updated", { name, from, to, updated })

        // Run postUpdateCommand if configured
        let postUpdateOutput: string | undefined
        if (project.postUpdateCommand && updated) {
          log.info("Running postUpdateCommand", { name, command: project.postUpdateCommand })
          const output = yield* exec(project.postUpdateCommand).pipe(
            Effect.catchAll((e) => {
              log.error("postUpdateCommand failed", { name, error: e.message })
              return Effect.succeed(`ERROR: ${e.message}`)
            })
          )
          postUpdateOutput = output
        }

        // If server or shared code changed, schedule restart after response
        let restart = false
        if (updated) {
          const serverChanged = yield* exec(`git diff ${from}..${to} --name-only -- packages/server/ packages/shared/`).pipe(
            Effect.map((diff) => diff.length > 0),
            Effect.orElse(() => Effect.succeed(false))
          )
          if (serverChanged) {
            restart = true
            log.info("Server code changed, scheduling restart", { name })
            setTimeout(() => process.exit(DAEMON_RESTART_EXIT_CODE), 1000)
          }
        }

        return { updated, from, to, postUpdateOutput, restart }
      })
    )
  })

  // Check if a project repo is a fork and return fork info
  app.get("/:name/fork-status", async (c) => {
    const name = c.req.param("name")
    const project = deps.config.config.projects.find((p) => p.name === name)
    if (!project) return c.json({ error: "Project not found" }, 404)

    const slug = resolveGithubSlug(project.repo)
    if (!slug) return c.json({ isFork: false, parentSlug: null })

    try {
      const info = await getRepoForkInfo(slug, project.repo)
      return c.json(info)
    } catch {
      return c.json({ isFork: false, parentSlug: null })
    }
  })

  // Sync a forked repo from its upstream
  app.post("/:name/fork-sync", async (c) => {
    const name = c.req.param("name")
    return runEffect(c,
      Effect.gen(function* () {
        const project = deps.config.config.projects.find((p) => p.name === name)
        if (!project) return yield* Effect.fail(new ProjectNotFoundError({ name }))

        const slug = resolveGithubSlug(project.repo)
        if (!slug) return yield* Effect.fail(new Error("Could not extract GitHub slug from repo URL"))

        const forkInfo = yield* Effect.tryPromise({
          try: () => getRepoForkInfo(slug, project.repo),
          catch: (e) => e instanceof Error ? e : new Error(String(e)),
        })

        if (!forkInfo.isFork) {
          return yield* Effect.fail(new Error("Repository is not a fork"))
        }

        log.info("Syncing fork from upstream", { name, slug, upstream: forkInfo.parentSlug })

        yield* Effect.tryPromise({
          try: () => syncForkRepo(slug, project.repo),
          catch: (e) => e instanceof Error ? e : new Error(String(e)),
        })

        // gh repo sync updated the GitHub fork — now pull those changes into local
        const repoDir = getRepoDir(deps.config.config, name)
        const defaultBranch = project.defaultBranch ?? "main"

        const from = yield* shellExec("git rev-parse --short HEAD", repoDir).pipe(
          Effect.orElse(() => Effect.succeed("unknown"))
        )

        yield* shellExec("git fetch origin", repoDir)
        yield* shellExec(`git reset --hard origin/${defaultBranch}`, repoDir)

        const to = yield* shellExec("git rev-parse --short HEAD", repoDir).pipe(
          Effect.orElse(() => Effect.succeed("unknown"))
        )

        const updated = from !== to

        // Run postUpdateCommand if configured and something changed
        let postUpdateOutput: string | undefined
        if (project.postUpdateCommand && updated) {
          log.info("Running postUpdateCommand", { name, command: project.postUpdateCommand })
          const output = yield* shellExec(project.postUpdateCommand, repoDir).pipe(
            Effect.catchAll((e) => {
              log.error("postUpdateCommand failed", { name, error: e.message })
              return Effect.succeed(`ERROR: ${e.message}`)
            })
          )
          postUpdateOutput = output
        }

        // If server or shared code changed, schedule restart after response
        let restart = false
        if (updated) {
          const serverChanged = yield* shellExec(`git diff ${from}..${to} --name-only -- packages/server/ packages/shared/`, repoDir).pipe(
            Effect.map((diff) => diff.length > 0),
            Effect.orElse(() => Effect.succeed(false))
          )
          if (serverChanged) {
            restart = true
            log.info("Server code changed, scheduling restart", { name })
            setTimeout(() => process.exit(DAEMON_RESTART_EXIT_CODE), 1000)
          }
        }

        log.info("Fork synced successfully", { name, slug, from, to, updated })
        return { synced: true, upstream: forkInfo.parentSlug, updated, from, to, postUpdateOutput, restart }
      })
    )
  })

  // Archive a project: set archived flag, cancel running tasks, remove worktrees
  app.post("/:name/archive", (c) => {
    const name = c.req.param("name")
    return runEffectVoid(c,
      Effect.gen(function* () {
        const index = deps.config.config.projects.findIndex((p) => p.name === name)
        if (index === -1) {
          return yield* Effect.fail(new ProjectNotFoundError({ name }))
        }

        const project = deps.config.config.projects[index]!
        if (project.archived) {
          return // already archived
        }

        // 1. Mark archived in memory immediately to block new task creation
        project.archived = true

        // 2. Cancel running tasks for this project
        const tasks = yield* listTasks(deps.db, { projectId: name })
        for (const task of tasks) {
          if (!TERMINAL_STATUSES.has(task.status)) {
            yield* deps.taskManager.cancelTask(task.id).pipe(Effect.catchAll(() => Effect.void))
          }
        }

        // 3. Remove worktrees (physical directories + DB slots)
        const repoDir = getRepoDir(deps.config.config, name)
        const slots = deps.db.prepare(
          "SELECT * FROM worktree_slots WHERE project_id = ? AND id NOT LIKE '%slot-0'"
        ).all(name) as WorktreeSlotRow[]

        for (const slot of slots) {
          yield* localExec(`cd "${repoDir}" && git worktree remove --force "${slot.path}" 2>/dev/null; true`).pipe(
            Effect.catchAll(() => Effect.void)
          )
        }
        yield* localExec(`cd "${repoDir}" && git worktree prune 2>/dev/null; true`).pipe(
          Effect.catchAll(() => Effect.void)
        )
        yield* deletePoolForProject(deps.db, name).pipe(Effect.ignoreLogged)

        // 4. Write config to disk LAST — this triggers a watcher restart, so all
        //    side effects (task cancellation, worktree removal) must be done first.
        const raw = deps.configStore.read()
        const rawIndex = (raw.projects ?? []).findIndex((p) => p.name === name)
        if (rawIndex !== -1) {
          raw.projects![rawIndex]!.archived = true
        }
        const fullParsed = tangerineConfigSchema.safeParse(raw)
        if (!fullParsed.success) {
          return yield* Effect.fail(new ConfigValidationError({ message: fullParsed.error.message }))
        }
        deps.configStore.write(raw)
        deps.config.config = fullParsed.data

        log.info("Project archived", { name })
      })
    )
  })

  // Unarchive a project
  app.post("/:name/unarchive", (c) => {
    const name = c.req.param("name")
    return runEffectVoid(c,
      Effect.gen(function* () {
        const index = deps.config.config.projects.findIndex((p) => p.name === name)
        if (index === -1) {
          return yield* Effect.fail(new ProjectNotFoundError({ name }))
        }

        const project = deps.config.config.projects[index]!
        if (!project.archived) {
          return // already unarchived
        }

        const raw = deps.configStore.read()
        const rawIndex = (raw.projects ?? []).findIndex((p) => p.name === name)
        if (rawIndex !== -1) {
          raw.projects![rawIndex]!.archived = false
        }
        const fullParsed = tangerineConfigSchema.safeParse(raw)
        if (!fullParsed.success) {
          return yield* Effect.fail(new ConfigValidationError({ message: fullParsed.error.message }))
        }
        deps.configStore.write(raw)
        deps.config.config = fullParsed.data

        log.info("Project unarchived", { name })
      })
    )
  })

  return app
}
