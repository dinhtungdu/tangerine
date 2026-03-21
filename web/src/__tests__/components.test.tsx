import { describe, test, expect, afterEach } from "bun:test"
import { render, screen, cleanup } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { RunCard } from "../components/RunCard"
import { ActivityList } from "../components/ActivityList"
import type { Task, ActivityEntry } from "@tangerine/shared"

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: "t1",
    projectId: "test",
    source: "manual",
    sourceId: null,
    sourceUrl: null,
    title: "Test task",
    description: null,
    status: "running",
    provider: "opencode",
    model: null,
    reasoningEffort: null,
    vmId: null,
    branch: null,
    worktreePath: null,
    prUrl: null,
    userId: null,
    agentSessionId: null,
    agentPort: null,
    previewPort: null,
    error: null,
    createdAt: "2026-03-17T10:00:00Z",
    updatedAt: "2026-03-17T10:00:00Z",
    startedAt: "2026-03-17T10:01:00Z",
    completedAt: null,
    ...overrides,
  }
}

function makeActivity(overrides?: Partial<ActivityEntry>): ActivityEntry {
  return {
    id: Math.floor(Math.random() * 10000),
    taskId: "t1",
    type: "lifecycle",
    event: "test",
    content: "Some activity",
    metadata: null,
    timestamp: new Date().toISOString(),
    ...overrides,
  }
}

afterEach(cleanup)

describe("RunCard", () => {
  test("renders task title and status", () => {
    render(
      <MemoryRouter>
        <RunCard task={makeTask({ title: "Fix auth bug", status: "running" })} />
      </MemoryRouter>
    )

    expect(screen.getByText("Fix auth bug")).toBeTruthy()
    expect(screen.getByText("Running")).toBeTruthy()
  })

  test("renders failed badge", () => {
    render(
      <MemoryRouter>
        <RunCard task={makeTask({ status: "failed" })} />
      </MemoryRouter>
    )

    expect(screen.getByText("Failed")).toBeTruthy()
  })

  test("renders as a link to task detail", () => {
    render(
      <MemoryRouter>
        <RunCard task={makeTask({ id: "task-123" })} />
      </MemoryRouter>
    )

    const link = screen.getByRole("link")
    expect(link.getAttribute("href")).toBe("/tasks/task-123")
  })

  test("shows duration and date", () => {
    render(
      <MemoryRouter>
        <RunCard task={makeTask({
          startedAt: "2026-03-17T10:00:00Z",
          completedAt: "2026-03-17T10:04:32Z",
        })} />
      </MemoryRouter>
    )

    expect(screen.getByText("4m 32s")).toBeTruthy()
    expect(screen.getByText("Mar 17")).toBeTruthy()
  })
})

describe("ActivityList", () => {
  test("shows empty state", () => {
    render(<ActivityList activities={[]} variant="compact" />)
    expect(screen.getByText("No activity yet")).toBeTruthy()
  })

  test("compact variant shows content", () => {
    const activities = [
      makeActivity({ content: "Read file src/index.ts" }),
    ]
    render(<ActivityList activities={activities} variant="compact" />)
    expect(screen.getByText(/Read file src\/index.ts/)).toBeTruthy()
  })

  test("timeline variant groups by day", () => {
    const activities = [
      makeActivity({ content: "First activity", timestamp: new Date().toISOString() }),
    ]
    render(<ActivityList activities={activities} variant="timeline" />)
    expect(screen.getByText("Today")).toBeTruthy()
    expect(screen.getByText(/First activity/)).toBeTruthy()
  })

  test("renders multiple activities", () => {
    const activities = [
      makeActivity({ content: "VM acquired" }),
      makeActivity({ content: "Worktree created" }),
      makeActivity({ content: "Agent started" }),
    ]
    render(<ActivityList activities={activities} variant="compact" />)
    expect(screen.getByText(/VM acquired/)).toBeTruthy()
    expect(screen.getByText(/Worktree created/)).toBeTruthy()
    expect(screen.getByText(/Agent started/)).toBeTruthy()
  })
})
