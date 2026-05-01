// Agent provider abstraction: ACP runtime contract used by task lifecycle.

import type { Effect } from "effect"
import type { AgentError, PromptError, SessionStartError } from "../errors"
import type { AgentConfigOption, AgentContentBlock, AgentPlanEntry, AgentSlashCommand, PromptImage, TaskPermissionMode } from "@tangerine/shared"

export type { PromptImage }

export type AgentStreamRole = "assistant" | "narration"

/** Normalized events emitted by configured ACP agents */
export type AgentEvent =
  | { kind: "message.streaming"; role?: AgentStreamRole; content: string; messageId?: string }
  | { kind: "message.complete"; role: AgentStreamRole | "user"; content: string; messageId?: string; images?: PromptImage[]; imagePaths?: string[] }
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
   *  contextTokens = current context window usage for this turn.
   *  contextWindowMax = current context window capacity when the provider reports it.
   *  inputTokens/outputTokens = token counts for accumulation.
   *  cumulative = true means values are already session totals (overwrite, don't add). */
  | { kind: "usage"; inputTokens?: number; outputTokens?: number; contextTokens?: number; contextWindowMax?: number; cumulative?: boolean }
  | { kind: "config.options"; options: AgentConfigOption[] }
  | { kind: "slash.commands"; commands: AgentSlashCommand[] }
  | { kind: "plan"; entries: AgentPlanEntry[] }
  | { kind: "content.block"; block: AgentContentBlock }
  | { kind: "session.info"; title?: string | null; updatedAt?: string | null; metadata?: Record<string, unknown> }
  | { kind: "permission.request"; requestId: string; toolName?: string; toolCallId?: string; options: PermissionRequestOption[] }
  | { kind: "permission.decision"; toolName?: string; optionId: string; optionName: string; optionKind: string }
  | { kind: "capabilities.update"; imagePrompts: boolean }

export interface PermissionRequestOption {
  optionId: string
  name: string
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always"
}

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
  /** CLI binary name used to invoke this ACP-compatible agent. */
  cliCommand: string
  /** CLI command to launch the agent's native TUI with --resume. Set when TUI mode is supported. */
  tuiCommand?: string
  /** Template args for TUI resume, with {{sessionId}} placeholder. Default: ["--resume", "{{sessionId}}"]. */
  tuiResumeTemplate?: string[]
}

/** Handle to a running ACP session — owns the process and event subscription */
export interface AgentHandle {
  sendPrompt(text: string, images?: PromptImage[]): Effect.Effect<void, PromptError>
  /** Respond to a pending permission request when the provider asks the UI. */
  respondToPermission?(requestId: string, optionId: string): void
  /**
   * Apply a system prompt to the current session before future user prompts.
   * Returns true if the provider applied it; false means caller should fallback.
   */
  setSystemPrompt?(text: string): Effect.Effect<boolean, AgentError>
  /**
   * Abort the current agent work.
   * @param force If true, forcibly kill descendants (for hung agents). If false, use graceful RPC cancel.
   */
  abort(force?: boolean): Effect.Effect<void, AgentError>
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
   * Agents may expose this if they can report skill names.
   */
  getSkills?(): string[]
  /** Return latest ACP session config options, if the provider exposes them. */
  getConfigOptions?(): AgentConfigOption[]
  /** Return latest ACP slash commands, if the provider exposes them. */
  getSlashCommands?(): AgentSlashCommand[]
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
  /** Permission handling mode for ACP requests (default: skipPermissions). */
  permissionMode?: TaskPermissionMode | "prompt"
  /** If set, resume an existing session instead of creating a new one */
  resumeSessionId?: string
  /** Extra environment variables merged into the spawned process env */
  env?: Record<string, string>
}

/** Factory that creates sessions for a configured ACP agent command. */
export interface AgentFactory {
  metadata: AgentMetadata
  start(ctx: AgentStartContext): Effect.Effect<AgentHandle, SessionStartError>
}

export function getAgentHandleMeta(handle: AgentHandle): { sessionId: string | null } | null {
  const meta = (handle as { __meta?: { sessionId?: string | null } }).__meta
  if (!meta) return null
  return {
    sessionId: meta.sessionId ?? null,
  }
}
