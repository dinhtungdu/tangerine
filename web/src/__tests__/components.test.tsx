import { describe, test, expect, afterEach } from "bun:test"
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { RunCard } from "../components/RunCard"
import { ActivityList } from "../components/ActivityList"
import { NewAgentForm } from "../components/NewAgentForm"
import { ChatInput, appendQuotedText } from "../components/ChatInput"
import { ChatPanel } from "../components/ChatPanel"
import { ModelSelector } from "../components/ModelSelector"
import { StatusPage } from "../pages/StatusPage"
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
    branch: null,
    worktreePath: null,
    prUrl: null,
    type: "code",
    parentTaskId: null,
    userId: null,
    agentSessionId: null,
    agentPid: null,
    error: null,
    createdAt: "2026-03-17T10:00:00Z",
    updatedAt: "2026-03-17T10:00:00Z",
    startedAt: "2026-03-17T10:01:00Z",
    completedAt: null,
    lastSeenAt: null,
    lastResultAt: null,
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
        models: ["anthropic/claude-sonnet-4-6"],
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

  test("supports fuzzy model search in the selector", () => {
    render(
      <ModelSelector
        model="anthropic/claude-sonnet-4-6"
        models={[
          "anthropic/claude-sonnet-4-6",
          "anthropic/claude-haiku-4-20250414",
          "openai/gpt-5.4",
          "openai/gpt-5-mini",
          "google/gemini-2.5-pro",
          "openrouter/deepseek-r1",
        ]}
        onModelChange={() => {}}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "anthropic/claude-sonnet-4-6" }))
    fireEvent.change(screen.getByPlaceholderText("Search models..."), { target: { value: "g54" } })

    expect(screen.getByRole("button", { name: "openai/gpt-5.4" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "openai/gpt-5-mini" })).toBeNull()
  })
})

describe("StatusPage", () => {
  test("sidebar New Agent button navigates to the new agent route", async () => {
    mockStatusPageFetch()

    render(
      <MemoryRouter initialEntries={["/status?project=test-project"]}>
        <ProjectProvider>
          <Routes>
            <Route path="/status" element={<StatusPage />} />
            <Route path="/new" element={<div>New Agent Route</div>} />
          </Routes>
        </ProjectProvider>
      </MemoryRouter>
    )

    await screen.findByText("System Status")

    fireEvent.click(screen.getByRole("button", { name: "New Agent" }))

    expect(await screen.findByText("New Agent Route")).toBeTruthy()
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

  test("applies quoted text and focuses the composer", async () => {
    await act(async () => {
      render(
        <ChatInput
          onSend={() => {}}
          disabled={false}
          queueLength={0}
          draftInsert={{ id: 1, text: "> quoted line" }}
        />
      )

      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const textarea = screen.getByPlaceholderText("Message agent...") as HTMLTextAreaElement
    expect(textarea.value).toBe("> quoted line\n\n")
    expect(document.activeElement).toBe(textarea)
  })
})

describe("ChatPanel", () => {
  test("quotes selected message text into the composer", async () => {
    render(
      <MemoryRouter>
        <ChatPanel
          messages={[{ id: "m1", role: "assistant", content: "Quoted text", timestamp: "2026-03-17T10:00:00Z" }]}
          agentStatus="idle"
          queueLength={0}
          onSend={() => {}}
          onAbort={() => {}}
        />
      </MemoryRouter>
    )

    const message = screen.getByText("Quoted text")
    const textNode = message.firstChild
    let cleared = false

    const selection = {
      rangeCount: 1,
      isCollapsed: false,
      anchorNode: textNode,
      focusNode: textNode,
      toString: () => "Quoted text",
      getRangeAt: () => ({
        getBoundingClientRect: () => ({ top: 80, left: 120, width: 100, height: 20 }),
      }),
      removeAllRanges: () => {
        cleared = true
      },
    }

    Object.defineProperty(window, "getSelection", {
      configurable: true,
      value: () => selection,
    })

    await act(async () => {
      document.dispatchEvent(new Event("selectionchange"))
    })

    fireEvent.click(await screen.findByText("Quote"))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const textarea = screen.getByPlaceholderText("Message agent...") as HTMLTextAreaElement
    expect(textarea.value).toBe("> Quoted text\n\n")
    expect(document.activeElement).toBe(textarea)
    expect(cleared).toBe(true)
  })
})

describe("ChatMessage", async () => {
  const { ChatMessage } = await import("../components/ChatMessage")

  test("renders markdown tables as HTML tables", () => {
    const tableContent = "| Feature | Status |\n|---|---|\n| Tables | Yes |\n| Bold | Yes |"
    render(
      <ChatMessage
        message={{
          role: "assistant",
          content: tableContent,
          timestamp: "2026-03-17T10:00:00Z",
        }}
      />,
    )

    const table = document.querySelector("table")
    expect(table).toBeTruthy()
    expect(table!.querySelectorAll("th").length).toBe(2)
    expect(table!.querySelectorAll("td").length).toBe(4)
    expect(table!.querySelector("th")!.textContent).toBe("Feature")
  })

  test("renders tables mixed with other markdown", () => {
    const content = "Here is a comparison:\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nDone."
    render(
      <ChatMessage
        message={{
          role: "assistant",
          content: content,
          timestamp: "2026-03-17T10:00:00Z",
        }}
      />,
    )

    expect(document.querySelector("table")).toBeTruthy()
    expect(document.body.textContent).toContain("Here is a comparison:")
    expect(document.body.textContent).toContain("Done.")
  })

  test("renders headings", () => {
    render(
      <ChatMessage
        message={{ role: "assistant", content: "# Title\n## Subtitle\n### Section", timestamp: "2026-03-17T10:00:00Z" }}
      />,
    )
    expect(document.querySelector("h1")!.textContent).toBe("Title")
    expect(document.querySelector("h2")!.textContent).toBe("Subtitle")
    expect(document.querySelector("h3")!.textContent).toBe("Section")
  })

  test("renders unordered lists", () => {
    render(
      <ChatMessage
        message={{ role: "assistant", content: "- First\n- Second\n- Third", timestamp: "2026-03-17T10:00:00Z" }}
      />,
    )
    const items = document.querySelectorAll("li")
    expect(items.length).toBe(3)
    expect(items[0]!.textContent).toBe("First")
  })

  test("renders ordered lists", () => {
    render(
      <ChatMessage
        message={{ role: "assistant", content: "1. One\n2. Two\n3. Three", timestamp: "2026-03-17T10:00:00Z" }}
      />,
    )
    expect(document.querySelector("ol")).toBeTruthy()
    expect(document.querySelectorAll("li").length).toBe(3)
  })

  test("renders blockquotes", () => {
    render(
      <ChatMessage
        message={{ role: "assistant", content: "> This is a quote", timestamp: "2026-03-17T10:00:00Z" }}
      />,
    )
    expect(document.querySelector("blockquote")!.textContent).toContain("This is a quote")
  })

  test("renders horizontal rules", () => {
    render(
      <ChatMessage
        message={{ role: "assistant", content: "Above\n\n---\n\nBelow", timestamp: "2026-03-17T10:00:00Z" }}
      />,
    )
    expect(document.querySelector("hr")).toBeTruthy()
  })

  test("renders strikethrough", () => {
    render(
      <ChatMessage
        message={{ role: "assistant", content: "~~deleted~~", timestamp: "2026-03-17T10:00:00Z" }}
      />,
    )
    expect(document.querySelector("del")!.textContent).toBe("deleted")
  })
})
