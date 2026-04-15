import { describe, test, expect, afterEach, beforeEach, mock } from "bun:test"
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react"

import React from "react"

// base-ui Portal components don't render in happy-dom, so mock them to render inline
type Props = Record<string, unknown> & { children?: React.ReactNode; className?: string; render?: unknown; placeholder?: string }

function makeBaseUIMock() {
  function Slot({ children, className, render: _r, ...rest }: Props) {
    return React.createElement("div", { className, ...rest }, children)
  }
  function Passthrough({ children }: Props) { return children ?? null }
  return {
    Slot,
    Passthrough,
    Root({ children, ...props }: Props) { return React.createElement("div", props, children) },
    Trigger({ children, className, ...props }: Props) {
      return React.createElement("button", { className, ...props }, children)
    },
    Portal: Passthrough,
    Positioner({ children }: Props) { return React.createElement("div", null, children) },
    Popup({ children, className, ...props }: Props) { return React.createElement("div", { className, ...props }, children) },
    Item({ children, className, ...props }: Props) {
      return React.createElement("div", { role: "menuitem", className, ...props }, children)
    },
    Group: Slot,
    GroupLabel: Slot,
    Separator({ className, ...props }: Props) { return React.createElement("hr", { className, ...props }) },
    Icon: Passthrough,
    Title: Slot,
    Description: Slot,
  }
}

mock.module("@base-ui/react/menu", () => {
  const { Slot, ...base } = makeBaseUIMock()
  return {
    Menu: {
      ...base,
      Root({ children }: Props) { return React.createElement(React.Fragment, null, children) },
      SubmenuRoot({ children }: Props) { return React.createElement(React.Fragment, null, children) },
      SubmenuTrigger: Slot,
      CheckboxItem: Slot,
      CheckboxItemIndicator({ children }: Props) { return children ?? null },
      RadioGroup: Slot,
      RadioItem: Slot,
      RadioItemIndicator({ children }: Props) { return children ?? null },
    },
  }
})

mock.module("@base-ui/react/popover", () => {
  const base = makeBaseUIMock()
  return { Popover: base }
})

mock.module("@base-ui/react/select", () => {
  const base = makeBaseUIMock()
  return {
    Select: {
      ...base,
      Root({ children, ...props }: Props) { return React.createElement("div", props, children) },
      Trigger({ children, className, ...props }: Props) {
        return React.createElement("button", { role: "combobox", className, ...props }, children)
      },
      Item({ children, className, ...props }: Props) {
        return React.createElement("button", { className, ...props }, children)
      },
      Value({ children, placeholder, className, ...props }: Props) {
        return React.createElement("span", { className, ...props }, children ?? placeholder)
      },
      ItemText({ children, className }: Props) { return React.createElement("span", { className }, children) },
      ItemIndicator({ children }: Props) { return React.createElement("span", null, children) },
      List({ children }: Props) { return React.createElement("div", null, children) },
      ScrollUpArrow({ children }: Props) { return React.createElement("div", null, children) },
      ScrollDownArrow({ children }: Props) { return React.createElement("div", null, children) },
    },
  }
})

import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { ActivityList } from "../components/ActivityList"
import { AuthenticatedImage } from "../components/AuthenticatedImage"
import { ChatMessage } from "../components/ChatMessage"
import { NewAgentForm } from "../components/NewAgentForm"
import { ChatInput, appendQuotedText } from "../components/ChatInput"
import { ChatPanel } from "../components/ChatPanel"
import { ModelSelector } from "../components/ModelSelector"
import { CommandPalette } from "../components/CommandPalette"
import { StatusPage } from "../pages/StatusPage"
import { TaskOverflowMenu } from "../components/TaskListItem"
import { ProjectProvider, useProject } from "../context/ProjectContext"
import { ToastProvider } from "../context/ToastContext"
import { _resetForTesting as resetActions, registerActions, setShortcutOverrides } from "../lib/actions"
import { defaultShortcuts } from "../lib/default-shortcuts"
import { cancelTask, retryTask, deleteTask } from "../lib/api"
import { useShortcuts } from "../hooks/useShortcuts"
import type { Task, ActivityEntry } from "@tangerine/shared"

function WithShortcuts({ children }: { children: import("react").ReactNode }) {
  useShortcuts()
  return <>{children}</>
}

function SwitchProjectButton({ name }: { name: string }) {
  const { switchProject } = useProject()
  return <button onClick={() => switchProject(name)}>Switch project</button>
}

function LocationDisplay() {
  const location = useLocation()
  return <div data-testid="location">{location.pathname}{location.search}</div>
}

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
    branch: null,
    worktreePath: null,
    prUrl: null,
    parentTaskId: null,
    userId: null,
    agentSessionId: null,
    agentPid: null,
    suspended: false,
    error: null,
    createdAt: "2026-03-17T10:00:00Z",
    updatedAt: "2026-03-17T10:00:00Z",
    startedAt: "2026-03-17T10:01:00Z",
    completedAt: null,
    lastSeenAt: null,
    lastResultAt: null,
    capabilities: ["resolve", "predefined-prompts", "diff"],
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
  resetActions()
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
    modelsByProvider: {
      "claude-code": ["anthropic/claude-sonnet-4-6", "anthropic/claude-haiku-4-20250414"],
      opencode: ["openai/gpt-5.4", "openai/gpt-5-mini"],
    },
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

function mockStatusPageFetch() {
  global.fetch = async (input) => {
    const url = typeof input === "string" ? input : input.url

    if (url === "/api/projects") {
      return new Response(JSON.stringify({
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
        modelsByProvider: {
          "claude-code": ["anthropic/claude-sonnet-4-6"],
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }

    if (url.startsWith("/api/tasks")) {
      return new Response(JSON.stringify([
        makeTask({ id: "task-123", title: "Queued task", status: "provisioning" }),
      ]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }

    if (url === "/api/cleanup/orphans") {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }

    if (url === "/api/projects/test-project/update-status") {
      return new Response(JSON.stringify({
        available: false,
        local: "abc12345",
        remote: "abc12345",
        checkedAt: "2026-03-17T10:00:00Z",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }

    if (url.startsWith("/api/logs")) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }

    return new Response("Not found", { status: 404 })
  }
}

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

describe("AuthenticatedImage", () => {
  test("exposes an accessible loading placeholder for protected images", () => {
    global.fetch = mock(() => new Promise(() => {})) as typeof fetch

    render(<AuthenticatedImage src="/api/tasks/t1/images/example.png" alt="Agent image" className="h-16 w-16" />)

    const placeholder = screen.getByRole("img", { name: "Agent image" })
    expect(placeholder.getAttribute("aria-busy")).toBe("true")
    expect(screen.getByText("Loading image")).toBeTruthy()
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

    // HarnessSelector renders a shadcn Select (role="combobox")
    await screen.findAllByText("Claude Code")
    const comboboxes = screen.getAllByRole("combobox")
    const harnessCombobox = comboboxes.find((el) => el.textContent?.includes("Claude Code"))
    expect(harnessCombobox).toBeTruthy()
    const controlsRow = harnessCombobox!.parentElement?.parentElement
    expect(controlsRow?.className.includes("overflow-visible")).toBe(true)

    // ModelSelector is a shadcn Select (role="combobox")
    const modelCombobox = comboboxes.find((el) => el.textContent?.includes("claude-sonnet-4-6"))
    expect(modelCombobox).toBeTruthy()

    // ReasoningEffortSelector is a shadcn Select (role="combobox")
    const effortCombobox = comboboxes.find((el) => el.textContent?.includes("Medium"))
    expect(effortCombobox).toBeTruthy()
  })

  test("restores new agent draft text, branch, and images from localStorage", async () => {
    mockProjectsFetch()
    window.localStorage.setItem("tangerine:new-agent-draft:test-project:new", JSON.stringify({
      description: "Restore this draft",
      customBranch: "feature/persist-draft",
      pendingImages: [{ mediaType: "image/png", data: "abc123", dataUrl: "data:image/png;base64,abc123" }],
    }))

    render(
      <MemoryRouter initialEntries={["/?project=test-project"]}>
        <ProjectProvider>
          <NewAgentForm onSubmit={() => {}} />
        </ProjectProvider>
      </MemoryRouter>
    )

    expect(await screen.findByDisplayValue("Restore this draft")).toBeTruthy()
    expect(screen.getAllByDisplayValue("feature/persist-draft")[0]).toBeTruthy()
    expect(screen.getByAltText("Pasted image")).toBeTruthy()
  })

  test("type selector defaults to worker and can be changed to reviewer", async () => {
    mockProjectsFetch()
    const submitted: { type?: string }[] = []

    render(
      <MemoryRouter initialEntries={["/?project=test-project"]}>
        <ProjectProvider>
          <NewAgentForm onSubmit={(data) => submitted.push({ type: data.type })} />
        </ProjectProvider>
      </MemoryRouter>
    )

    await screen.findByText("What should the agent work on?")
    // Flush the fetchProjects microtask so draftKey stabilizes before interacting
    await act(async () => {})

    // Default is worker (active toggle has shadow-sm class)
    const workerBtn = screen.getAllByText("Worker")[0]!
    const reviewerBtn = screen.getAllByText("Reviewer")[0]!
    expect(workerBtn.className).toContain("shadow-sm")
    expect(reviewerBtn.className).not.toContain("shadow-sm")

    // Click reviewer toggle
    fireEvent.click(reviewerBtn)
    await act(async () => {})
    expect(reviewerBtn.className).toContain("shadow-sm")
    expect(workerBtn.className).not.toContain("shadow-sm")
  })

  test("renders model selector as a Select combobox", () => {
    render(
      <ModelSelector
        model="anthropic/claude-sonnet-4-6"
        models={[
          "anthropic/claude-sonnet-4-6",
          "anthropic/claude-haiku-4-20250414",
          "openai/gpt-5.4",
        ]}
        onModelChange={() => {}}
      />,
    )

    const combobox = screen.getByRole("combobox")
    expect(combobox).toBeTruthy()
    expect(combobox.textContent).toContain("claude-sonnet-4-6")
  })
})

describe("StatusPage", () => {
  test("renders system status heading", async () => {
    mockStatusPageFetch()

    render(
      <MemoryRouter initialEntries={["/status?project=test-project"]}>
        <ProjectProvider>
          <ToastProvider>
            <Routes>
              <Route path="/status" element={<StatusPage />} />
            </Routes>
          </ToastProvider>
        </ProjectProvider>
      </MemoryRouter>
    )

    expect(await screen.findByText("System Status")).toBeTruthy()
  })
})

describe("ChatInput", () => {
  test("formats quoted text as a composer block", () => {
    expect(appendQuotedText("", "> quoted")).toBe("> quoted\n\n")
    expect(appendQuotedText("Already typing", "> quoted")).toBe("Already typing\n\n> quoted\n\n")
  })

  test("restores chat draft text and images from localStorage", () => {
    window.localStorage.setItem("tangerine:chat-draft:task-123", JSON.stringify({
      text: "Keep typing",
      pendingImages: [{ mediaType: "image/png", data: "xyz987", dataUrl: "data:image/png;base64,xyz987" }],
    }))

    render(
      <ChatInput
        onSend={() => {}}
        disabled={false}
        queueLength={0}
        taskId="task-123"
      />
    )

    expect(screen.getByDisplayValue("Keep typing")).toBeTruthy()
    expect(screen.getByAltText("Pasted image")).toBeTruthy()
  })

  test("isolates drafts when switching between tasks", () => {
    window.localStorage.setItem("tangerine:chat-draft:task-A", JSON.stringify({ text: "Draft for A" }))
    window.localStorage.setItem("tangerine:chat-draft:task-B", JSON.stringify({ text: "Draft for B" }))

    // Remounting via key (as ChatPanel does) is what isolates drafts between tasks.
    // Each unmount triggers save-on-unmount, each mount loads from localStorage.
    const { unmount } = render(
      <ChatInput onSend={() => {}} disabled={false} queueLength={0} taskId="task-A" />
    )
    expect(screen.getByDisplayValue("Draft for A")).toBeTruthy()

    // Switch to task B — unmount A (saves draft), mount B (loads its draft)
    unmount()
    render(<ChatInput onSend={() => {}} disabled={false} queueLength={0} taskId="task-B" />)
    expect(screen.getByDisplayValue("Draft for B")).toBeTruthy()
  })

  // Duplicate ChatInput instances no longer occur — TaskDetail renders a single
  // ChatPanel for both mobile and desktop via responsive CSS classes.

  test("shows quote chip when quotedMessage is provided", () => {
    render(
      <ChatInput
        onSend={() => {}}
        disabled={false}
        queueLength={0}
        quotedMessage="> quoted line"
        onQuoteDismiss={() => {}}
      />
    )
    expect(screen.getByText("> quoted line")).toBeTruthy()
    expect(screen.getByLabelText("Dismiss quote")).toBeTruthy()
  })
})

describe("ChatPanel", () => {
  test("shows error message in terminated banner for failed tasks", () => {
    render(
      <MemoryRouter>
        <ChatPanel
          messages={[]}
          agentStatus="idle"
          queueLength={0}
          taskStatus="failed"
          taskError="Payment Required: deactivated_workspace"
          onSend={() => {}}
          onAbort={() => {}}
        />
      </MemoryRouter>
    )

    expect(screen.getByText("Payment Required: deactivated_workspace")).toBeTruthy()
  })

  test("shows Mark as done button for failed tasks when onResolve provided", () => {
    render(
      <MemoryRouter>
        <ChatPanel
          messages={[]}
          agentStatus="idle"
          queueLength={0}
          taskStatus="failed"
          onSend={() => {}}
          onAbort={() => {}}
          onResolve={async () => {}}
        />
      </MemoryRouter>
    )

    expect(screen.getByText("Mark as done")).toBeTruthy()
  })

  test("shows Mark as done button for cancelled tasks when onResolve provided", () => {
    render(
      <MemoryRouter>
        <ChatPanel
          messages={[]}
          agentStatus="idle"
          queueLength={0}
          taskStatus="cancelled"
          onSend={() => {}}
          onAbort={() => {}}
          onResolve={async () => {}}
        />
      </MemoryRouter>
    )

    expect(screen.getByText("Mark as done")).toBeTruthy()
  })

  test("does not show Mark as done button for done tasks", () => {
    render(
      <MemoryRouter>
        <ChatPanel
          messages={[]}
          agentStatus="idle"
          queueLength={0}
          taskStatus="done"
          onSend={() => {}}
          onAbort={() => {}}
          onResolve={async () => {}}
        />
      </MemoryRouter>
    )

    expect(screen.queryByText("Mark as done")).toBeNull()
  })

  test("does not show error in terminated banner for done tasks", () => {
    render(
      <MemoryRouter>
        <ChatPanel
          messages={[]}
          agentStatus="idle"
          queueLength={0}
          taskStatus="done"
          taskError="some error"
          onSend={() => {}}
          onAbort={() => {}}
        />
      </MemoryRouter>
    )

    expect(screen.queryByText("some error")).toBeNull()
  })

  test("clicking Reply on a message shows the quote chip above the input", async () => {
    render(
      <MemoryRouter>
        <ChatPanel
          messages={[{ id: "m1", role: "agent", content: "Quoted text", timestamp: "2026-03-17T10:00:00Z" }]}
          agentStatus="idle"
          queueLength={0}
          onSend={() => {}}
          onAbort={() => {}}
        />
      </MemoryRouter>
    )

    // Wait for virtualized message to render
    const replyBtn = await screen.findByLabelText("Reply")
    fireEvent.click(replyBtn)

    // Quote chip appears above the input
    expect(screen.getByLabelText("Dismiss quote")).toBeTruthy()
  })

  test("Quote button appears when selectedText is passed to ChatInput", () => {
    render(
      <ChatInput
        onSend={() => {}}
        disabled={false}
        queueLength={0}
        selectedText="some selected text"
        onQuoteSelection={() => {}}
      />
    )

    expect(screen.getByText("Quote")).toBeTruthy()
  })

  test("Quote button hidden when no selectedText", () => {
    render(
      <ChatInput
        onSend={() => {}}
        disabled={false}
        queueLength={0}
        selectedText={null}
        onQuoteSelection={() => {}}
      />
    )

    expect(screen.queryByText("Quote")).toBeNull()
  })
})

describe("CommandPalette", () => {
  beforeEach(() => {
    setShortcutOverrides(defaultShortcuts)
  })

  function mockTasksFetch(tasks: Task[] = []) {
    global.fetch = async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url
      if (url.startsWith("/api/tasks")) {
        return new Response(JSON.stringify(tasks), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      return new Response("Not found", { status: 404 })
    }
  }

  test("opens on Ctrl+K and shows search input", async () => {
    mockTasksFetch([])
    render(
      <MemoryRouter>
        <WithShortcuts>
          <CommandPalette />
        </WithShortcuts>
      </MemoryRouter>
    )

    expect(screen.queryByPlaceholderText("Search tasks and actions...")).toBeNull()

    await act(async () => {
      fireEvent.keyDown(document, { key: "k", ctrlKey: true })
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(screen.getByPlaceholderText("Search tasks and actions...")).toBeTruthy()
  })

  test("closes on Escape", async () => {
    mockTasksFetch([])
    render(
      <MemoryRouter>
        <WithShortcuts>
          <CommandPalette />
        </WithShortcuts>
      </MemoryRouter>
    )

    await act(async () => {
      fireEvent.keyDown(document, { key: "k", ctrlKey: true })
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(screen.getByPlaceholderText("Search tasks and actions...")).toBeTruthy()

    fireEvent.keyDown(document, { key: "Escape" })
    expect(screen.queryByPlaceholderText("Search tasks and actions...")).toBeNull()
  })

  test("shows active tasks by default", async () => {
    mockTasksFetch([
      makeTask({ id: "run1", title: "Active task", status: "running", projectId: "proj-a" }),
      makeTask({ id: "done1", title: "Done task", status: "done", projectId: "proj-a" }),
    ])

    render(
      <MemoryRouter>
        <WithShortcuts>
          <CommandPalette />
        </WithShortcuts>
      </MemoryRouter>
    )

    await act(async () => {
      fireEvent.keyDown(document, { key: "k", ctrlKey: true })
      await new Promise((r) => setTimeout(r, 50))
    })

    expect(screen.getByText("Active task")).toBeTruthy()
    expect(screen.queryByText("Done task")).toBeNull()
  })

  test("shows done tasks when searching", async () => {
    mockTasksFetch([
      makeTask({ id: "done1", title: "Finished feature", status: "done", projectId: "proj-a" }),
    ])

    render(
      <MemoryRouter>
        <WithShortcuts>
          <CommandPalette />
        </WithShortcuts>
      </MemoryRouter>
    )

    await act(async () => {
      fireEvent.keyDown(document, { key: "k", ctrlKey: true })
      await new Promise((r) => setTimeout(r, 50))
    })

    const input = screen.getByPlaceholderText("Search tasks and actions...")
    fireEvent.change(input, { target: { value: "finished" } })

    expect(screen.getByText("Finished feature")).toBeTruthy()
  })

  test("shows empty state when no active tasks", async () => {
    mockTasksFetch([])
    render(
      <MemoryRouter>
        <WithShortcuts>
          <CommandPalette />
        </WithShortcuts>
      </MemoryRouter>
    )

    await act(async () => {
      fireEvent.keyDown(document, { key: "k", ctrlKey: true })
      await new Promise((r) => setTimeout(r, 50))
    })

    expect(screen.getByText("No active tasks")).toBeTruthy()
  })

  test("shows no matching message when query has no results", async () => {
    mockTasksFetch([
      makeTask({ id: "t1", title: "Fix login", status: "running" }),
    ])

    render(
      <MemoryRouter>
        <WithShortcuts>
          <CommandPalette />
        </WithShortcuts>
      </MemoryRouter>
    )

    await act(async () => {
      fireEvent.keyDown(document, { key: "k", ctrlKey: true })
      await new Promise((r) => setTimeout(r, 50))
    })

    const input = screen.getByPlaceholderText("Search tasks and actions...")
    fireEvent.change(input, { target: { value: "zzznomatch" } })

    expect(screen.getByText("No results")).toBeTruthy()
  })

  test("navigates to task on click", async () => {
    mockTasksFetch([
      makeTask({ id: "abc12345", title: "Click me", status: "running" }),
    ])

    render(
      <MemoryRouter initialEntries={["/"]}>
        <WithShortcuts>
          <Routes>
            <Route path="/" element={<CommandPalette />} />
            <Route path="/tasks/abc12345" element={<div>Task Detail</div>} />
          </Routes>
        </WithShortcuts>
      </MemoryRouter>
    )

    await act(async () => {
      fireEvent.keyDown(document, { key: "k", ctrlKey: true })
      await new Promise((r) => setTimeout(r, 50))
    })

    fireEvent.click(screen.getByText("Click me"))
    expect(screen.getByText("Task Detail")).toBeTruthy()
  })

  test("shows task type badge for orchestrator tasks", async () => {
    mockTasksFetch([
      makeTask({ id: "orch1", title: "Orchestrator task", status: "running", type: "orchestrator" }),
    ])

    render(
      <MemoryRouter>
        <WithShortcuts>
          <CommandPalette />
        </WithShortcuts>
      </MemoryRouter>
    )

    await act(async () => {
      fireEvent.keyDown(document, { key: "k", ctrlKey: true })
      await new Promise((r) => setTimeout(r, 50))
    })

    expect(screen.getByText("orchestrator")).toBeTruthy()
  })
})

describe("ProjectProvider", () => {
  test("switches task pages to the most recent active task in the target project", async () => {
    global.fetch = async (input) => {
      const url = typeof input === "string" ? input : input.url

      if (url === "/api/projects") {
        return new Response(JSON.stringify({
          projects: [
            { name: "proj-a", repo: "org/a", defaultBranch: "main", setup: "echo ok", defaultProvider: "claude-code" },
            { name: "proj-b", repo: "org/b", defaultBranch: "main", setup: "echo ok", defaultProvider: "claude-code" },
          ],
          model: "anthropic/claude-sonnet-4-6",
          modelsByProvider: { "claude-code": ["anthropic/claude-sonnet-4-6"] },
        }), { status: 200, headers: { "Content-Type": "application/json" } })
      }

      if (url === "/api/tasks?project=proj-b") {
        return new Response(JSON.stringify([
          makeTask({ id: "done-1", projectId: "proj-b", status: "done", updatedAt: "2026-03-17T12:00:00Z" }),
          makeTask({ id: "active-old", projectId: "proj-b", status: "running", updatedAt: "2026-03-17T11:00:00Z" }),
          makeTask({ id: "active-new", projectId: "proj-b", status: "provisioning", updatedAt: "2026-03-17T13:00:00Z" }),
        ]), { status: 200, headers: { "Content-Type": "application/json" } })
      }

      return new Response("Not found", { status: 404 })
    }

    render(
      <MemoryRouter initialEntries={["/tasks/current?project=proj-a"]}>
        <ProjectProvider>
          <Routes>
            <Route path="/tasks/:id" element={<><SwitchProjectButton name="proj-b" /><LocationDisplay /></>} />
          </Routes>
        </ProjectProvider>
      </MemoryRouter>
    )

    await screen.findByText("Switch project")

    await act(async () => {
      fireEvent.click(screen.getByText("Switch project"))
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(screen.queryByText("Switch project")).toBeTruthy()
    expect(screen.getByTestId("location").textContent).toBe("/tasks/active-new?project=proj-b")
  })
})

describe("ChatMessage", async () => {
  const { ChatMessage } = await import("../components/ChatMessage")

  function renderChat(props: Parameters<typeof ChatMessage>[0]) {
    return render(<MemoryRouter><ChatMessage {...props} /></MemoryRouter>)
  }

  test("renders markdown tables as HTML tables", () => {
    const tableContent = "| Feature | Status |\n|---|---|\n| Tables | Yes |\n| Bold | Yes |"
    renderChat({
        message: {
          role: "assistant",
          content: tableContent,
          timestamp: "2026-03-17T10:00:00Z",
        },
      })

    const table = document.querySelector("table")
    expect(table).toBeTruthy()
    expect(table!.querySelectorAll("th").length).toBe(2)
    expect(table!.querySelectorAll("td").length).toBe(4)
    expect(table!.querySelector("th")!.textContent).toBe("Feature")
  })

  test("renders tables mixed with other markdown", () => {
    const content = "Here is a comparison:\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nDone."
    renderChat({
      message: {
        role: "assistant",
        content: content,
        timestamp: "2026-03-17T10:00:00Z",
      },
    })

    expect(document.querySelector("table")).toBeTruthy()
    expect(document.body.textContent).toContain("Here is a comparison:")
    expect(document.body.textContent).toContain("Done.")
  })

  test("renders headings", () => {
    renderChat({
      message: { role: "assistant", content: "# Title\n## Subtitle\n### Section", timestamp: "2026-03-17T10:00:00Z" },
    })
    expect(document.querySelector("h1")!.textContent).toBe("Title")
    expect(document.querySelector("h2")!.textContent).toBe("Subtitle")
    expect(document.querySelector("h3")!.textContent).toBe("Section")
  })

  test("renders unordered lists", () => {
    renderChat({
      message: { role: "assistant", content: "- First\n- Second\n- Third", timestamp: "2026-03-17T10:00:00Z" },
    })
    const items = document.querySelectorAll("li")
    expect(items.length).toBe(3)
    expect(items[0]!.textContent).toBe("First")
  })

  test("renders ordered lists", () => {
    renderChat({
      message: { role: "assistant", content: "1. One\n2. Two\n3. Three", timestamp: "2026-03-17T10:00:00Z" },
    })
    expect(document.querySelector("ol")).toBeTruthy()
    expect(document.querySelectorAll("li").length).toBe(3)
  })

  test("renders blockquotes", () => {
    renderChat({
      message: { role: "assistant", content: "> This is a quote", timestamp: "2026-03-17T10:00:00Z" },
    })
    expect(document.querySelector("blockquote")!.textContent).toContain("This is a quote")
  })

  test("renders horizontal rules", () => {
    renderChat({
      message: { role: "assistant", content: "Above\n\n---\n\nBelow", timestamp: "2026-03-17T10:00:00Z" },
    })
    expect(document.querySelector("hr")).toBeTruthy()
  })

  test("renders strikethrough", () => {
    renderChat({
      message: { role: "assistant", content: "~~deleted~~", timestamp: "2026-03-17T10:00:00Z" },
    })
    expect(document.querySelector("del")!.textContent).toBe("deleted")
  })

  test("linkifies task UUID inside inline code (backticks)", () => {
    const taskId = "abc12345-0000-0000-0000-000000000001"
    renderChat({
      message: { role: "assistant", content: `See \`${taskId}\` for details`, timestamp: "2026-03-17T10:00:00Z" },
      tasks: [{ id: taskId }] as Parameters<typeof ChatMessage>[0]["tasks"],
    })
    const link = document.querySelector(`a[href="/tasks/${taskId}"]`)
    expect(link).toBeTruthy()
    expect(link!.textContent).toBe("abc12345")
  })

  test("linkifies task UUID mixed with other text in inline code", () => {
    const taskId = "abc12345-0000-0000-0000-000000000001"
    renderChat({
      message: { role: "assistant", content: `Run \`task ${taskId}\` now`, timestamp: "2026-03-17T10:00:00Z" },
      tasks: [{ id: taskId }] as Parameters<typeof ChatMessage>[0]["tasks"],
    })
    const link = document.querySelector(`a[href="/tasks/${taskId}"]`)
    expect(link).toBeTruthy()
    expect(link!.textContent).toBe("abc12345")
    // The "task " prefix should remain as inline code
    const codes = document.querySelectorAll("code")
    expect(Array.from(codes).some((c) => c.textContent === "task ")).toBe(true)
  })

  test("does not linkify task UUID followed by path segment in inline code", () => {
    const taskId = "abc12345-0000-0000-0000-000000000001"
    renderChat({
      message: { role: "assistant", content: `Check \`${taskId}/logs\``, timestamp: "2026-03-17T10:00:00Z" },
      tasks: [{ id: taskId }] as Parameters<typeof ChatMessage>[0]["tasks"],
    })
    const link = document.querySelector(`a[href="/tasks/${taskId}"]`)
    expect(link).toBeNull()
    const code = document.querySelector("code")
    expect(code!.textContent).toContain(`${taskId}/logs`)
  })

  test("does not linkify task UUID in API path inside inline code", () => {
    const taskId = "abc12345-0000-0000-0000-000000000001"
    renderChat({
      message: { role: "assistant", content: `Call \`/api/tasks/${taskId}\``, timestamp: "2026-03-17T10:00:00Z" },
      tasks: [{ id: taskId }] as Parameters<typeof ChatMessage>[0]["tasks"],
    })
    const link = document.querySelector(`a[href="/tasks/${taskId}"]`)
    expect(link).toBeNull()
    // Should remain as plain inline code
    const code = document.querySelector("code")
    expect(code).toBeTruthy()
    expect(code!.textContent).toContain(`/api/tasks/${taskId}`)
  })
})

describe("ToastProvider", () => {
  test("renders children without toasts initially", () => {
    render(
      <ToastProvider>
        <span>content</span>
      </ToastProvider>
    )
    expect(screen.getByText("content")).toBeTruthy()
    // No error toast visible yet
    expect(screen.queryByRole("img")).toBeNull()
  })
})

describe("TaskOverflowMenu error toasts", () => {
  beforeEach(() => {
    registerActions([
      { id: "task.cancel", label: "Cancel task", hidden: true, handler: async (args) => { const taskId = args?.taskId as string | undefined; if (taskId) await cancelTask(taskId) } },
      { id: "task.retry", label: "Retry task", hidden: true, handler: async (args) => { const taskId = args?.taskId as string | undefined; if (taskId) await retryTask(taskId) } },
      { id: "task.delete", label: "Delete task", hidden: true, handler: async (args) => { const taskId = args?.taskId as string | undefined; if (taskId) await deleteTask(taskId) } },
    ])
  })

  test("shows error toast when cancel fails", async () => {
    global.fetch = async () => new Response("Server error", { status: 500 })

    const task = makeTask({ status: "running" })
    render(
      <ToastProvider>
        <TaskOverflowMenu task={task} />
      </ToastProvider>
    )

    fireEvent.click(screen.getByLabelText("Task actions"))
    await act(async () => {
      fireEvent.click(screen.getByText("Cancel"))
    })

    expect(screen.getByText("Failed to cancel task")).toBeTruthy()
  })

  test("shows error toast when retry fails", async () => {
    global.fetch = async () => new Response("Server error", { status: 500 })

    const task = makeTask({ status: "failed" })
    render(
      <ToastProvider>
        <TaskOverflowMenu task={task} />
      </ToastProvider>
    )

    fireEvent.click(screen.getByLabelText("Task actions"))
    await act(async () => {
      fireEvent.click(screen.getByText("Retry"))
    })

    expect(screen.getByText("Failed to retry task")).toBeTruthy()
  })

  test("shows error toast when delete fails", async () => {
    global.fetch = async () => new Response("Server error", { status: 500 })

    const task = makeTask({ status: "done" })
    render(
      <ToastProvider>
        <TaskOverflowMenu task={task} />
      </ToastProvider>
    )

    fireEvent.click(screen.getByLabelText("Task actions"))
    await act(async () => {
      fireEvent.click(screen.getByText("Delete"))
    })

    expect(screen.getByText("Failed to delete task")).toBeTruthy()
  })
})

describe("ChatMessage inline actions", () => {
  function makeMsg(overrides?: Partial<{ id: string; role: string; content: string; timestamp: string }>) {
    return {
      id: "msg1",
      role: "agent",
      content: "Hello world",
      timestamp: new Date().toISOString(),
      ...overrides,
    }
  }

  function renderMsg(props: Parameters<typeof ChatMessage>[0]) {
    return render(<MemoryRouter><ChatMessage {...props} /></MemoryRouter>)
  }

  test("renders Reply button for agent message when onReply provided", () => {
    renderMsg({ message: makeMsg(), onReply: () => {} })
    expect(screen.getByLabelText("Reply")).toBeTruthy()
  })

  test("renders Reply button for user message when onReply provided", () => {
    renderMsg({ message: makeMsg({ role: "user" }), onReply: () => {} })
    expect(screen.getByLabelText("Reply")).toBeTruthy()
  })

  test("Reply button calls onReply with message content", () => {
    let replied = ""
    renderMsg({ message: makeMsg({ content: "test content" }), onReply: (c) => { replied = c } })
    fireEvent.click(screen.getByLabelText("Reply"))
    expect(replied).toBe("test content")
  })

  test("omits Reply button when onReply not provided", () => {
    renderMsg({ message: makeMsg() })
    expect(screen.queryByLabelText("Reply")).toBeNull()
  })

  test("does not render actions for system messages", () => {
    renderMsg({ message: makeMsg({ role: "system", content: "Task started" }), onReply: () => {} })
    expect(screen.queryByLabelText("Reply")).toBeNull()
  })

  test("does not render actions for tool call messages", () => {
    renderMsg({ message: makeMsg({ role: "agent", content: JSON.stringify({ tool: "bash", input: {} }) }), onReply: () => {} })
    expect(screen.queryByLabelText("Reply")).toBeNull()
  })

  test("no actions when message has no content", () => {
    renderMsg({ message: makeMsg({ content: "" }), onReply: () => {} })
    expect(screen.queryByLabelText("Reply")).toBeNull()
  })

  test("action buttons are data-driven — Reply button is a BUTTON element", () => {
    renderMsg({ message: makeMsg(), onReply: () => {} })
    expect(screen.getByLabelText("Reply").tagName).toBe("BUTTON")
  })
})

describe("ChatInput quote chip", () => {
  test("renders quick reply chips with a solid background", () => {
    render(
      <ChatInput
        onSend={() => {}}
        disabled={false}
        queueLength={0}
        predefinedPrompts={[{ label: "Reply", text: "reply now" }]}
      />
    )
    const chip = screen.getByRole("button", { name: "Reply" })
    expect(chip.className).toContain("bg-muted")
    expect(chip.className).toContain("border-transparent")
  })

  test("shows quote chip when quotedMessage is set", () => {
    render(
      <ChatInput
        onSend={() => {}}
        disabled={false}
        queueLength={0}
        quotedMessage="Hello from agent"
        onQuoteDismiss={() => {}}
      />
    )
    expect(screen.getByText("Hello from agent")).toBeTruthy()
    expect(screen.getByLabelText("Dismiss quote")).toBeTruthy()
  })

  test("truncates long quoted message in chip preview", () => {
    const long = "A".repeat(80)
    render(
      <ChatInput
        onSend={() => {}}
        disabled={false}
        queueLength={0}
        quotedMessage={long}
        onQuoteDismiss={() => {}}
      />
    )
    // Chip shows truncated text (60 chars + ellipsis)
    expect(screen.getByText(`${"A".repeat(60)}…`)).toBeTruthy()
  })

  test("dismiss button calls onQuoteDismiss", () => {
    let dismissed = false
    render(
      <ChatInput
        onSend={() => {}}
        disabled={false}
        queueLength={0}
        quotedMessage="Some reply"
        onQuoteDismiss={() => { dismissed = true }}
      />
    )
    fireEvent.click(screen.getByLabelText("Dismiss quote"))
    expect(dismissed).toBe(true)
  })

  test("does not show chip when quotedMessage is null", () => {
    render(
      <ChatInput
        onSend={() => {}}
        disabled={false}
        queueLength={0}
        quotedMessage={null}
        onQuoteDismiss={() => {}}
      />
    )
    expect(screen.queryByLabelText("Dismiss quote")).toBeNull()
  })

  test("send with quotedMessage prepends quote and clears it", () => {
    let sent = ""
    let dismissed = false
    render(
      <ChatInput
        onSend={(t) => { sent = t }}
        disabled={false}
        queueLength={0}
        quotedMessage="agent reply"
        onQuoteDismiss={() => { dismissed = true }}
      />
    )
    const textarea = screen.getByRole("textbox")
    fireEvent.change(textarea, { target: { value: "my response" } })
    fireEvent.keyDown(textarea, { key: "Enter" })
    expect(sent).toBe("> agent reply\n\nmy response")
    expect(dismissed).toBe(true)
  })

  test("send with only quotedMessage and empty textarea sends the quote alone", () => {
    let sent = ""
    render(
      <ChatInput
        onSend={(t) => { sent = t }}
        disabled={false}
        queueLength={0}
        quotedMessage="just quote"
        onQuoteDismiss={() => {}}
      />
    )
    const textarea = screen.getByRole("textbox")
    fireEvent.keyDown(textarea, { key: "Enter" })
    expect(sent).toBe("> just quote")
  })
})
