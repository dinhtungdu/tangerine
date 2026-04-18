import { describe, test, expect, beforeEach } from "bun:test"
import { Effect } from "effect"
import type { Database } from "bun:sqlite"
import { createTestDb } from "./helpers"
import { extractPrUrl, extractGithubSlug, getPrLookupTargets, pollPrStatuses } from "../tasks/pr-monitor"
import { resolveGithubSlug } from "../gh"
import type { PrMonitorDeps, PrState } from "../tasks/pr-monitor"
import type { TaskRow } from "../db/types"
import { buildPrWorkflowNote, buildSystemNotes, buildSystemLayer, buildUserLayer } from "../tasks/prompts"
import { resolveTaskTypeConfig, type ProjectConfig } from "@tangerine/shared"

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
    expect(extractPrUrl("https://github.example.com/owner/repo/pull/99")).toBe(
      "https://github.example.com/owner/repo/pull/99",
    )
  })

  test("extracts PR URL from GHE host in surrounding text", () => {
    const text = "Created PR: https://github.example.com/acme/widgets/pull/42 — please review"
    expect(extractPrUrl(text)).toBe("https://github.example.com/acme/widgets/pull/42")
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

  test("extracts host-qualified slug from GHE https URL", () => {
    expect(extractGithubSlug("https://github.example.com/owner/repo")).toBe("github.example.com/owner/repo")
  })

  test("extracts host-qualified slug from GHE https URL with .git suffix", () => {
    expect(extractGithubSlug("https://github.example.com/owner/repo.git")).toBe("github.example.com/owner/repo")
  })

  test("extracts host-qualified slug from GHE SSH remote URL", () => {
    expect(extractGithubSlug("git@github.example.com:owner/repo.git")).toBe("github.example.com/owner/repo")
  })
})

// ---------------------------------------------------------------------------
// resolveGithubSlug
// ---------------------------------------------------------------------------

describe("resolveGithubSlug", () => {
  test("resolves full https URL", () => {
    expect(resolveGithubSlug("https://github.com/owner/repo.git")).toBe("owner/repo")
  })

  test("resolves bare owner/repo shorthand", () => {
    expect(resolveGithubSlug("dinhtungdu/tangerine")).toBe("dinhtungdu/tangerine")
  })

  test("resolves GHE URL to host-qualified slug", () => {
    expect(resolveGithubSlug("https://github.example.com/owner/repo")).toBe("github.example.com/owner/repo")
  })

  test("returns null for non-github URL", () => {
    expect(resolveGithubSlug("https://gitlab.com/owner/repo")).toBeNull()
  })

  test("returns null for bare single-word string", () => {
    expect(resolveGithubSlug("tangerine")).toBeNull()
  })
})

describe("getPrLookupTargets", () => {
  test("uses repo itself when not a fork", () => {
    expect(getPrLookupTargets("user/repo", { nameWithOwner: "user/repo", isFork: false, parent: null })).toEqual([{ repoSlug: "user/repo" }])
  })

  test("checks upstream first for forks and constrains owner", () => {
    expect(getPrLookupTargets("user/repo", { nameWithOwner: "user/repo", isFork: true, parent: { nameWithOwner: "upstream/repo" } })).toEqual([
      { repoSlug: "upstream/repo", expectedHeadOwner: "user" },
      { repoSlug: "user/repo" },
    ])
  })

  test("falls back to repo when fork parent missing", () => {
    expect(getPrLookupTargets("user/repo", { nameWithOwner: "user/repo", isFork: true, parent: null })).toEqual([{ repoSlug: "user/repo" }])
  })

  test("qualifies GHE fork parent with host", () => {
    expect(getPrLookupTargets("github.example.com/user/repo", {
      nameWithOwner: "user/repo", isFork: true, parent: { nameWithOwner: "upstream/repo" },
    })).toEqual([
      { repoSlug: "github.example.com/upstream/repo", expectedHeadOwner: "user" },
      { repoSlug: "github.example.com/user/repo" },
    ])
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
    suspended: 0,
    error: null,
    created_at: now,
    updated_at: now,
    started_at: now,
    completed_at: null,
    last_seen_at: null,
    last_result_at: null,
    capabilities: null,
    context_tokens: 0,
    ...overrides,
  }
}

describe("pollPrStatuses", () => {
  let db: Database

  function makeDeps(
    tasks: TaskRow[],
    prStates: Record<string, PrState | null>,
    branchPrs: Record<string, string | null> = {},
    existingEvents: Record<string, string[]> = {},
  ): PrMonitorDeps & {
    updates: Array<{ taskId: string; updates: Partial<TaskRow> }>;
    activities: Array<{ taskId: string; event: string; content: string }>;
    prompts: Array<{ taskId: string; text: string }>;
  } {
    const updates: Array<{ taskId: string; updates: Partial<TaskRow> }> = []
    const activities: Array<{ taskId: string; event: string; content: string }> = []
    const prompts: Array<{ taskId: string; text: string }> = []
    return {
      updates,
      activities,
      prompts,
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
      hasActivityEvent: (taskId, event) => Effect.succeed(existingEvents[taskId]?.includes(event) ?? false),
      sendPrompt: (taskId, text) => {
        prompts.push({ taskId, text })
        return Effect.void
      },
      cleanupDeps: {
        db,
        getTask: () => Effect.succeed(null),
        updateTask: () => Effect.succeed(null),
        getAgentHandle: () => null,
      },
      getProjectRepoUrl: () => "https://github.com/test/repo",
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

  test("notifies agent when PR is merged", async () => {
    const prUrl = "https://github.com/test/repo/pull/1"
    const task = makeTaskRow({ pr_url: prUrl })
    const deps = makeDeps([task], { [prUrl]: "merged" })

    await Effect.runPromise(pollPrStatuses(deps))

    // Should log activity and send prompt, not update status
    expect(deps.activities).toHaveLength(1)
    expect(deps.activities[0]!.event).toBe("pr.merged")
    expect(deps.activities[0]!.content).toContain(prUrl)

    expect(deps.prompts).toHaveLength(1)
    expect(deps.prompts[0]!.taskId).toBe(task.id)
    expect(deps.prompts[0]!.text).toContain("PR has been merged")
    expect(deps.prompts[0]!.text).toContain("/done")

    // Should not update status - agent does that
    expect(deps.updates.filter((u) => u.updates.status)).toHaveLength(0)
  })

  test("notifies agent when PR is closed without merge", async () => {
    const prUrl = "https://github.com/test/repo/pull/2"
    const task = makeTaskRow({ pr_url: prUrl })
    const deps = makeDeps([task], { [prUrl]: "closed" })

    await Effect.runPromise(pollPrStatuses(deps))

    // Should log activity and send prompt, not update status
    expect(deps.activities).toHaveLength(1)
    expect(deps.activities[0]!.event).toBe("pr.closed")
    expect(deps.activities[0]!.content).toContain("closed without merge")

    expect(deps.prompts).toHaveLength(1)
    expect(deps.prompts[0]!.taskId).toBe(task.id)
    expect(deps.prompts[0]!.text).toContain("PR has been closed without merge")
    expect(deps.prompts[0]!.text).toContain("/cancel")

    // Should not update status - agent does that
    expect(deps.updates.filter((u) => u.updates.status)).toHaveLength(0)
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

    // merged + closed = 2 prompts; open = no prompt
    expect(deps.prompts).toHaveLength(2)
    expect(deps.activities.filter((a) => a.event === "pr.merged")).toHaveLength(1)
    expect(deps.activities.filter((a) => a.event === "pr.closed")).toHaveLength(1)
  })

  test("skips tasks when checkPrState returns null", async () => {
    const prUrl = "https://github.com/test/repo/pull/99"
    const task = makeTaskRow({ pr_url: prUrl })
    const deps = makeDeps([task], { [prUrl]: null })

    await Effect.runPromise(pollPrStatuses(deps))

    expect(deps.updates).toHaveLength(0)
  })

  test("skips notification when agent already notified about merged PR", async () => {
    const prUrl = "https://github.com/test/repo/pull/100"
    const task = makeTaskRow({ pr_url: prUrl })
    const deps = makeDeps([task], { [prUrl]: "merged" }, {}, { [task.id]: ["pr.merged"] })

    await Effect.runPromise(pollPrStatuses(deps))

    // Should not prompt or log activity again
    expect(deps.prompts).toHaveLength(0)
    expect(deps.activities).toHaveLength(0)
  })

  test("skips notification when agent already notified about closed PR", async () => {
    const prUrl = "https://github.com/test/repo/pull/101"
    const task = makeTaskRow({ pr_url: prUrl })
    const deps = makeDeps([task], { [prUrl]: "closed" }, {}, { [task.id]: ["pr.closed"] })

    await Effect.runPromise(pollPrStatuses(deps))

    // Should not prompt or log activity again
    expect(deps.prompts).toHaveLength(0)
    expect(deps.activities).toHaveLength(0)
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

    // Should discover PR and notify agent about merge in same cycle
    expect(deps.activities.some((a) => a.event === "pr.discovered")).toBe(true)
    expect(deps.activities.some((a) => a.event === "pr.merged")).toBe(true)
    expect(deps.prompts).toHaveLength(1)
    expect(deps.prompts[0]!.text).toContain("PR has been merged")
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

  test("notifies reviewer task when PR is merged", async () => {
    const prUrl = "https://github.com/test/repo/pull/21"
    const task = makeTaskRow({ pr_url: prUrl, type: "reviewer" })
    const deps = makeDeps([task], { [prUrl]: "merged" })

    await Effect.runPromise(pollPrStatuses(deps))

    expect(deps.activities).toHaveLength(1)
    expect(deps.activities[0]!.event).toBe("pr.merged")
    expect(deps.prompts).toHaveLength(1)
    expect(deps.prompts[0]!.taskId).toBe(task.id)
  })

  test("discovers and notifies reviewer task in same cycle", async () => {
    const prUrl = "https://github.com/test/repo/pull/22"
    const task = makeTaskRow({ pr_url: null, branch: "tangerine/review1", type: "reviewer" })
    const deps = makeDeps([task], { [prUrl]: "merged" }, { "tangerine/review1": prUrl })

    await Effect.runPromise(pollPrStatuses(deps))

    expect(deps.activities.some((a) => a.event === "pr.discovered")).toBe(true)
    expect(deps.activities.some((a) => a.event === "pr.merged")).toBe(true)
    expect(deps.prompts).toHaveLength(1)
  })

  test("discovers pr_url for provisioning tasks", async () => {
    const prUrl = "https://github.com/test/repo/pull/30"
    const task = makeTaskRow({ pr_url: null, branch: "tangerine/abc123", status: "provisioning" })
    const deps = makeDeps([task], { [prUrl]: "open" }, { "tangerine/abc123": prUrl })

    await Effect.runPromise(pollPrStatuses(deps))

    const prUpdate = deps.updates.find((u) => u.updates.pr_url)
    expect(prUpdate).toBeDefined()
    expect(prUpdate!.updates.pr_url).toBe(prUrl)
  })

  test("discovers pr_url for failed tasks", async () => {
    const prUrl = "https://github.com/test/repo/pull/31"
    const task = makeTaskRow({ pr_url: null, branch: "tangerine/abc123", status: "failed" })
    const deps = makeDeps([task], { [prUrl]: "open" }, { "tangerine/abc123": prUrl })

    await Effect.runPromise(pollPrStatuses(deps))

    const prUpdate = deps.updates.find((u) => u.updates.pr_url)
    expect(prUpdate).toBeDefined()
    expect(prUpdate!.updates.pr_url).toBe(prUrl)
  })

  test("skips done and cancelled tasks for PR discovery", async () => {
    const tasks = [
      makeTaskRow({ pr_url: null, branch: "tangerine/done1", status: "done" }),
      makeTaskRow({ pr_url: null, branch: "tangerine/cancel1", status: "cancelled" }),
    ]
    const deps = makeDeps(tasks, {}, {
      "tangerine/done1": "https://github.com/test/repo/pull/40",
      "tangerine/cancel1": "https://github.com/test/repo/pull/41",
    })

    await Effect.runPromise(pollPrStatuses(deps))

    expect(deps.updates).toHaveLength(0)
    expect(deps.activities).toHaveLength(0)
  })

  test("directly completes failed task when discovered PR is merged", async () => {
    const prUrl = "https://github.com/test/repo/pull/32"
    const task = makeTaskRow({ pr_url: null, branch: "tangerine/abc123", status: "failed" })
    const deps = makeDeps([task], { [prUrl]: "merged" }, { "tangerine/abc123": prUrl })

    await Effect.runPromise(pollPrStatuses(deps))

    // Non-running tasks should be directly completed, not prompted
    expect(deps.activities.some((a) => a.event === "pr.merged")).toBe(true)
    expect(deps.activities.some((a) => a.event === "task.completed")).toBe(true)
    expect(deps.updates.some((u) => u.updates.status === "done")).toBe(true)
    expect(deps.prompts).toHaveLength(0)
  })

  test("discovers pr_url using getProjectRepoUrl", async () => {
    const prUrl = "https://github.com/test/repo/pull/50"
    const task = makeTaskRow({ pr_url: null, branch: "tangerine/abc123" })
    const deps = makeDeps([task], { [prUrl]: "open" }, { "tangerine/abc123": prUrl })
    deps.getProjectRepoUrl = (projectId) => projectId === "test" ? "https://github.com/test/repo" : undefined

    await Effect.runPromise(pollPrStatuses(deps))

    const prUpdate = deps.updates.find((u) => u.updates.pr_url)
    expect(prUpdate).toBeDefined()
    expect(prUpdate!.updates.pr_url).toBe(prUrl)
  })

  test("skips task when getProjectRepoUrl returns undefined", async () => {
    const task = makeTaskRow({ pr_url: null, branch: "tangerine/abc123" })
    const deps = makeDeps([task], {}, { "tangerine/abc123": "https://github.com/test/repo/pull/51" })
    deps.getProjectRepoUrl = () => undefined

    await Effect.runPromise(pollPrStatuses(deps))

    expect(deps.updates).toHaveLength(0)
  })

  test("handles listTasks failure gracefully", async () => {
    const deps: PrMonitorDeps = {
      db,
      listTasks: () => Effect.fail(new Error("db gone")),
      updateTask: () => Effect.succeed(null),
      logActivity: () => Effect.succeed(null),
      hasActivityEvent: () => Effect.succeed(false),
      sendPrompt: () => Effect.void,
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

  // -------------------------------------------------------------------------
  // Phase 0: worktree branch sync
  // -------------------------------------------------------------------------

  test("updates task.branch when worktree HEAD differs from DB", async () => {
    const task = makeTaskRow({ branch: "tangerine/old-branch", worktree_path: "/workspace/worktrees/slot-0", pr_url: null })
    const deps = makeDeps([task], {})
    deps.readWorktreeBranch = (_path) => Effect.succeed("fix/new-name")

    await Effect.runPromise(pollPrStatuses(deps))

    expect(deps.updates).toHaveLength(1)
    expect(deps.updates[0]).toMatchObject({ taskId: task.id, updates: { branch: "fix/new-name" } })
  })

  test("does not update task.branch when worktree HEAD matches DB", async () => {
    const task = makeTaskRow({ branch: "tangerine/abc123", worktree_path: "/workspace/worktrees/slot-0", pr_url: null })
    const deps = makeDeps([task], {})
    deps.readWorktreeBranch = (_path) => Effect.succeed("tangerine/abc123")

    await Effect.runPromise(pollPrStatuses(deps))

    expect(deps.updates).toHaveLength(0)
  })

  test("skips branch sync for tasks without worktree_path", async () => {
    const task = makeTaskRow({ branch: "tangerine/abc123", worktree_path: null, pr_url: null })
    const deps = makeDeps([task], {})
    let branchReaderCalled = false
    deps.readWorktreeBranch = (_path) => { branchReaderCalled = true; return Effect.succeed("other") }

    await Effect.runPromise(pollPrStatuses(deps))

    expect(branchReaderCalled).toBe(false)
    expect(deps.updates).toHaveLength(0)
  })

  test("skips branch sync when readWorktreeBranch returns null (detached HEAD)", async () => {
    const task = makeTaskRow({ branch: "tangerine/abc123", worktree_path: "/workspace/worktrees/slot-0", pr_url: null })
    const deps = makeDeps([task], {})
    deps.readWorktreeBranch = (_path) => Effect.succeed(null)

    await Effect.runPromise(pollPrStatuses(deps))

    expect(deps.updates).toHaveLength(0)
  })

  test("uses updated branch for PR discovery after sync in same cycle", async () => {
    // task.branch is stale; worktree HEAD is the real branch; a PR exists for the real branch
    const task = makeTaskRow({ branch: "tangerine/old", worktree_path: "/workspace/worktrees/slot-0", pr_url: null })
    const deps = makeDeps([task], {}, { "fix/new-name": "https://github.com/test/repo/pull/99" })
    deps.readWorktreeBranch = (_path) => Effect.succeed("fix/new-name")

    await Effect.runPromise(pollPrStatuses(deps))

    // First update: branch sync. Second update: pr_url discovered using corrected branch.
    const branchUpdate = deps.updates.find((u) => u.updates.branch === "fix/new-name")
    const prUpdate = deps.updates.find((u) => u.updates.pr_url === "https://github.com/test/repo/pull/99")
    expect(branchUpdate).toBeDefined()
    expect(prUpdate).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// buildSystemNotes — reviewer tasks should not get the "push and create PR" note
// ---------------------------------------------------------------------------

describe("buildSystemNotes", () => {
  test("places auth curl flags before the rename-branch URL", () => {
    const note = buildPrWorkflowNote("test-id")
    expect(note).toContain('curl -X POST ${TANGERINE_AUTH_TOKEN:+-H "Authorization: Bearer $TANGERINE_AUTH_TOKEN"} http://localhost:')
  })

  test("includes PR workflow note for worker tasks", () => {
    const notes = buildSystemNotes("test-id", { taskType: "worker", prMode: "draft" })
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

  test("injects draft prMode instruction for worker tasks (default)", () => {
    const notes = buildSystemNotes("test-id", { taskType: "worker", prMode: "draft" })
    expect(notes.some((n) => n.includes("PR MODE") && n.includes("--draft"))).toBe(true)
    expect(notes.some((n) => n.includes("Never create a ready PR"))).toBe(true)
  })

  test("injects ready prMode instruction for worker tasks", () => {
    const notes = buildSystemNotes("test-id", { taskType: "worker", prMode: "ready" })
    expect(notes.some((n) => n.includes("PR MODE") && n.includes('"ready"'))).toBe(true)
    expect(notes.some((n) => n.includes("Never use --draft"))).toBe(true)
  })

  test("injects none prMode instruction for worker tasks", () => {
    const notes = buildSystemNotes("test-id", { taskType: "worker", prMode: "none" })
    expect(notes.some((n) => n.includes("PR MODE") && n.includes('"none"'))).toBe(true)
    expect(notes.some((n) => n.includes("Do NOT push or create a PR"))).toBe(true)
    // none mode should NOT include workflow note or PR template note
    expect(notes.some((n) => n.includes("rename-branch"))).toBe(false)
    expect(notes.some((n) => n.includes("PR TEMPLATE"))).toBe(false)
  })

  test("defaults to none prMode when prMode not provided for worker tasks", () => {
    const notes = buildSystemNotes("test-id", { taskType: "worker" })
    expect(notes.some((n) => n.includes("PR MODE") && n.includes('"none"'))).toBe(true)
    expect(notes.some((n) => n.includes("Do NOT push or create a PR"))).toBe(true)
  })

  test("does not inject prMode instruction for non-worker tasks", () => {
    const notes = buildSystemNotes("test-id", { taskType: "reviewer", prMode: "draft" })
    expect(notes.some((n) => n.includes("PR MODE"))).toBe(false)
  })

  test("includes runner task note and excludes PR notes for runner type", () => {
    const notes = buildSystemNotes("test-id", { taskType: "runner", prMode: "draft" })
    expect(notes.some((n) => n.includes("RUNNER TASK"))).toBe(true)
    expect(notes.some((n) => n.includes("PR MODE"))).toBe(false)
    expect(notes.some((n) => n.includes("rename-branch"))).toBe(false)
  })

  test("includes --repo upstream flag for fork projects (draft)", () => {
    const notes = buildSystemNotes("test-id", { taskType: "worker", prMode: "draft", upstreamSlug: "upstream/repo" })
    expect(notes.some((n) => n.includes("--repo upstream/repo"))).toBe(true)
    expect(notes.some((n) => n.includes("This is a fork"))).toBe(true)
  })

  test("includes --repo upstream flag for fork projects (ready)", () => {
    const notes = buildSystemNotes("test-id", { taskType: "worker", prMode: "ready", upstreamSlug: "upstream/repo" })
    expect(notes.some((n) => n.includes("--repo upstream/repo"))).toBe(true)
  })

  test("omits --repo flag when no upstream slug", () => {
    const notes = buildSystemNotes("test-id", { taskType: "worker", prMode: "draft" })
    expect(notes.some((n) => n.includes("--repo"))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// buildSystemLayer / buildUserLayer — prompt layer split
// ---------------------------------------------------------------------------

describe("buildSystemLayer", () => {
  test("always includes Tangerine identity", () => {
    const notes = buildSystemLayer("test-id", { taskType: "worker" })
    expect(notes.some((n) => n.includes("TANGERINE"))).toBe(true)
  })

  test("includes delegation rules for orchestrator", () => {
    const notes = buildSystemLayer("test-id", { taskType: "orchestrator" })
    expect(notes.some((n) => n.includes("DELEGATION"))).toBe(true)
    expect(notes.some((n) => n.includes("CONTEXT"))).toBe(true)
  })

  test("excludes delegation rules for workers", () => {
    const notes = buildSystemLayer("test-id", { taskType: "worker" })
    expect(notes.some((n) => n.includes("DELEGATION"))).toBe(false)
  })

  test("does not include style note", () => {
    const notes = buildSystemLayer("test-id", { taskType: "worker" })
    expect(notes.some((n) => n.includes("STYLE"))).toBe(false)
  })
})

describe("buildUserLayer", () => {
  test("includes default style note when no custom prompt", () => {
    const notes = buildUserLayer("test-id", { taskType: "worker" })
    expect(notes.some((n) => n.includes("STYLE"))).toBe(true)
  })

  test("includes setup note when setupCommand provided", () => {
    const notes = buildUserLayer("test-id", { taskType: "worker", setupCommand: "bun install" })
    expect(notes.some((n) => n.includes("bun install"))).toBe(true)
  })

  test("replaces defaults with custom system prompt", () => {
    const notes = buildUserLayer("test-id", {
      taskType: "worker",
      customSystemPrompt: "You are a security-focused engineer.",
      setupCommand: "bun install",
    })
    expect(notes).toEqual(["You are a security-focused engineer."])
    expect(notes.some((n) => n.includes("STYLE"))).toBe(false)
  })

  test("replaces defaults for reviewer with custom system prompt", () => {
    const notes = buildUserLayer("test-id", {
      taskType: "reviewer",
      customSystemPrompt: "Focus on performance issues.",
    })
    expect(notes).toEqual(["Focus on performance issues."])
  })

  test("uses defaults when no custom prompt provided", () => {
    const notes = buildUserLayer("test-id", { taskType: "reviewer" })
    expect(notes.some((n) => n.includes("STYLE"))).toBe(true)
  })

  test("uses defaults for orchestrator when no custom prompt", () => {
    const notes = buildUserLayer("test-id", { taskType: "orchestrator" })
    expect(notes.some((n) => n.includes("STYLE"))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// resolveTaskTypeConfig — per-task-type config resolution
// ---------------------------------------------------------------------------

describe("resolveTaskTypeConfig", () => {
  const baseProject = { name: "test", repo: "test", setup: "bun install" } as ProjectConfig

  test("returns defaults when no taskTypes configured", () => {
    const result = resolveTaskTypeConfig(baseProject, "worker")
    expect(result.predefinedPrompts.length).toBeGreaterThan(0)
    expect(result.systemPrompt).toBeUndefined()
  })

  test("returns worker predefinedPrompts from taskTypes", () => {
    const project = {
      ...baseProject,
      taskTypes: { worker: { predefinedPrompts: [{ label: "new", text: "new" }] } },
    } as ProjectConfig
    const result = resolveTaskTypeConfig(project, "worker")
    expect(result.predefinedPrompts).toEqual([{ label: "new", text: "new" }])
  })

  test("returns orchestrator systemPrompt from taskTypes", () => {
    const project = {
      ...baseProject,
      taskTypes: { orchestrator: { systemPrompt: "custom orch" } },
    } as ProjectConfig
    const result = resolveTaskTypeConfig(project, "orchestrator")
    expect(result.systemPrompt).toBe("custom orch")
  })

  test("returns reviewer config from taskTypes", () => {
    const project = {
      ...baseProject,
      taskTypes: { reviewer: { predefinedPrompts: [{ label: "rev", text: "rev" }] } },
    } as ProjectConfig
    const result = resolveTaskTypeConfig(project, "reviewer")
    expect(result.predefinedPrompts).toEqual([{ label: "rev", text: "rev" }])
  })

  test("returns default prompts per task type", () => {
    expect(resolveTaskTypeConfig(baseProject, "worker").predefinedPrompts[0]!.label).toBe("Are you proud of your code?")
    expect(resolveTaskTypeConfig(baseProject, "orchestrator").predefinedPrompts[0]!.label).toBe("Check active tasks")
    expect(resolveTaskTypeConfig(baseProject, "reviewer").predefinedPrompts[0]!.label).toBe("Summarize findings")
  })
})
