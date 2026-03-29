import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import type { ProviderType } from "./agent/provider"

const OPENCODE_MODELS_CACHE = join(homedir(), ".cache", "opencode", "models.json")
const OPENCODE_AUTH_PATH = join(homedir(), ".local", "share", "opencode", "auth.json")
const OPENCODE_CONFIG_PATH = join(homedir(), ".config", "opencode", "opencode.json")
const CODEX_MODELS_CACHE = join(homedir(), ".codex", "models_cache.json")

export interface ModelInfo {
  id: string
  name: string
  provider: string
  providerName: string
}

interface ProviderEntry {
  id: string
  name: string
  env?: string[]
  models: Record<string, { id: string; name?: string }>
}

interface ConfigProviderEntry {
  name?: string
  npm?: string
  options?: Record<string, unknown>
  models?: Record<string, { name?: string; [key: string]: unknown }>
}

/** Known models that Claude Code CLI can use directly */
const CLAUDE_CODE_MODELS: ModelInfo[] = [
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", provider: "anthropic", providerName: "Anthropic" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic", providerName: "Anthropic" },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic", providerName: "Anthropic" },
]

/**
 * Read custom providers from OpenCode's config file (~/.config/opencode/opencode.json).
 * Only includes models from providers that are either:
 * - Custom (have npm/options with their own auth), or
 * - Already authenticated via cache (present in availableCacheProviders)
 */
function discoverConfigModels(availableCacheProviders: Set<string>): ModelInfo[] {
  if (!existsSync(OPENCODE_CONFIG_PATH)) return []
  try {
    const config = JSON.parse(readFileSync(OPENCODE_CONFIG_PATH, "utf-8")) as {
      provider?: Record<string, ConfigProviderEntry>
    }
    if (!config.provider) return []

    const models: ModelInfo[] = []
    for (const [providerId, provider] of Object.entries(config.provider)) {
      if (!provider.models) continue
      // Custom providers (with npm/options) are self-authenticated;
      // built-in overrides need the same cache auth check
      const isCustomProvider = !!(provider.npm || provider.options)
      if (!isCustomProvider && !availableCacheProviders.has(providerId)) continue

      for (const [modelId, model] of Object.entries(provider.models)) {
        models.push({
          id: `${providerId}/${modelId}`,
          name: model.name ?? modelId,
          provider: providerId,
          providerName: provider.name ?? providerId,
        })
      }
    }
    return models
  } catch {
    return []
  }
}

/** Read OpenCode's models cache and auth to discover available models */
export function discoverModels(): ModelInfo[] {
  const models: ModelInfo[] = []
  const availableCacheProviders = new Set<string>()

  // Read models from cache
  if (existsSync(OPENCODE_MODELS_CACHE)) {
    try {
      const catalog = JSON.parse(readFileSync(OPENCODE_MODELS_CACHE, "utf-8")) as Record<string, ProviderEntry>

      // Read authenticated providers (oauth tokens)
      const authedProviders = new Set<string>()
      try {
        if (existsSync(OPENCODE_AUTH_PATH)) {
          const auth = JSON.parse(readFileSync(OPENCODE_AUTH_PATH, "utf-8")) as Record<string, unknown>
          for (const key of Object.keys(auth)) {
            authedProviders.add(key)
          }
        }
      } catch {
        // no auth
      }

      for (const [providerId, provider] of Object.entries(catalog)) {
        // Provider is available if: has oauth in auth.json, or env var is set
        const hasOAuth = authedProviders.has(providerId)
        const hasEnvVar = provider.env?.some((e) => !!process.env[e]) ?? false

        if (!hasOAuth && !hasEnvVar) continue

        availableCacheProviders.add(providerId)

        for (const [modelId, model] of Object.entries(provider.models ?? {})) {
          models.push({
            id: `${providerId}/${modelId}`,
            name: model.name ?? modelId,
            provider: providerId,
            providerName: provider.name ?? providerId,
          })
        }
      }
    } catch {
      // ignore cache read errors
    }
  }

  // Merge models from config file, deduplicating by id
  const configModels = discoverConfigModels(availableCacheProviders)
  const seen = new Set(models.map((m) => m.id))
  for (const model of configModels) {
    if (!seen.has(model.id)) {
      models.push(model)
      seen.add(model.id)
    }
  }

  return models
}

/** Known models for Claude Code CLI — always returned since auth is in the VM, not the host */
export function discoverClaudeCodeModels(): ModelInfo[] {
  return CLAUDE_CODE_MODELS
}

/** Read Codex CLI's models cache to discover available models */
export function discoverCodexModels(): ModelInfo[] {
  if (!existsSync(CODEX_MODELS_CACHE)) return []
  try {
    const raw = JSON.parse(readFileSync(CODEX_MODELS_CACHE, "utf-8")) as {
      models?: Array<{ slug: string; display_name?: string; visibility?: string; supported_in_api?: boolean }>
    }
    if (!Array.isArray(raw.models)) return []
    return raw.models
      .filter((m) => m.visibility === "list")
      .map((m) => ({
        id: m.slug,
        name: m.display_name ?? m.slug,
        provider: "openai",
        providerName: "OpenAI",
      }))
  } catch {
    return []
  }
}

/** Discover models grouped by harness (provider type) */
export function discoverModelsByProvider(): Record<ProviderType, ModelInfo[]> {
  return {
    opencode: discoverModels(),
    "claude-code": discoverClaudeCodeModels(),
    codex: discoverCodexModels(),
  }
}
