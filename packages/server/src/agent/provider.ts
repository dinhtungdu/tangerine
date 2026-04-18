// Agent provider abstraction: defines the contract that both OpenCode and Claude Code
// (and future providers) must implement. Decouples task lifecycle from any specific agent.

import type { Effect } from "effect"
import type { AgentError, PromptError, SessionStartError } from "../errors"
import type { PromptImage, ProviderType } from "@tangerine/shared"

export type { PromptImage, ProviderType }

/** A model available through a provider, used for model discovery and selection */
export interface ModelInfo {
  id: string
  name: string
  provider: string
  providerName: string
  /** Maximum context window in tokens, if known */
  contextWindow?: number
}

/** Normalized events emitted by all agent providers */
export type AgentEvent =
  | { kind: "message.streaming"; content: string; messageId?: string }
  | { kind: "message.complete"; role: "assistant" | "user" | "narration"; content: string; messageId?: string; images?: PromptImage[]; imagePaths?: string[] }
  | { kind: "status"; status: "idle" | "working" }
  | { kind: "error"; message: string }
  | { kind: "tool.start"; toolName: string; toolInput?: string }
  | { kind: "tool.end"; toolName: string; toolResult?: string }
  | { kind: "thinking"; content: string }
  /** Token usage — providers emit this when they have token data.
   *  Fields are undefined when the event only carries partial data (e.g. stream events).
   *  contextTokens = current context window usage for this turn (from message_start).
   *  inputTokens/outputTokens = token counts for accumulation.
   *  cumulative = true means values are already session totals (overwrite, don't add). */
  | { kind: "usage"; inputTokens?: number; outputTokens?: number; contextTokens?: number; cumulative?: boolean }

/** Runtime config that can be changed mid-session */
export interface AgentConfig {
  model?: string
  reasoningEffort?: string
}

export interface ReasoningEffortOption {
  value: string
  label: string
  description: string
}

export interface ProviderMetadata {
  displayName: string
  /** Short label for compact UI (e.g. "CC", "OC") */
  abbreviation: string
  /** CLI binary name used to invoke this provider (e.g. "claude", "codex") */
  cliCommand: string
  /** Default model ID when none is specified */
  defaultModel?: string
  /** Default reasoning effort level when none is specified */
  defaultReasoningEffort?: string
  /** Reasoning effort levels supported by this provider */
  reasoningEfforts: ReasoningEffortOption[]
  skills: {
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
   * For OpenCode: checks SSE connection + session responsiveness.
   * For Claude Code: checks if the subprocess is alive.
   * If not implemented, the health monitor falls back to PID-based checks.
   */
  isAlive?(): boolean
  /**
   * Return the list of skill names available in this agent session.
   * Claude Code: parsed from system/init event. Pi: parsed from get_state response.
   * OpenCode/Codex: scanned from ~/.claude/skills or ~/.codex/skills.
   */
  getSkills?(): string[]
}

/** Context passed to AgentFactory.start() to bootstrap an agent session */
export interface AgentStartContext {
  taskId: string
  workdir: string
  title: string
  /** Provider-native system/developer instructions applied at session startup when supported */
  systemPrompt?: string
  /** Model ID to use (e.g. "claude-sonnet-4-6" for Claude Code, "anthropic/claude-sonnet-4-6" for OpenCode) */
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
  metadata: ProviderMetadata
  listModels(): ModelInfo[]
  start(ctx: AgentStartContext): Effect.Effect<AgentHandle, SessionStartError>
}
