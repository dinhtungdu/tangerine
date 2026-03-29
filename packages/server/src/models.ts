import type { ProviderType } from "./agent/provider"
import { discoverModels as discoverOpenCodeModels } from "./agent/opencode-provider"
import { discoverModels as discoverCodexProviderModels } from "./agent/codex-provider"

export interface ModelInfo {
  id: string
  name: string
  provider: string
  providerName: string
}

export function buildModels(
  providerId: string,
  providerName: string,
  models: Record<string, { name?: string; [key: string]: unknown }>,
): ModelInfo[] {
  return Object.entries(models).map(([modelId, model]) => ({
    id: `${providerId}/${modelId}`,
    name: model.name ?? modelId,
    provider: providerId,
    providerName,
  }))
}

/** Known models that Claude Code CLI can use directly */
const CLAUDE_CODE_MODELS: ModelInfo[] = [
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", provider: "anthropic", providerName: "Anthropic" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic", providerName: "Anthropic" },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic", providerName: "Anthropic" },
]

/** Discover available OpenCode models from the local cache and config */
export function discoverModels(): ModelInfo[] {
  return discoverOpenCodeModels()
}

/** Known models for Claude Code CLI — always returned since auth is in the VM, not the host */
export function discoverClaudeCodeModels(): ModelInfo[] {
  return CLAUDE_CODE_MODELS
}

/** Discover available Codex models from the local cache */
export function discoverCodexModels(): ModelInfo[] {
  return discoverCodexProviderModels()
}

/** Discover models grouped by harness (provider type) */
export function discoverModelsByProvider(): Record<ProviderType, ModelInfo[]> {
  return {
    opencode: discoverOpenCodeModels(),
    "claude-code": discoverClaudeCodeModels(),
    codex: discoverCodexProviderModels(),
  }
}
