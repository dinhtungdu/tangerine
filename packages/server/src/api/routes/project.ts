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
import { listTasks } from "../../db/queries"
import { deletePoolForProject, localExec } from "../../tasks/worktree-pool"
import type { WorktreeSlotRow } from "../../db/types"
import type { ProviderType } from "../../agent/provider"

const log = createLogger("project-routes")

function buildProjectsResponse(deps: AppDeps) {
  const modelsByProvider: Record<string, string[]> = {
    opencode: deps.agentFactories.opencode.listModels().map((m) => m.id),
    "claude-code": deps.agentFactories["claude-code"].listModels().map((m) => m.id),
    codex: deps.agentFactories.codex.listModels().map((m) => m.id),
    pi: deps.agentFactories.pi.listModels().map((m) => m.id),
  }
  const models = Array.from(new Set(Object.values(modelsByProvider).flat()))
  const fallbackModels = deps.config.config.models

  return {
    projects: deps.config.config.projects,
    model: deps.config.config.model,
    models: models.length > 0 ? models : fallbackModels,
    modelsByProvider,
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

  app.post("/models/:provider/refresh", (c) => {
    const provider = c.req.param("provider") as ProviderType
    if (!(provider in deps.agentFactories)) {
      return c.json({ error: "Invalid provider" }, 400)
    }
    deps.agentFactories[provider].listModels({ forceRefresh: true })
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

        // Merge fields — name is immutable
        const existing = deps.config.config.projects[index]!
        const merged = { ...existing, ...body, name }

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
    const status = await Effect.runPromise(checkForUpdate(repoDir, defaultBranch))

    return c.json(status)
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

        const exec = (cmd: string) => Effect.tryPromise({
          try: async () => {
            const proc = Bun.spawn(["bash", "-c", cmd], {
              cwd: repoDir,
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

        // Get current HEAD before pull
        const from = yield* exec("git rev-parse --short HEAD").pipe(
          Effect.orElse(() => Effect.succeed("unknown"))
        )

        // Reset local changes and pull (remote is source of truth)
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
            setTimeout(() => process.exit(0), 1000)
          }
        }

        return { updated, from, to, postUpdateOutput, restart }
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

        // 1. Update config
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
