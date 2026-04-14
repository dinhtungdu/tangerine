import { afterEach, describe, expect, it, spyOn } from "bun:test"
import {
  buildCodexThreadResumeParams,
  buildCodexThreadStartParams,
  buildCodexTurnStartParams,
  CODEX_APPROVAL_POLICY,
  CODEX_SANDBOX_MODE,
  CODEX_SANDBOX_POLICY,
  createCodexProvider,
  mapNotification,
} from "../agent/codex-provider"
import { Effect } from "effect"

function makeMockSpawn(
  onRequest: (request: Record<string, unknown>, emit: (response: Record<string, unknown>) => void) => void,
): ReturnType<typeof Bun.spawn> {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  const encoder = new TextEncoder()

  const stdout = new ReadableStream<Uint8Array>({
    start(ctrl) {
      controller = ctrl
    },
  })

  const emit = (response: Record<string, unknown>) => {
    controller?.enqueue(encoder.encode(JSON.stringify(response) + "\n"))
  }

  return {
    stdin: {
      write(chunk: string) {
        for (const line of chunk.split("\n")) {
          if (!line.trim()) continue
          onRequest(JSON.parse(line) as Record<string, unknown>, emit)
        }
      },
      flush() {},
      end() {},
    },
    stdout,
    stderr: new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.close()
      },
    }),
    pid: 4242,
    exited: new Promise<number>(() => {}),
    kill() {
      controller?.close()
    },
  } as unknown as ReturnType<typeof Bun.spawn>
}

let spawnSpy: ReturnType<typeof spyOn> | null = null

afterEach(() => {
  spawnSpy?.mockRestore()
  spawnSpy = null
})

describe("Codex provider config helpers", () => {
  it("starts new threads with Tangerine's full-access policy", () => {
    expect(buildCodexThreadStartParams({
      workdir: "/workspace/task",
      model: "gpt-5.4",
      systemPrompt: "Be terse.",
    })).toEqual({
      cwd: "/workspace/task",
      model: "gpt-5.4",
      developerInstructions: "Be terse.",
      approvalPolicy: CODEX_APPROVAL_POLICY,
      sandbox: CODEX_SANDBOX_MODE,
      ephemeral: false,
    })
  })

  it("reapplies the same policy when resuming a thread", () => {
    expect(buildCodexThreadResumeParams({
      threadId: "thread-123",
      workdir: "/workspace/task",
      model: "gpt-5.4",
      systemPrompt: "Be terse.",
    })).toEqual({
      threadId: "thread-123",
      cwd: "/workspace/task",
      model: "gpt-5.4",
      developerInstructions: "Be terse.",
      approvalPolicy: CODEX_APPROVAL_POLICY,
      sandbox: CODEX_SANDBOX_MODE,
      persistExtendedHistory: false,
    })
  })

  it("reapplies the same policy on every turn after resume", () => {
    expect(buildCodexTurnStartParams({
      threadId: "thread-123",
      workdir: "/workspace/task",
      model: "gpt-5.4",
      input: [{ type: "text", text: "hello" }],
      effort: "medium",
    })).toEqual({
      threadId: "thread-123",
      input: [{ type: "text", text: "hello" }],
      cwd: "/workspace/task",
      model: "gpt-5.4",
      effort: "medium",
      approvalPolicy: CODEX_APPROVAL_POLICY,
      sandboxPolicy: CODEX_SANDBOX_POLICY,
    })
  })

  it("turn/completed emits only idle status (usage comes from token_count)", () => {
    const events = mapNotification("turn/completed", {
      turn: { usage: { prompt_tokens: 5000, completion_tokens: 1200 } },
    })
    expect(events).toEqual([{ kind: "status", status: "idle" }])
  })

  it("emits per-turn usage from token_count notification", () => {
    const events = mapNotification("token_count", {
      info: {
        last_token_usage: { input_tokens: 5000, output_tokens: 1200 },
        model_context_window: 128000, // Not used — max window, not current usage
      },
    })
    expect(events).toContainEqual({
      kind: "usage",
      inputTokens: 5000,
      outputTokens: 1200,
    })
  })

  it("includes cached and reasoning tokens in token_count", () => {
    const events = mapNotification("token_count", {
      info: {
        last_token_usage: {
          input_tokens: 3000,
          cached_input_tokens: 1000,
          output_tokens: 500,
          reasoning_output_tokens: 200,
        },
      },
    })
    expect(events).toContainEqual({
      kind: "usage",
      inputTokens: 4000, // 3000 + 1000 cached
      outputTokens: 700, // 500 + 200 reasoning
    })
  })

  it("skips usage event when token_count has no info", () => {
    const events = mapNotification("token_count", {})
    expect(events).toEqual([])
  })

  it("skips usage event when all tokens are zero", () => {
    const events = mapNotification("token_count", {
      info: {
        last_token_usage: { input_tokens: 0, output_tokens: 0 },
      },
    })
    expect(events).toEqual([])
  })

  it("creates the thread during provider startup so Tangerine can persist the session id", async () => {
    const requests: string[] = []
    spawnSpy = spyOn(Bun, "spawn").mockReturnValue(makeMockSpawn((request, emit) => {
      const method = typeof request.method === "string" ? request.method : null
      if (!method) return
      requests.push(method)

      if (method === "initialize") {
        emit({
          jsonrpc: "2.0",
          id: request.id,
          result: { userAgent: "codex-test" },
        })
        return
      }

      if (method === "thread/start") {
        emit({
          jsonrpc: "2.0",
          id: request.id,
          result: { thread: { id: "thread-started" } },
        })
      }
    }))

    const handle = await Effect.runPromise(createCodexProvider().start({
      taskId: "task-1",
      workdir: "/workspace/task",
      title: "Test task",
      model: "gpt-5.4",
      systemPrompt: "Be terse.",
    }))

    expect(requests).toContain("initialize")
    expect(requests).toContain("thread/start")
    expect((handle as { __meta?: { sessionId?: string | null } }).__meta?.sessionId).toBe("thread-started")

    await Effect.runPromise(handle.shutdown())
  })
})
