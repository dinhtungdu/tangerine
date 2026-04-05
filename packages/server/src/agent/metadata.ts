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
