import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import { createTestDb } from "./helpers"
import * as dbQueries from "../db/queries"

/**
 * Test the review task base branch resolution logic directly.
 * The actual logic lives in lifecycle.ts startSession, which queries the parent
 * task's branch from the DB to use as the base for the review task's checkout.
 * We test the DB query pattern here since startSession requires a full git repo.
 */
describe("review task base branch resolution", () => {
  test("parent branch is resolvable from DB when review task has parentTaskId", () => {
    const db = createTestDb()

    // Create parent task with a branch
    Effect.runSync(dbQueries.createTask(db, {
      id: "parent-111",
      project_id: "test-project",
      source: "manual",
      repo_url: "test/repo",
      title: "Parent task",
      branch: "tangerine/parent-br",
    }))

    // Create review task referencing the parent
    const review = Effect.runSync(dbQueries.createTask(db, {
      id: "review-111",
      project_id: "test-project",
      source: "manual",
      repo_url: "test/repo",
      title: "Review parent",
      type: "review",
      parent_task_id: "parent-111",
    }))

    expect(review.type).toBe("review")
    expect(review.parent_task_id).toBe("parent-111")
    // Review task gets no branch of its own (lifecycle generates tangerine/{prefix})
    expect(review.branch).toBeNull()

    // Simulate what lifecycle.ts does: look up parent branch from DB
    const parentRow = db.prepare("SELECT branch FROM tasks WHERE id = ?").get("parent-111") as { branch: string | null } | null
    expect(parentRow?.branch).toBe("tangerine/parent-br")
  })

  test("parent with no branch falls back to default", () => {
    const db = createTestDb()

    Effect.runSync(dbQueries.createTask(db, {
      id: "parent-222",
      project_id: "test-project",
      source: "manual",
      repo_url: "test/repo",
      title: "Parent task",
    }))

    // Parent has no branch — lifecycle should fall back to defaultBranch
    const parentRow = db.prepare("SELECT branch FROM tasks WHERE id = ?").get("parent-222") as { branch: string | null } | null
    expect(parentRow?.branch).toBeNull()
  })

  test("non-review task does not resolve parent branch", () => {
    const db = createTestDb()

    Effect.runSync(dbQueries.createTask(db, {
      id: "parent-333",
      project_id: "test-project",
      source: "manual",
      repo_url: "test/repo",
      title: "Parent task",
      branch: "tangerine/parent-br",
    }))

    const codeTask = Effect.runSync(dbQueries.createTask(db, {
      id: "code-333",
      project_id: "test-project",
      source: "manual",
      repo_url: "test/repo",
      title: "Child code task",
      type: "code",
      parent_task_id: "parent-333",
    }))

    // Code tasks don't use the parent branch resolution path
    // (lifecycle.ts only resolves for type === "review")
    expect(codeTask.type).toBe("code")
    expect(codeTask.branch).toBeNull()
  })
})
