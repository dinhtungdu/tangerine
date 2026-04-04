import type { AgentFactory, ProviderType } from "./provider"
import { createClaudeCodeProvider } from "./claude-code-provider"
import { createCodexProvider } from "./codex-provider"
import { createOpenCodeProvider } from "./opencode-provider"
import { createPiProvider } from "./pi-provider"

export type AgentFactories = Record<ProviderType, AgentFactory>

export function createAgentFactories(): AgentFactories {
  return {
    opencode: createOpenCodeProvider(),
    "claude-code": createClaudeCodeProvider(),
    codex: createCodexProvider(),
    pi: createPiProvider(),
  }
}

