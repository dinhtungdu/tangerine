import { describe, test, expect, beforeEach } from "bun:test"
import { Effect } from "effect"
import type { Database } from "bun:sqlite"
import { createTestDb } from "./helpers"
import { extractPrUrl, extractGithubSlug, pollPrStatuses } from "../tasks/pr-monitor"
import type { PrMonitorDeps, PrState } from "../tasks/pr-monitor"
import type { TaskRow } from "../db/types"
import { buildSystemNotes } from "../tasks/prompts"

// ---------------------------------------------------------------------------
// extractPrUrl
// ---------------------------------------------------------------------------

describe("extractPrUrl", () => {
  test("extracts PR URL from simple text", () => {
    expect(extractPrUrl("https://github.com/owner/repo/pull/42")).toBe(
      "https://github.com/owner/repo/pull/42",
    )
  })

  test("extracts PR URL from surrounding text", () => {
    const text = "Created PR: https://github.com/acme/widgets/pull/123 — please review"
    expect(extractPrUrl(text)).toBe("https://github.com/acme/widgets/pull/123")
  })

  test("extracts PR URL from gh pr create output", () => {
    const output = "https://github.com/dinhtungdu/tangerine/pull/4\n"
    expect(extractPrUrl(output)).toBe("https://github.com/dinhtungdu/tangerine/pull/4")
  })

  test("handles repos with dots and hyphens", () => {
    expect(extractPrUrl("https://github.com/my-org/my.repo-name/pull/7")).toBe(
      "https://github.com/my-org/my.repo-name/pull/7",
    )
  })

  test("returns null when no PR URL present", () => {
    expect(extractPrUrl("No PR here")).toBeNull()
    expect(extractPrUrl("")).toBeNull()
    expect(extractPrUrl("https://github.com/owner/repo/issues/5")).toBeNull()
  })

  test("returns first PR URL when multiple present", () => {
    const text = "See https://github.com/a/b/pull/1 and https://github.com/c/d/pull/2"
    expect(extractPrUrl(text)).toBe("https://github.com/a/b/pull/1")
  })

  test("does not match non-github URLs", () => {
    expect(extractPrUrl("https://gitlab.com/owner/repo/pull/1")).toBeNull()
  })

  test("extracts PR URL from GitHub Enterprise host", () => {
    expect(extractPrUrl("https://github.a8c.com/owner/repo/pull/99")).toBe(
      "https://github.a8c.com/owner/repo/pull/99",
    )
  })

  test("extracts PR URL from GHE host in surrounding text", () => {
    const text = "Created PR: https://github.a8c.com/acme/widgets/pull/42 — please review"
    expect(extractPrUrl(text)).toBe("https://github.a8c.com/acme/widgets/pull/42")
  })
})

// ---------------------------------------------------------------------------
// extractGithubSlug
// ---------------------------------------------------------------------------

describe("extractGithubSlug", () => {
  test("extracts slug from https URL", () => {
    expect(extractGithubSlug("https://github.com/owner/repo")).toBe("owner/repo")
  })

  test("strips .git suffix", () => {
    expect(extractGithubSlug("https://github.com/owner/repo.git")).toBe("owner/repo")
  })

  test("handles SSH remote URL", () => {
    expect(extractGithubSlug("git@github.com:owner/repo.git")).toBe("owner/repo")
  })

  test("returns null for non-github URLs", () => {
    expect(extractGithubSlug("https://gitlab.com/owner/repo")).toBeNull()
  })

  test("extracts slug from GHE https URL", () => {
    expect(extractGithubSlug("https://github.a8c.com/owner/repo")).toBe("owner/repo")
  })

  test("extracts slug from GHE https URL with .git suffix", () => {
    expect(extractGithubSlug("https://github.a8c.com/owner/repo.git")).toBe("owner/repo")
  })

  test("handles GHE SSH remote URL", () => {
    expect(extractGithubSlug("git@github.a8c.com:owner/repo.git")).toBe("owner/repo")
  })
})

// ---------------------------------------------------------------------------
// pollPrStatuses
// ---------------------------------------------------------------------------

function makeTaskRow(overrides?: Partial<TaskRow>): TaskRow {
  const now = new Date().toISOString()
  return {
    id: crypto.randomUUID(),
    project_id: "test",
    source: "manual",
    source_id: null,
    source_url: null,
    repo_url: "https://github.com/test/repo",
    title: "Test task",
    type: "worker",
    description: null,
    status: "running",
    provider: "opencode",
    model: null,
    reasoning_effort: null,
    branch: "tangerine/abc123",
    worktree_path: "/workspace/worktrees/test-slot-0",
    pr_url: null,
    parent_task_id: null,
    user_id: null,
    agent_session_id: null,
    agent_pid: null,
    error: null,
    created_at: now,
    updated_at: now,
    started_at: now,
    completed_at: null,
    last_seen_at: null,
    last_result_at: null,
    capabilities: null,
    ...overrides,
  }
}

describe("pollPrStatuses", () => {
  let db: Database

  function makeDeps(
    tasks: TaskRow[],
    prStates: Record<string, PrState | null>,
    branchPrs: Record<string, string | null> = {},
  ): PrMonitorDeps & { updates: Array<{ taskId: string; updates: Partial<TaskRow> }>; activities: Array<{ taskId: string; event: string; content: string }> } {
    const updates: Array<{ taskId: string; updates: Partial<TaskRow> }> = []
    const activities: Array<{ taskId: string; event: string; content: string }> = []
    return {
      updates,
      activities,
      db,
      listTasks: () => Effect.succeed(tasks),
      updateTask: (taskId, u) => {
        updates.push({ taskId, updates: u as Partial<TaskRow> })
        return Effect.succeed(null)
      },
      logActivity: (taskId, _type, event, content) => {
        activities.push({ taskId, event, content })
        return Effect.succeed(null)
      },
      cleanupDeps: {
        db,
        getTask: () => Effect.succeed(null),
        updateTask: () => Effect.succeed(null),
        getAgentHandle: () => null,
      },
      checkPrState: (url) => Effect.succeed(prStates[url] ?? null),
      lookupPrByBranch: (_repoUrl, branch) => Effect.succeed(branchPrs[branch] ?? null),
    }
  }

  beforeEach(() => {
    db = createTestDb()
  })

  test("does nothing when no running tasks have pr_url", async () => {
    const task = makeTaskRow({ pr_url: null })
    const deps = makeDeps([task], {})

    await Effect.runPromise(pollPrStatuses(deps))

    expect(deps.updates).toHaveLength(0)
    expect(deps.activities).toHaveLength(0)
  })

  test("does nothing for open PRs", async () => {
    const prUrl = "https://github.com/test/repo/pull/1"
    const task = makeTaskRow({ pr_url: prUrl })
    const deps = makeDeps([task], { [prUrl]: "open" })

    await Effect.runPromise(pollPrStatuses(deps))

    expect(deps.updates).toHaveLength(0)
  })

  test("completes task when PR is merged", async () => {
    const prUrl = "https://github.com/test/repo/pull/1"
    const task = makeTaskRow({ pr_url: prUrl })
    const deps = makeDeps([task], { [prUrl]: "merged" })

    await Effect.runPromise(pollPrStatuses(deps))

    expect(deps.updates).toHaveLength(1)
    expect(deps.updates[0]!.taskId).toBe(task.id)
    expect(deps.updates[0]!.updates.status).toBe("done")
    expect(deps.updates[0]!.updates.completed_at).toBeDefined()

    expect(deps.activities).toHaveLength(1)
    expect(deps.activities[0]!.event).toBe("task.completed")
    expect(deps.activities[0]!.content).toContain("PR merged")
  })

  test("cancels task when PR is closed without merge", async () => {
    const prUrl = "https://github.com/test/repo/pull/2"
    const task = makeTaskRow({ pr_url: prUrl })
    const deps = makeDeps([task], { [prUrl]: "closed" })

    await Effect.runPromise(pollPrStatuses(deps))

    expect(deps.updates).toHaveLength(1)
    expect(deps.updates[0]!.taskId).toBe(task.id)
    expect(deps.updates[0]!.updates.status).toBe("cancelled")
    expect(deps.updates[0]!.updates.completed_at).toBeDefined()

    expect(deps.activities).toHaveLength(1)
    expect(deps.activities[0]!.event).toBe("task.cancelled")
    expect(deps.activities[0]!.content).toContain("closed without merge")
  })

  test("handles multiple tasks with different PR states", async () => {
    const pr1 = "https://github.com/test/repo/pull/10"
    const pr2 = "https://github.com/test/repo/pull/11"
    const pr3 = "https://github.com/test/repo/pull/12"
    const tasks = [
      makeTaskRow({ pr_url: pr1 }),
      makeTaskRow({ pr_url: pr2 }),
      makeTaskRow({ pr_url: pr3 }),
    ]
    const deps = makeDeps(tasks, {
      [pr1]: "merged",
      [pr2]: "open",
      [pr3]: "closed",
    })

    await Effect.runPromise(pollPrStatuses(deps))

    // merged + closed = 2 updates; open = no update
    expect(deps.updates).toHaveLength(2)
    expect(deps.updates[0]!.updates.status).toBe("done")
    expect(deps.updates[1]!.updates.status).toBe("cancelled")
  })

  test("skips tasks when checkPrState returns null", async () => {
    const prUrl = "https://github.com/test/repo/pull/99"
    const task = makeTaskRow({ pr_url: prUrl })
    const deps = makeDeps([task], { [prUrl]: null })

    await Effect.runPromise(pollPrStatuses(deps))

    expect(deps.updates).toHaveLength(0)
  })

  test("discovers pr_url from branch when task has none", async () => {
    const prUrl = "https://github.com/test/repo/pull/5"
    const task = makeTaskRow({ pr_url: null, branch: "tangerine/abc123" })
    const deps = makeDeps([task], { [prUrl]: "open" }, { "tangerine/abc123": prUrl })

    await Effect.runPromise(pollPrStatuses(deps))

    const prUpdate = deps.updates.find((u) => u.updates.pr_url)
    expect(prUpdate).toBeDefined()
    expect(prUpdate!.updates.pr_url).toBe(prUrl)
    expect(deps.activities.some((a) => a.event === "pr.discovered")).toBe(true)
  })

  test("discovered PR is acted on in the same cycle when merged", async () => {
    const prUrl = "https://github.com/test/repo/pull/6"
    const task = makeTaskRow({ pr_url: null, branch: "tangerine/abc123" })
    const deps = makeDeps([task], { [prUrl]: "merged" }, { "tangerine/abc123": prUrl })

    await Effect.runPromise(pollPrStatuses(deps))

    const statusUpdate = deps.updates.find((u) => u.updates.status)
    expect(statusUpdate?.updates.status).toBe("done")
  })

  test("does not look up branch PR when task already has pr_url", async () => {
    const prUrl = "https://github.com/test/repo/pull/7"
    const task = makeTaskRow({ pr_url: prUrl, branch: "tangerine/abc123" })
    let lookupCalled = false
    const deps = makeDeps([task], { [prUrl]: "open" })
    deps.lookupPrByBranch = (_r, _b) => { lookupCalled = true; return Effect.succeed(null) }

    await Effect.runPromise(pollPrStatuses(deps))

    expect(lookupCalled).toBe(false)
  })

  test("does nothing when branch lookup returns null", async () => {
    const task = makeTaskRow({ pr_url: null, branch: "tangerine/abc123" })
    const deps = makeDeps([task], {}, { "tangerine/abc123": null })

    await Effect.runPromise(pollPrStatuses(deps))

    expect(deps.updates).toHaveLength(0)
    expect(deps.activities).toHaveLength(0)
  })

  test("discovers pr_url for reviewer tasks by branch", async () => {
    const prUrl = "https://github.com/test/repo/pull/20"
    const task = makeTaskRow({ pr_url: null, branch: "tangerine/abc123", type: "reviewer" })
    const deps = makeDeps([task], { [prUrl]: "open" }, { "tangerine/abc123": prUrl })

    await Effect.runPromise(pollPrStatuses(deps))

    const prUpdate = deps.updates.find((u) => u.updates.pr_url)
    expect(prUpdate).toBeDefined()
    expect(prUpdate!.updates.pr_url).toBe(prUrl)
    expect(deps.activities.some((a) => a.event === "pr.discovered")).toBe(true)
  })

  test("completes reviewer task when PR is merged", async () => {
    const prUrl = "https://github.com/test/repo/pull/21"
    const task = makeTaskRow({ pr_url: prUrl, type: "reviewer" })
    const deps = makeDeps([task], { [prUrl]: "merged" })

    await Effect.runPromise(pollPrStatuses(deps))

    expect(deps.updates).toHaveLength(1)
    expect(deps.updates[0]!.taskId).toBe(task.id)
    expect(deps.updates[0]!.updates.status).toBe("done")
    expect(deps.activities[0]!.event).toBe("task.completed")
  })

  test("discovers and completes reviewer task in same cycle", async () => {
    const prUrl = "https://github.com/test/repo/pull/22"
    const task = makeTaskRow({ pr_url: null, branch: "tangerine/review1", type: "reviewer" })
    const deps = makeDeps([task], { [prUrl]: "merged" }, { "tangerine/review1": prUrl })

    await Effect.runPromise(pollPrStatuses(deps))

    const statusUpdate = deps.updates.find((u) => u.updates.status)
    expect(statusUpdate?.updates.status).toBe("done")
  })

  test("handles listTasks failure gracefully", async () => {
    const deps: PrMonitorDeps = {
      db,
      listTasks: () => Effect.fail(new Error("db gone")),
      updateTask: () => Effect.succeed(null),
      logActivity: () => Effect.succeed(null),
      cleanupDeps: {
        db,
        getTask: () => Effect.succeed(null),
        updateTask: () => Effect.succeed(null),
        getAgentHandle: () => null,
      },
      checkPrState: () => Effect.succeed(null),
    }

    // Should not throw
    await Effect.runPromise(pollPrStatuses(deps))
  })
})

// ---------------------------------------------------------------------------
// buildSystemNotes — reviewer tasks should not get the "push and create PR" note
// ---------------------------------------------------------------------------

describe("buildSystemNotes", () => {
  test("includes PR creation note for worker tasks", () => {
    const notes = buildSystemNotes("test-id", { taskType: "worker" })
    expect(notes.some((n) => n.includes("rename-branch") && n.includes("gh pr create"))).toBe(true)
  })

  test("excludes PR creation note when taskType is undefined", () => {
    const notes = buildSystemNotes("test-id", {})
    expect(notes.some((n) => n.includes("rename-branch"))).toBe(false)
  })

  test("excludes PR creation note for reviewer tasks", () => {
    const notes = buildSystemNotes("test-id", { taskType: "reviewer" })
    expect(notes.some((n) => n.includes("rename-branch"))).toBe(false)
  })

  test("excludes PR creation note for orchestrator tasks", () => {
    const notes = buildSystemNotes("test-id", { taskType: "orchestrator" })
    expect(notes.some((n) => n.includes("rename-branch"))).toBe(false)
  })
})
