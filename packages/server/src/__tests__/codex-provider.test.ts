import { describe, expect, it } from "bun:test"
import {
  buildCodexThreadResumeParams,
  buildCodexThreadStartParams,
  buildCodexTurnStartParams,
  CODEX_APPROVAL_POLICY,
  CODEX_SANDBOX_MODE,
  CODEX_SANDBOX_POLICY,
} from "../agent/codex-provider"

describe("Codex provider config helpers", () => {
  it("starts new threads with Tangerine's full-access policy", () => {
    expect(buildCodexThreadStartParams({
      workdir: "/workspace/task",
      model: "gpt-5.4",
    })).toEqual({
      cwd: "/workspace/task",
      model: "gpt-5.4",
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
    })).toEqual({
      threadId: "thread-123",
      cwd: "/workspace/task",
      model: "gpt-5.4",
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
})
