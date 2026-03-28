import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import { createTestDb } from "./helpers"
import * as dbQueries from "../db/queries"
import type { LifecycleDeps } from "../tasks/lifecycle"

/**
 * Test the review task base branch resolution logic.
 * lifecycle.ts uses deps.getTask() to look up the parent's branch.
 * We verify the getTask interface returns the branch field correctly.
 */
describe("review task base branch resolution", () => {
  function makeGetTask(db: ReturnType<typeof createTestDb>): LifecycleDeps["getTask"] {
    return (id) => dbQueries.getTask(db, id).pipe(Effect.mapError((e) => e as unknown as Error))
  }

  test("getTask returns parent branch for base branch resolution", () => {
    const db = createTestDb()
    const getTask = makeGetTask(db)

    Effect.runSync(dbQueries.createTask(db, {
      id: "parent-111",
      project_id: "test-project",
      source: "manual",
      repo_url: "test/repo",
      title: "Parent task",
      branch: "tangerine/parent-br",
    }))

    // Simulate what lifecycle.ts does: look up parent via deps.getTask
    const parent = Effect.runSync(getTask("parent-111"))
    expect(parent?.branch).toBe("tangerine/parent-br")
  })

  test("getTask returns null branch when parent has none", () => {
    const db = createTestDb()
    const getTask = makeGetTask(db)

    Effect.runSync(dbQueries.createTask(db, {
      id: "parent-222",
      project_id: "test-project",
      source: "manual",
      repo_url: "test/repo",
      title: "Parent task",
    }))

    const parent = Effect.runSync(getTask("parent-222"))
    expect(parent?.branch).toBeNull()
  })

  test("getTask returns null for nonexistent parent", () => {
    const db = createTestDb()
    const getTask = makeGetTask(db)

    const parent = Effect.runSync(getTask("nonexistent"))
    expect(parent).toBeNull()
  })

  test("review task stores parent_task_id correctly", () => {
    const db = createTestDb()

    Effect.runSync(dbQueries.createTask(db, {
      id: "parent-333",
      project_id: "test-project",
      source: "manual",
      repo_url: "test/repo",
      title: "Parent task",
      branch: "tangerine/parent-br",
    }))

    const review = Effect.runSync(dbQueries.createTask(db, {
      id: "review-333",
      project_id: "test-project",
      source: "manual",
      repo_url: "test/repo",
      title: "Review parent",
      type: "review",
      parent_task_id: "parent-333",
    }))

    expect(review.type).toBe("review")
    expect(review.parent_task_id).toBe("parent-333")
    // Review task gets no branch (lifecycle generates tangerine/{prefix})
    expect(review.branch).toBeNull()
  })
})
