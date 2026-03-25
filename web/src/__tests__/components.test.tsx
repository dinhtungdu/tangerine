import { describe, test, expect, afterEach } from "bun:test"
import { render, screen, cleanup, fireEvent } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { RunCard } from "../components/RunCard"
import { ActivityList } from "../components/ActivityList"
import { NewAgentForm } from "../components/NewAgentForm"
import { ProjectProvider } from "../context/ProjectContext"
import type { Task, ActivityEntry } from "@tangerine/shared"

const originalFetch = global.fetch

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

afterEach(() => {
  cleanup()
  global.fetch = originalFetch
  globalThis.localStorage?.clear()
})

function mockProjectsFetch() {
  global.fetch = async () => new Response(JSON.stringify({
    projects: [
      {
        name: "test-project",
        repo: "test/repo",
        defaultBranch: "main",
        setup: "echo ok",
        defaultProvider: "claude-code",
      },
    ],
    model: "anthropic/claude-sonnet-4-6",
    models: ["anthropic/claude-sonnet-4-6", "openai/gpt-5.4"],
    modelsByProvider: {
      "claude-code": ["anthropic/claude-sonnet-4-6", "anthropic/claude-haiku-4-20250414"],
      opencode: ["openai/gpt-5.4", "openai/gpt-5-mini"],
    },
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

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

  test("compact variant shows label and detail", () => {
    const activities = [
      makeActivity({ event: "tool.read", content: "Read", metadata: { toolInput: JSON.stringify({ file_path: "src/index.ts" }) } }),
    ]
    render(<ActivityList activities={activities} variant="compact" />)
    expect(screen.getByText("Read file")).toBeTruthy()
    expect(screen.getByText("src/index.ts")).toBeTruthy()
  })

  test("timeline variant groups by day", () => {
    const activities = [
      makeActivity({ event: "tool.bash", content: "npm test", timestamp: new Date().toISOString() }),
    ]
    render(<ActivityList activities={activities} variant="timeline" />)
    expect(screen.getByText("Today")).toBeTruthy()
    expect(screen.getByText("Bash")).toBeTruthy()
  })

  test("renders multiple activities", () => {
    const activities = [
      makeActivity({ event: "vm.acquiring", content: "VM acquired" }),
      makeActivity({ event: "worktree.created", content: "Worktree created" }),
      makeActivity({ event: "agent.thinking", content: "Analyzing code" }),
    ]
    render(<ActivityList activities={activities} variant="compact" />)
    expect(screen.getByText(/VM acquired/)).toBeTruthy()
    expect(screen.getByText(/Worktree created/)).toBeTruthy()
    expect(screen.getByText("Thinking")).toBeTruthy()
  })
})

describe("NewAgentForm", () => {
  test("keeps desktop selector row unclipped so dropdowns can open", async () => {
    mockProjectsFetch()

    render(
      <MemoryRouter initialEntries={["/?project=test-project"]}>
        <ProjectProvider>
          <NewAgentForm onSubmit={() => {}} />
        </ProjectProvider>
      </MemoryRouter>
    )

    await screen.findByText("What should the agent work on?")

    const harnessButton = await screen.findByRole("button", { name: "Claude Code" })
    const controlsRow = harnessButton.parentElement?.parentElement
    expect(controlsRow?.className.includes("overflow-visible")).toBe(true)

    fireEvent.click(harnessButton)
    expect(screen.getByRole("button", { name: "OpenCode" })).toBeTruthy()

    fireEvent.click(screen.getAllByRole("button", { name: "anthropic/claude-sonnet-4-6" })[0]!)
    expect(screen.getByRole("button", { name: "anthropic/claude-haiku-4" })).toBeTruthy()

    fireEvent.click(screen.getAllByRole("button", { name: "Medium" })[0]!)
    expect(screen.getByRole("button", { name: /Extended reasoning/ })).toBeTruthy()
  })
})
