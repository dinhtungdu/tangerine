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

function readJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T
  } catch {
    return null
  }
}

function buildModels(
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

/** Read OAuth tokens and determine which providers have valid auth */
function readAuthedProviders(): Set<string> {
  const auth = readJsonFile<Record<string, unknown>>(OPENCODE_AUTH_PATH)
  return new Set(auth ? Object.keys(auth) : [])
}

/** Read OpenCode's models cache, filtered to authenticated providers */
function discoverCacheModels(): { models: ModelInfo[]; availableProviders: Set<string> } {
  const catalog = readJsonFile<Record<string, ProviderEntry>>(OPENCODE_MODELS_CACHE)
  if (!catalog) return { models: [], availableProviders: new Set() }

  const authedProviders = readAuthedProviders()
  const availableProviders = new Set<string>()
  const models: ModelInfo[] = []

  for (const [providerId, provider] of Object.entries(catalog)) {
    const hasOAuth = authedProviders.has(providerId)
    const hasEnvVar = provider.env?.some((e) => !!process.env[e]) ?? false
    if (!hasOAuth && !hasEnvVar) continue

    availableProviders.add(providerId)
    models.push(...buildModels(providerId, provider.name ?? providerId, provider.models ?? {}))
  }

  return { models, availableProviders }
}

/**
 * Read providers from OpenCode's config file (~/.config/opencode/opencode.json).
 * Custom providers (with npm/options) are self-authenticated.
 * Built-in overrides only included if already authenticated in the cache.
 */
function discoverConfigModels(availableCacheProviders: Set<string>): ModelInfo[] {
  const config = readJsonFile<{ provider?: Record<string, ConfigProviderEntry> }>(OPENCODE_CONFIG_PATH)
  if (!config?.provider) return []

  const models: ModelInfo[] = []
  for (const [providerId, provider] of Object.entries(config.provider)) {
    if (!provider.models) continue
    const isCustomProvider = !!(provider.npm || provider.options)
    if (!isCustomProvider && !availableCacheProviders.has(providerId)) continue

    models.push(...buildModels(providerId, provider.name ?? providerId, provider.models))
  }
  return models
}

/** Read OpenCode's models cache and config to discover available models */
export function discoverModels(): ModelInfo[] {
  const { models, availableProviders } = discoverCacheModels()
  const configModels = discoverConfigModels(availableProviders)

  // Merge config models, deduplicating by id
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
