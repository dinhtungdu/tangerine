import { describe, test, expect, beforeEach } from "bun:test"
import { Effect } from "effect"
import type { Database } from "bun:sqlite"
import { createTestDb } from "./helpers"
import { ORCHESTRATOR_TASK_NAME } from "@tangerine/shared"
import { ensureOrchestrator, startTask, createTask, type TaskManagerDeps } from "../tasks/manager"
import * as dbQueries from "../db/queries"
import { createAgentFactories } from "../agent/factories"

const PROJECT_ID = "test-project"
const factories = createAgentFactories()

function makeDeps(db: Database): TaskManagerDeps {
  // Track whether startSessionWithRetry was called
  let sessionStarted = false

  const deps: TaskManagerDeps = {
    insertTask: (task) => dbQueries.createTask(db, task),
    updateTask: (id, updates) => dbQueries.updateTask(db, id, updates),
    getTask: (id) => dbQueries.getTask(db, id).pipe(Effect.mapError((e) => e as unknown as Error)),
    listTasks: (filter) => dbQueries.listTasks(db, filter ?? {}).pipe(Effect.mapError((e) => e as unknown as Error)),
    logActivity: () => Effect.succeed(undefined),
    lifecycleDeps: {} as TaskManagerDeps["lifecycleDeps"],
    cleanupDeps: {} as TaskManagerDeps["cleanupDeps"],
    retryDeps: {} as TaskManagerDeps["retryDeps"],
    getProjectConfig: (id) => id === PROJECT_ID
      ? { repo: "https://github.com/test/repo", setup: "echo ok", defaultBranch: "main", defaultAgent: "acp" }
      : undefined,
    getAgentFactory: (provider) => factories[provider as keyof typeof factories],
    abortAgent: () => Effect.void,
    get _sessionStarted() { return sessionStarted },
    set _sessionStarted(v: boolean) { sessionStarted = v },
  } as TaskManagerDeps & { _sessionStarted: boolean }

  return deps
}

describe("ensureOrchestrator", () => {
  let db: Database
  let deps: TaskManagerDeps

  beforeEach(() => {
    db = createTestDb()
    deps = makeDeps(db)
  })

  test("creates orchestrator when none exists", async () => {
    const task = await Effect.runPromise(ensureOrchestrator(deps, PROJECT_ID))
    expect(task.title).toBe(ORCHESTRATOR_TASK_NAME)
    expect(task.type).toBe("orchestrator")
    expect(task.status).toBe("created")
    expect(task.project_id).toBe(PROJECT_ID)
    expect(task.parent_task_id).toBeNull()
  })

  test("returns existing active orchestrator", async () => {
    const first = await Effect.runPromise(ensureOrchestrator(deps, PROJECT_ID))
    const second = await Effect.runPromise(ensureOrchestrator(deps, PROJECT_ID))
    expect(second.id).toBe(first.id)
  })

  test("creates new orchestrator linked to terminal one", async () => {
    const first = await Effect.runPromise(ensureOrchestrator(deps, PROJECT_ID))

    // Mark it as done
    await Effect.runPromise(dbQueries.updateTask(db, first.id, {
      status: "done",
      completed_at: new Date().toISOString(),
    }))

    const second = await Effect.runPromise(ensureOrchestrator(deps, PROJECT_ID))
    expect(second.id).not.toBe(first.id)
    expect(second.parent_task_id).toBe(first.id)
    expect(second.title).toBe(ORCHESTRATOR_TASK_NAME)
    expect(second.type).toBe("orchestrator")
  })

  test("links to most recent terminal orchestrator", async () => {
    // Create two orchestrators and mark them terminal
    const first = await Effect.runPromise(ensureOrchestrator(deps, PROJECT_ID))
    await Effect.runPromise(dbQueries.updateTask(db, first.id, {
      status: "failed",
      completed_at: new Date().toISOString(),
    }))

    const second = await Effect.runPromise(ensureOrchestrator(deps, PROJECT_ID))
    await Effect.runPromise(dbQueries.updateTask(db, second.id, {
      status: "done",
      completed_at: new Date().toISOString(),
    }))

    const third = await Effect.runPromise(ensureOrchestrator(deps, PROJECT_ID))
    // Should link to second (most recent terminal), not first
    expect(third.parent_task_id).toBe(second.id)
  })

  test("orchestrator is created in 'created' status (no auto-start)", async () => {
    const task = await Effect.runPromise(ensureOrchestrator(deps, PROJECT_ID))
    expect(task.status).toBe("created")
  })

  test("uses project defaultAgent when no provider specified", async () => {
    const task = await Effect.runPromise(ensureOrchestrator(deps, PROJECT_ID))
    expect(task.provider).toBe("acp")
  })

  test("uses orchestrator agent from taskTypes when no provider specified", async () => {
    deps.getProjectConfig = (id) => id === PROJECT_ID
      ? {
          repo: "https://github.com/test/repo",
          setup: "echo ok",
          defaultBranch: "main",
          defaultAgent: "acp",
          taskTypes: { orchestrator: { agent: "codex" } },
        }
      : undefined

    const task = await Effect.runPromise(ensureOrchestrator(deps, PROJECT_ID))
    expect(task.provider).toBe("codex")
  })

  test("explicit agent id overrides orchestrator taskTypes agent", async () => {
    deps.getProjectConfig = (id) => id === PROJECT_ID
      ? {
          repo: "https://github.com/test/repo",
          setup: "echo ok",
          defaultBranch: "main",
          defaultAgent: "acp",
          taskTypes: { orchestrator: { agent: "codex" } },
        }
      : undefined

    const task = await Effect.runPromise(ensureOrchestrator(deps, PROJECT_ID, "custom-agent"))
    expect(task.provider).toBe("custom-agent")
  })

  test("explicit agent id overrides project default", async () => {
    const task = await Effect.runPromise(ensureOrchestrator(deps, PROJECT_ID, "custom-agent"))
    expect(task.provider).toBe("custom-agent")
  })

  test("ACP agents do not inject provider-specific default model or reasoning effort", async () => {
    const task = await Effect.runPromise(ensureOrchestrator(deps, PROJECT_ID))
    expect(task.model).toBeNull()
    expect(task.reasoning_effort).toBeNull()
  })

  test("uses orchestrator model and reasoning effort from taskTypes", async () => {
    deps.getProjectConfig = (id) => id === PROJECT_ID
      ? {
          repo: "https://github.com/test/repo",
          setup: "echo ok",
          defaultBranch: "main",
          defaultAgent: "acp",
          taskTypes: { orchestrator: { model: "gpt-5", reasoningEffort: "high" } },
        }
      : undefined

    const task = await Effect.runPromise(ensureOrchestrator(deps, PROJECT_ID))
    expect(task.model).toBe("gpt-5")
    expect(task.reasoning_effort).toBe("high")
  })

  test("explicit model and reasoningEffort override taskTypes defaults", async () => {
    deps.getProjectConfig = (id) => id === PROJECT_ID
      ? {
          repo: "https://github.com/test/repo",
          setup: "echo ok",
          defaultBranch: "main",
          defaultAgent: "acp",
          taskTypes: { orchestrator: { model: "gpt-5", reasoningEffort: "low" } },
        }
      : undefined

    const task = await Effect.runPromise(ensureOrchestrator(deps, PROJECT_ID, undefined, "gpt-5-large", "medium"))
    expect(task.model).toBe("gpt-5-large")
    expect(task.reasoning_effort).toBe("medium")
  })
})

describe("createTask description storage", () => {
  let db: Database
  let deps: TaskManagerDeps

  beforeEach(() => {
    db = createTestDb()
    deps = makeDeps(db)
  })

  test("stores description exactly as provided — no system instructions mixed in", async () => {
    await Effect.runPromise(ensureOrchestrator(deps, PROJECT_ID))

    const task = await Effect.runPromise(createTask(deps, {
      source: "manual",
      projectId: PROJECT_ID,
      title: "Fix a bug",
      description: "Do the thing",
    }))

    // Description must be stored verbatim — escalation block lives in the agent
    // prompt (injected by cli/start.ts) not in the DB so the UI stays clean.
    expect(task.description).toBe("Do the thing")
  })

  test("uses project defaultAgent over legacy defaultProvider", async () => {
    deps.getProjectConfig = (id) => id === PROJECT_ID
      ? { repo: "https://github.com/test/repo", setup: "echo ok", defaultBranch: "main", defaultAgent: "codex" }
      : undefined

    const task = await Effect.runPromise(createTask(deps, {
      source: "manual",
      projectId: PROJECT_ID,
      title: "Fix a bug",
    }))

    expect(task.provider).toBe("codex")
  })

  test("stores null description when none provided", async () => {
    await Effect.runPromise(ensureOrchestrator(deps, PROJECT_ID))

    const task = await Effect.runPromise(createTask(deps, {
      source: "manual",
      projectId: PROJECT_ID,
      title: "Fix a bug",
    }))

    expect(task.description).toBeNull()
  })

  test("orchestrator description is stored verbatim", async () => {
    const orchestrator = await Effect.runPromise(ensureOrchestrator(deps, PROJECT_ID))
    expect(orchestrator.description).not.toContain("Out-of-scope issues")
  })

  test("default orchestrator prompt uses provider-neutral model guidance", async () => {
    const orchestrator = await Effect.runPromise(ensureOrchestrator(deps, PROJECT_ID))
    expect(orchestrator.description?.toLowerCase()).not.toMatch(/claude|anthropic|opus|sonnet/)
    expect(orchestrator.description).toContain("most capable configured model")
  })
})

describe("startTask", () => {
  let db: Database
  let deps: TaskManagerDeps

  beforeEach(() => {
    db = createTestDb()
    deps = makeDeps(db)
  })

  test("no-ops for non-existent task", async () => {
    const result = Effect.runPromise(startTask(deps, "nonexistent"))
    await expect(result).rejects.toThrow()
  })

  test("no-ops for already running task", async () => {
    const task = await Effect.runPromise(createTask(deps, {
      source: "manual",
      projectId: PROJECT_ID,
      title: "test",
    }))
    await Effect.runPromise(dbQueries.updateTask(db, task.id, { status: "running" }))

    // Should not throw
    await Effect.runPromise(startTask(deps, task.id))
  })

  test("no-ops for terminal task", async () => {
    const task = await Effect.runPromise(createTask(deps, {
      source: "manual",
      projectId: PROJECT_ID,
      title: "test",
    }))
    await Effect.runPromise(dbQueries.updateTask(db, task.id, { status: "done" }))

    // Should not throw
    await Effect.runPromise(startTask(deps, task.id))
  })

  test("transitions created → provisioning atomically", async () => {
    const task = await Effect.runPromise(ensureOrchestrator(deps, PROJECT_ID))
    expect(task.status).toBe("created")

    await Effect.runPromise(startTask(deps, task.id))

    // Task should now be provisioning (startSessionWithRetry forked in background)
    const updated = await Effect.runPromise(dbQueries.getTask(db, task.id))
    expect(updated!.status).toBe("provisioning")
  })
})
