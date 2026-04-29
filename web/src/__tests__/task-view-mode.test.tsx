import { afterEach, describe, expect, mock, test } from "bun:test"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import { TaskChatSurface, TaskViewModeToggle, shouldSyncAgentTuiOnChatReturn } from "../components/TaskViewMode"

afterEach(() => cleanup())

describe("TaskViewModeToggle", () => {
  test("hides until the task has an agent session id", () => {
    render(<TaskViewModeToggle value="chat" agentSessionId={null} onChange={() => {}} />)

    expect(screen.queryByLabelText("Task view")).toBeNull()
  })

  test("switches between chat and TUI", () => {
    const onChange = mock(() => {})
    render(<TaskViewModeToggle value="chat" agentSessionId="sess-1" onChange={onChange} />)

    fireEvent.click(screen.getByRole("button", { name: "TUI" }))

    expect(onChange).toHaveBeenCalledWith("tui")
  })
})

describe("TaskChatSurface", () => {
  test("replaces chat with agent terminal in TUI mode", () => {
    render(
      <TaskChatSurface
        viewMode="tui"
        agentSessionId="sess-1"
        terminal={<div data-testid="agent-tui" data-ws-url="/api/tasks/task-1/agent-terminal">Agent TUI</div>}
      >
        <div>Chat window</div>
      </TaskChatSurface>,
    )

    expect(screen.queryByText("Chat window")).toBeNull()
    expect(screen.getByTestId("agent-tui").getAttribute("data-ws-url")).toBe("/api/tasks/task-1/agent-terminal")
  })

  test("keeps chat visible in chat mode", () => {
    render(
      <TaskChatSurface
        viewMode="chat"
        agentSessionId="sess-1"
        terminal={<div data-testid="agent-tui">Agent TUI</div>}
      >
        <div>Chat window</div>
      </TaskChatSurface>,
    )

    expect(screen.getByText("Chat window")).toBeTruthy()
    expect(screen.queryByTestId("agent-tui")).toBeNull()
  })
})

describe("shouldSyncAgentTuiOnChatReturn", () => {
  test("syncs only while the agent is active", () => {
    expect(shouldSyncAgentTuiOnChatReturn("running", false)).toBe(true)
    expect(shouldSyncAgentTuiOnChatReturn("failed", false)).toBe(false)
    expect(shouldSyncAgentTuiOnChatReturn("running", true)).toBe(false)
  })
})
