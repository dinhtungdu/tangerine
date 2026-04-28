// Agent provider abstraction: ACP runtime contract used by task lifecycle.

import type { Effect } from "effect"
import type { AgentError, PromptError, SessionStartError } from "../errors"
import type { AgentConfigOption, AgentContentBlock, AgentPlanEntry, PromptImage, ProviderType } from "@tangerine/shared"

export type { PromptImage, ProviderType }

/** Normalized events emitted by all agent providers */
export type AgentEvent =
  | { kind: "message.streaming"; content: string; messageId?: string }
  | { kind: "message.complete"; role: "assistant" | "user" | "narration"; content: string; messageId?: string; images?: PromptImage[]; imagePaths?: string[] }
  | { kind: "status"; status: "idle" | "working" }
  | { kind: "error"; message: string }
  | { kind: "tool.start"; toolName: string; toolCallId?: string; toolInput?: string }
  | { kind: "tool.update"; toolName: string; toolCallId?: string; toolInput?: string; toolResult?: string; status?: "running" }
  | { kind: "tool.end"; toolName: string; toolCallId?: string; toolResult?: string; status?: "success" | "error" }
  | { kind: "thinking"; content: string }
  | { kind: "thinking.streaming"; content: string; messageId?: string }
  | { kind: "thinking.complete"; content: string; messageId?: string }
  /** Token usage — providers emit this when they have token data.
   *  Fields are undefined when the event only carries partial data (e.g. stream events).
   *  contextTokens = current context window usage for this turn (from message_start).
   *  inputTokens/outputTokens = token counts for accumulation.
   *  cumulative = true means values are already session totals (overwrite, don't add). */
  | { kind: "usage"; inputTokens?: number; outputTokens?: number; contextTokens?: number; cumulative?: boolean }
  | { kind: "config.options"; options: AgentConfigOption[] }
  | { kind: "plan"; entries: AgentPlanEntry[] }
  | { kind: "content.block"; block: AgentContentBlock }
  | { kind: "session.info"; title?: string | null; updatedAt?: string | null; metadata?: Record<string, unknown> }
  | { kind: "permission.decision"; toolName?: string; optionId: string; optionName: string; optionKind: string }

/** Runtime config that can be changed mid-session */
export interface AgentConfig {
  model?: string
  reasoningEffort?: string
  mode?: string
}

export interface AgentMetadata {
  displayName: string
  /** Short label for compact UI. */
  abbreviation: string
  /** CLI binary name used to invoke this ACP agent. */
  cliCommand: string
  skills?: {
    directory: string
  }
}

/** Handle to a running agent session — owns the process, tunnel, and event subscription */
export interface AgentHandle {
  sendPrompt(text: string, images?: PromptImage[]): Effect.Effect<void, PromptError>
  /**
   * Apply a system prompt to the current session before future user prompts.
   * Returns true if the provider applied it; false means caller should fallback.
   */
  setSystemPrompt?(text: string): Effect.Effect<boolean, AgentError>
  abort(): Effect.Effect<void, AgentError>
  subscribe(onEvent: (e: AgentEvent) => void): { unsubscribe(): void }
  shutdown(): Effect.Effect<void, never>
  /**
   * Apply config changes without restarting the agent process.
   * Returns true if the change was applied successfully.
   * If not implemented, the manager falls back to shutdown + restart.
   */
  updateConfig?(config: AgentConfig): Effect.Effect<boolean, AgentError>
  /**
   * Session-level health check. Returns true if the agent session is responsive.
   * If not implemented, the health monitor falls back to PID-based checks.
   */
  isAlive?(): boolean
  /**
   * Return the list of skill names available in this agent session.
   * ACP agents may expose this if they can report skill names.
   */
  getSkills?(): string[]
  /** Return latest ACP session config options, if the provider exposes them. */
  getConfigOptions?(): AgentConfigOption[]
}

/** Context passed to AgentFactory.start() to bootstrap an agent session */
export interface AgentStartContext {
  taskId: string
  workdir: string
  title: string
  /** Provider-native system/developer instructions applied at session startup when supported */
  systemPrompt?: string
  /** Initial model ID to pass through to the ACP agent when supported. */
  model?: string
  /** Reasoning effort level: "low", "medium", "high" */
  reasoningEffort?: string
  /** If set, resume an existing session instead of creating a new one */
  resumeSessionId?: string
  /** Extra environment variables merged into the spawned process env */
  env?: Record<string, string>
}

/** Factory that creates agent sessions — one implementation per provider */
export interface AgentFactory {
  metadata: AgentMetadata
  start(ctx: AgentStartContext): Effect.Effect<AgentHandle, SessionStartError>
}

export function getAgentHandleMeta(handle: AgentHandle): { sessionId: string | null; agentPort: number | null } | null {
  const meta = (handle as { __meta?: { sessionId?: string | null; agentPort?: number | null } }).__meta
  if (!meta) return null
  return {
    sessionId: meta.sessionId ?? null,
    agentPort: meta.agentPort ?? null,
  }
}
