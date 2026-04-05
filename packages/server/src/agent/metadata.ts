import { PROVIDER_DISPLAY_NAMES, type ProviderType } from "@tangerine/shared"
import type { ProviderMetadata } from "./provider"
import { homedir } from "node:os"
import { join } from "node:path"

export const AGENT_PROVIDER_METADATA: Record<ProviderType, ProviderMetadata> = {
  opencode: {
    displayName: PROVIDER_DISPLAY_NAMES.opencode,
    skills: {
      directory: join(homedir(), ".claude", "skills"),
    },
  },
  "claude-code": {
    displayName: PROVIDER_DISPLAY_NAMES["claude-code"],
    skills: {
      directory: join(homedir(), ".claude", "skills"),
    },
  },
  codex: {
    displayName: PROVIDER_DISPLAY_NAMES.codex,
    skills: {
      directory: join(homedir(), ".codex", "skills"),
    },
  },
  pi: {
    displayName: PROVIDER_DISPLAY_NAMES.pi,
    skills: {
      directory: join(homedir(), ".pi", "agent", "skills"),
    },
  },
}
