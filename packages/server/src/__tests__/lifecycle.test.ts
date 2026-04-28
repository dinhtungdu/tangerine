import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { createTestDb } from "./helpers"
import { cleanGitEnv } from "../git-env"
import { startSession, type LifecycleDeps } from "../tasks/lifecycle"
import * as dbQueries from "../db/queries"
import type { TaskRow } from "../db/types"
import type { AgentFactory, AgentHandle } from "../agent/provider"
import type { TangerineConfig } from "@tangerine/shared"

function git(args: string[], cwd?: string): string {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    env: cleanGitEnv(),
    stdout: "pipe",
    stderr: "pipe",
  })
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`)
  }
  return proc.stdout.toString().trim()
}

function makeTaskRow(overrides?: Partial<TaskRow>): TaskRow {
  const now = new Date().toISOString()
  return {
    id: "review-task-12345678",
    project_id: "test-project",
    source: "manual",
    source_id: null,
    source_url: null,
    title: "Review task",
    type: "reviewer",
    description: null,
    status: "created",
    provider: "acp",
    model: null,
    reasoning_effort: null,
    branch: "feature/review",
    worktree_path: null,
    pr_url: null,
    pr_status: null,
    parent_task_id: null,
    user_id: null,
    agent_session_id: null,
    agent_pid: null,
    suspended: 0,
    error: null,
    created_at: now,
    updated_at: now,
    started_at: null,
    completed_at: null,
    last_seen_at: null,
    last_result_at: null,
    capabilities: null,
    context_tokens: 0,
    context_window_max: null,
    ...overrides,
  }
}

function makeAgentFactory(): AgentFactory {
  const handle: AgentHandle = {
    sendPrompt: () => Effect.void,
    abort: () => Effect.void,
    subscribe: () => ({ unsubscribe() {} }),
    shutdown: () => Effect.void,
  }
  return {
    metadata: { displayName: "Test", abbreviation: "T", cliCommand: "test-agent" },
    start: () => Effect.succeed(handle),
  }
}

function createRepoFixture(root: string): { origin: string; workspace: string; repoDir: string } {
  const origin = join(root, "origin.git")
  const seed = join(root, "seed")
  const workspace = join(root, "workspace")
  const projectDir = join(workspace, "test-project")
  const repoDir = join(projectDir, "0")

  git(["init", "--bare", origin])
  git(["init", "-b", "main", seed])
  writeFileSync(join(seed, "README.md"), "main\n")
  git(["add", "README.md"], seed)
  git(["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "init"], seed)
  git(["remote", "add", "origin", origin], seed)
  git(["push", "-u", "origin", "main"], seed)
  git(["-C", origin, "symbolic-ref", "HEAD", "refs/heads/main"])

  git(["checkout", "-b", "feature/review"], seed)
  writeFileSync(join(seed, "feature.txt"), "feature\n")
  git(["add", "feature.txt"], seed)
  git(["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "feature"], seed)
  git(["push", "-u", "origin", "feature/review"], seed)

  mkdirSync(projectDir, { recursive: true })
  git(["clone", "--branch", "main", origin, repoDir])
  return { origin, workspace, repoDir }
}

describe("startSession", () => {
  test("checks out reviewer worktrees on a local branch when a worker uses the PR branch", async () => {
    const root = mkdtempSync(join(tmpdir(), "tangerine-lifecycle-"))
    const previousGitDir = process.env["GIT_DIR"]
    const previousGitWorkTree = process.env["GIT_WORK_TREE"]
    try {
      const { origin, workspace, repoDir } = createRepoFixture(root)
      const workerPath = join(workspace, "test-project", "worker")
      git(["worktree", "add", "-b", "feature/review", workerPath, "origin/feature/review"], repoDir)
      writeFileSync(join(workerPath, "local.txt"), "worker local\n")
      git(["add", "local.txt"], workerPath)
      git(["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "worker local"], workerPath)
      const workerHeadBefore = git(["rev-parse", "HEAD"], workerPath)
      const trap = join(root, "trap")
      git(["init", trap])
      // Git hooks export repo-scoped env vars; lifecycle must ignore them for task repos.
      process.env["GIT_DIR"] = join(trap, ".git")
      process.env["GIT_WORK_TREE"] = trap

      const db = createTestDb()
      const task = makeTaskRow()
      Effect.runSync(dbQueries.createTask(db, task))
      const tangerineConfig: TangerineConfig = {
        workspace,
        projects: [{
          name: "test-project",
          repo: origin,
          defaultBranch: "main",
          setup: "true",
          prMode: "none",
          archived: false,
        }],
        agents: [],
        models: [],
        actionCombos: [],
        checkpointTokenBudgetFraction: 0.5,
        checkpointTtlHours: 24,
      }
      const deps: LifecycleDeps = {
        db,
        tangerineConfig,
        agentFactory: makeAgentFactory(),
        getTask: () => Effect.succeed({ status: "running", branch: task.branch }),
        updateTask: (_taskId, updates) => Effect.sync(() => {
          Object.assign(task, updates)
        }),
        logActivity: () => Effect.void,
      }

      const session = await Effect.runPromise(startSession(task, {
        repo: origin,
        defaultBranch: "main",
        setup: "true",
        poolSize: 1,
        prMode: "none",
      }, deps))

      expect(git(["branch", "--show-current"], session.worktreePath)).toBe("tangerine/reviewer/review-t")
      expect(git(["rev-parse", "feature/review"], repoDir)).toBe(workerHeadBefore)
      expect(git(["rev-parse", "HEAD"], workerPath)).toBe(workerHeadBefore)
      expect(task.branch).toBe("feature/review")
    } finally {
      if (previousGitDir === undefined) delete process.env["GIT_DIR"]
      else process.env["GIT_DIR"] = previousGitDir
      if (previousGitWorkTree === undefined) delete process.env["GIT_WORK_TREE"]
      else process.env["GIT_WORK_TREE"] = previousGitWorkTree
      rmSync(root, { recursive: true, force: true })
    }
  })
})
