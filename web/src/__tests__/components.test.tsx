import { describe, test, expect, afterEach } from "bun:test"
import { render, screen, cleanup } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { RunCard } from "../components/RunCard"
import { ActivityList } from "../components/ActivityList"
import type { Task } from "@tangerine/shared"
import type { ChatMessage } from "../hooks/useSession"

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

function makeMessage(overrides?: Partial<ChatMessage>): ChatMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    role: "assistant",
    content: "Some agent activity",
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
    render(<ActivityList messages={[]} variant="compact" />)
    expect(screen.getByText("No activity yet")).toBeTruthy()
  })

  test("compact variant shows timestamp and content", () => {
    const messages = [
      makeMessage({ role: "assistant", content: "Read file src/index.ts" }),
    ]
    render(<ActivityList messages={messages} variant="compact" />)
    expect(screen.getByText(/Read file src\/index.ts/)).toBeTruthy()
  })

  test("timeline variant groups by day", () => {
    const messages = [
      makeMessage({ role: "assistant", content: "First activity", timestamp: new Date().toISOString() }),
    ]
    render(<ActivityList messages={messages} variant="timeline" />)
    expect(screen.getByText("Today")).toBeTruthy()
    expect(screen.getByText(/First activity/)).toBeTruthy()
  })

  test("filters to only assistant and tool messages", () => {
    const messages = [
      makeMessage({ role: "user", content: "User message" }),
      makeMessage({ role: "assistant", content: "Agent response" }),
      makeMessage({ role: "tool", content: "Tool output" }),
    ]
    render(<ActivityList messages={messages} variant="compact" />)
    // User message should not appear
    expect(screen.queryByText("User message")).toBeNull()
    expect(screen.getByText(/Agent response/)).toBeTruthy()
    expect(screen.getByText(/Tool output/)).toBeTruthy()
  })
})
