import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import type { AgentHandle } from "../agent/provider"
import { applySystemPromptIfSupported } from "../cli/start"

function createHandle(setSystemPrompt?: AgentHandle["setSystemPrompt"]): AgentHandle {
  return {
    sendPrompt: () => Effect.void,
    setSystemPrompt,
    abort: () => Effect.void,
    subscribe: () => ({ unsubscribe() {} }),
    shutdown: () => Effect.void,
  }
}

describe("applySystemPromptIfSupported", () => {
  it("skips runtime reapplication when the session already has a native system prompt", async () => {
    let calls = 0
    const handle = createHandle(() =>
      Effect.sync(() => {
        calls++
        return true
      }),
    )

    await expect(applySystemPromptIfSupported(handle, ["[NOTE: test]"], true)).resolves.toBe(true)
    expect(calls).toBe(0)
  })

  it("applies the system prompt when the provider supports it and it was not applied yet", async () => {
    let calls = 0
    const handle = createHandle(() =>
      Effect.sync(() => {
        calls++
        return true
      }),
    )

    await expect(applySystemPromptIfSupported(handle, ["[NOTE: test]"])).resolves.toBe(true)
    expect(calls).toBe(1)
  })
})
