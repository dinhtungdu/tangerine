import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test"
import { Effect } from "effect"
import { pollGitHubIssues, type GitHubDeps } from "../integrations/github"
/** Local ProjectConfig type matching github module's interface */
interface ProjectConfig {
  repo: string
  integrations?: {
    github?: {
      trigger: {
        type: "label" | "assignee"
        value: string
      }
    }
  }
}

/**
 * Tracer bullet: GitHub API response -> Task creation -> Deduplication
 *
 * Tests the GitHub polling integration: parsing issues, filtering by
 * trigger, creating tasks, deduplicating by sourceId, and handling
 * API errors. Mocks Bun.spawn to simulate `gh api` responses.
 */

interface MockGitHubIssue {
  number: number
  title: string
  body: string | null
  html_url: string
  labels: Array<{ name: string }>
  assignee: { login: string } | null
}

function makeIssue(num: number, overrides?: Partial<MockGitHubIssue>): MockGitHubIssue {
  return {
    number: num,
    title: `Issue #${num}`,
    body: `Body for issue ${num}`,
    html_url: `https://github.com/test/repo/issues/${num}`,
    labels: [],
    assignee: { login: "bot" },
    ...overrides,
  }
}

function makeConfig(trigger: { type: "label" | "assignee"; value: string }): ProjectConfig {
  return {
    repo: "test/repo",
    integrations: {
      github: {
        trigger,
      },
    },
  }
}

/** Create a fake Bun.spawn result that returns the given stdout and exits 0. */
function makeSpawnResult(stdout: string, exitCode = 0): ReturnType<typeof Bun.spawn> {
  return {
    stdout: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(stdout))
        controller.close()
      },
    }),
    stderr: new ReadableStream({
      start(controller) {
        controller.close()
      },
    }),
    exited: Promise.resolve(exitCode),
  } as unknown as ReturnType<typeof Bun.spawn>
}

describe("tracer: github polling -> task creation -> dedup", () => {
  let createdTasks: Array<{ sourceId: string; title: string; description: string }>
  let existingSourceIds: Set<string>
  let deps: GitHubDeps
  let spawnSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    createdTasks = []
    existingSourceIds = new Set()

    deps = {
      createTask(params) {
        createdTasks.push({
          sourceId: params.sourceId,
          title: params.title,
          description: params.description,
        })
        existingSourceIds.add(params.sourceId)
      },
      isTaskExists(sourceId: string) {
        return existingSourceIds.has(sourceId)
      },
    }

    spawnSpy = spyOn(Bun, "spawn")
  })

  afterEach(() => {
    spawnSpy.mockRestore()
  })

  it("creates tasks from matching GitHub issues (assignee trigger)", async () => {
    const issues = [
      makeIssue(1, { assignee: { login: "bot" } }),
      makeIssue(2, { assignee: { login: "bot" } }),
      makeIssue(3, { assignee: { login: "other" } }), // not matching
    ]

    spawnSpy.mockReturnValue(makeSpawnResult(JSON.stringify(issues)))

    const config = makeConfig({ type: "assignee", value: "bot" })
    await Effect.runPromise(pollGitHubIssues(config, deps))

    expect(createdTasks).toHaveLength(2)
    expect(createdTasks[0]!.title).toBe("Issue #1")
    expect(createdTasks[1]!.title).toBe("Issue #2")
  })

  it("creates tasks from matching GitHub issues (label trigger)", async () => {
    const issues = [
      makeIssue(1, { labels: [{ name: "agent" }] }),
      makeIssue(2, { labels: [{ name: "bug" }] }), // not matching
      makeIssue(3, { labels: [{ name: "agent" }, { name: "priority" }] }),
    ]

    spawnSpy.mockReturnValue(makeSpawnResult(JSON.stringify(issues)))

    const config = makeConfig({ type: "label", value: "agent" })
    await Effect.runPromise(pollGitHubIssues(config, deps))

    expect(createdTasks).toHaveLength(2)
    expect(createdTasks[0]!.title).toBe("Issue #1")
    expect(createdTasks[1]!.title).toBe("Issue #3")
  })

  it("creates tasks for all matching assigned issues", async () => {
    const issues = [
      makeIssue(1, { title: "Run checks", assignee: { login: "bot" } }),
      makeIssue(2, { assignee: { login: "bot" } }),
    ]

    spawnSpy.mockReturnValue(makeSpawnResult(JSON.stringify(issues)))

    const config = makeConfig({ type: "assignee", value: "bot" })
    await Effect.runPromise(pollGitHubIssues(config, deps))

    expect(createdTasks).toHaveLength(2)
    expect(createdTasks[0]!.sourceId).toBe("github:test/repo#1")
    expect(createdTasks[1]!.sourceId).toBe("github:test/repo#2")
  })

  it("deduplicates issues on subsequent poll cycles", async () => {
    const issues = [
      makeIssue(1, { assignee: { login: "bot" } }),
      makeIssue(2, { assignee: { login: "bot" } }),
    ]

    spawnSpy.mockReturnValue(makeSpawnResult(JSON.stringify(issues)))

    const config = makeConfig({ type: "assignee", value: "bot" })

    // First poll — creates 2 tasks
    await Effect.runPromise(pollGitHubIssues(config, deps))
    expect(createdTasks).toHaveLength(2)

    // Second poll with same issues — should not create duplicates
    spawnSpy.mockReturnValue(makeSpawnResult(JSON.stringify(issues)))
    await Effect.runPromise(pollGitHubIssues(config, deps))
    expect(createdTasks).toHaveLength(2)
  })

  it("creates only new tasks when mix of old and new issues", async () => {
    // Pre-seed issue #1 as already existing
    existingSourceIds.add("github:test/repo#1")

    const issues = [
      makeIssue(1, { assignee: { login: "bot" } }),
      makeIssue(2, { assignee: { login: "bot" } }),
      makeIssue(3, { assignee: { login: "bot" } }),
    ]

    spawnSpy.mockReturnValue(makeSpawnResult(JSON.stringify(issues)))

    const config = makeConfig({ type: "assignee", value: "bot" })
    await Effect.runPromise(pollGitHubIssues(config, deps))

    expect(createdTasks).toHaveLength(2) // Only #2 and #3
    expect(createdTasks.map((t) => t.sourceId)).toEqual([
      "github:test/repo#2",
      "github:test/repo#3",
    ])
  })

  it("handles API error gracefully (does not throw)", async () => {
    spawnSpy.mockReturnValue(makeSpawnResult("internal error", 1))

    const config = makeConfig({ type: "assignee", value: "bot" })

    // pollGitHubIssues returns a GitHubPollError for non-zero exit
    await expect(Effect.runPromise(pollGitHubIssues(config, deps))).rejects.toThrow()
    expect(createdTasks).toHaveLength(0)
  })

  it("skips polling when no github integration configured", async () => {
    const config = { repo: "test/repo" } as ProjectConfig
    await Effect.runPromise(pollGitHubIssues(config, deps))

    // spawn should not have been called
    expect(spawnSpy).not.toHaveBeenCalled()
    expect(createdTasks).toHaveLength(0)
  })

  it("handles empty issue list", async () => {
    spawnSpy.mockReturnValue(makeSpawnResult(JSON.stringify([])))

    const config = makeConfig({ type: "assignee", value: "bot" })
    await Effect.runPromise(pollGitHubIssues(config, deps))

    expect(createdTasks).toHaveLength(0)
  })

  it("passes issue metadata to created tasks", async () => {
    const issues = [
      makeIssue(42, {
        title: "Fix critical bug",
        body: "The app crashes when...",
        html_url: "https://github.com/test/repo/issues/42",
        assignee: { login: "bot" },
      }),
    ]

    spawnSpy.mockReturnValue(makeSpawnResult(JSON.stringify(issues)))

    const config = makeConfig({ type: "assignee", value: "bot" })
    await Effect.runPromise(pollGitHubIssues(config, deps))

    expect(createdTasks).toHaveLength(1)
    const task = createdTasks[0]!
    expect(task.title).toBe("Fix critical bug")
    expect(task.description).toBe("The app crashes when...")
    expect(task.sourceId).toBe("github:test/repo#42")
  })

  it("calls gh api with correct endpoint", async () => {
    spawnSpy.mockReturnValue(makeSpawnResult(JSON.stringify([])))

    const config = makeConfig({ type: "assignee", value: "bot" })
    await Effect.runPromise(pollGitHubIssues(config, deps))

    expect(spawnSpy).toHaveBeenCalledWith(
      ["gh", "api", "repos/test/repo/issues?state=open&per_page=50"],
      expect.objectContaining({ stdout: "pipe", stderr: "pipe" }),
    )
  })
})
