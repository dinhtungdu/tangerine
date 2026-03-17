import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"

const OPENCODE_MODELS_CACHE = join(homedir(), ".cache", "opencode", "models.json")
const OPENCODE_AUTH_PATH = join(homedir(), ".local", "share", "opencode", "auth.json")

interface ModelInfo {
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

/** Read OpenCode's models cache and auth to discover available models */
export function discoverModels(): ModelInfo[] {
  // Read models catalog
  if (!existsSync(OPENCODE_MODELS_CACHE)) return []
  let catalog: Record<string, ProviderEntry>
  try {
    catalog = JSON.parse(readFileSync(OPENCODE_MODELS_CACHE, "utf-8")) as Record<string, ProviderEntry>
  } catch {
    return []
  }

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

  const models: ModelInfo[] = []

  for (const [providerId, provider] of Object.entries(catalog)) {
    // Provider is available if: has oauth in auth.json, or env var is set, or is "opencode" (always available)
    const hasOAuth = authedProviders.has(providerId)
    const hasEnvVar = provider.env?.some((e) => !!process.env[e]) ?? false
    const isOpenCode = providerId === "opencode"

    if (!hasOAuth && !hasEnvVar && !isOpenCode) continue

    for (const [modelId, model] of Object.entries(provider.models ?? {})) {
      models.push({
        id: `${providerId}/${modelId}`,
        name: model.name ?? modelId,
        provider: providerId,
        providerName: provider.name ?? providerId,
      })
    }
  }

  return models
}
