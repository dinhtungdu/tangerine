import type { ProviderType } from "@tangerine/shared"
import type { ProviderMetadata } from "./provider"
import { CLAUDE_CODE_PROVIDER_METADATA } from "./claude-code-provider"
import { CODEX_PROVIDER_METADATA } from "./codex-provider"
import { OPENCODE_PROVIDER_METADATA } from "./opencode-provider"
import { PI_PROVIDER_METADATA } from "./pi-provider"

export const AGENT_PROVIDER_METADATA: Record<ProviderType, ProviderMetadata> = {
  opencode: OPENCODE_PROVIDER_METADATA,
  "claude-code": CLAUDE_CODE_PROVIDER_METADATA,
  codex: CODEX_PROVIDER_METADATA,
  pi: PI_PROVIDER_METADATA,
}

/** Returns the valid reasoningEffort values for a provider, or [] if unknown. */
export function getValidReasoningEfforts(provider: string): string[] {
  const meta = AGENT_PROVIDER_METADATA[provider as ProviderType]
  if (!meta) return []
  return meta.reasoningEfforts.map((e) => e.value)
}

/**
 * Returns true if the effort value is valid for the given provider.
 * If the provider is unknown or has no defined efforts, returns true (no constraint).
 */
export function isValidReasoningEffort(provider: string, effort: string): boolean {
  const valid = getValidReasoningEfforts(provider)
  if (valid.length === 0) return true
  return valid.includes(effort)
}
