import { Effect } from "effect"
import { Hono } from "hono"
import type { AppDeps } from "../app"
import { mapTaskRow } from "../helpers"
import { runEffect, runEffectVoid } from "../effect-helpers"
import { discoverModels, discoverModelsByProvider } from "../../models"
import { projectConfigSchema, tangerineConfigSchema } from "@tangerine/shared"
import { ProjectNotFoundError, ProjectExistsError, ConfigValidationError } from "../../errors"
import { checkForUpdate, clearUpdateStatus } from "../../self-update"
import { getRepoDir } from "../../config"
import { createLogger } from "../../logger"

const log = createLogger("project-routes")

export function projectRoutes(deps: AppDeps): Hono {
  const app = new Hono()

  // List all configured projects + available models from OpenCode
  app.get("/", (c) => {
    const discovered = discoverModels()
    const configModels = deps.config.config.models
    // Use discovered models if available, fall back to config
    const models = discovered.length > 0
      ? discovered.map((m) => m.id)
      : configModels

    // Per-harness model lists
    const byProvider = discoverModelsByProvider()
    const modelsByProvider: Record<string, string[]> = {
      opencode: byProvider.opencode.map((m) => m.id),
      "claude-code": byProvider["claude-code"].map((m) => m.id),
      codex: byProvider.codex.map((m) => m.id),
      pi: byProvider.pi.map((m) => m.id),
    }

    return c.json({
      projects: deps.config.config.projects,
      model: deps.config.config.model,
      models,
      modelsByProvider,
      sshHost: deps.config.config.sshHost,
      sshUser: deps.config.config.sshUser,
      editor: deps.config.config.editor,
      actionCombos: deps.config.config.actionCombos,
    })
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

  return app
}
