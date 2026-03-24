// Agent provider abstraction: defines the contract that both OpenCode and Claude Code
// (and future providers) must implement. Decouples task lifecycle from any specific agent.

import type { Effect } from "effect"
import type { AgentError, PromptError, SessionStartError } from "../errors"

export type ProviderType = "opencode" | "claude-code"

/** Normalized events emitted by all agent providers */
export type AgentEvent =
  | { kind: "message.streaming"; content: string; messageId?: string }
  | { kind: "message.complete"; role: "assistant" | "user"; content: string; messageId?: string }
  | { kind: "status"; status: "idle" | "working" }
  | { kind: "error"; message: string }
  | { kind: "tool.start"; toolName: string; toolInput?: string }
  | { kind: "tool.end"; toolName: string; toolResult?: string }
  | { kind: "thinking"; content: string }

/** Runtime config that can be changed mid-session */
export interface AgentConfig {
  model?: string
  reasoningEffort?: string
}

/** Handle to a running agent session — owns the process, tunnel, and event subscription */
export interface AgentHandle {
  sendPrompt(text: string): Effect.Effect<void, PromptError>
  abort(): Effect.Effect<void, AgentError>
  subscribe(onEvent: (e: AgentEvent) => void): { unsubscribe(): void }
  shutdown(): Effect.Effect<void, never>
  /**
   * Apply config changes without restarting the agent process.
   * Returns true if the change was applied successfully.
   * If not implemented, the manager falls back to shutdown + restart.
   */
  updateConfig?(config: AgentConfig): Effect.Effect<boolean, AgentError>
}

/** Context passed to AgentFactory.start() to bootstrap an agent session */
export interface AgentStartContext {
  taskId: string
  vmIp: string
  sshPort: number
  workdir: string
  title: string
  /** Model ID to use (e.g. "claude-sonnet-4-6" for Claude Code, "anthropic/claude-sonnet-4-6" for OpenCode) */
  model?: string
  /** Reasoning effort level: "low", "medium", "high" */
  reasoningEffort?: string
  /** If set, resume an existing session instead of creating a new one */
  resumeSessionId?: string
}

/** Factory that creates agent sessions — one implementation per provider */
export interface AgentFactory {
  start(ctx: AgentStartContext): Effect.Effect<AgentHandle, SessionStartError>
}
