import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { tangerineConfigSchema, DEFAULT_API_PORT, DEFAULT_SSL_PORT } from "@tangerine/shared"
import type { TangerineConfig, ProjectConfig, SslConfig } from "@tangerine/shared"

export const TANGERINE_HOME = join(homedir(), "tangerine")
export const CONFIG_PATH = join(TANGERINE_HOME, "config.json")
export const CREDENTIALS_PATH = join(TANGERINE_HOME, ".credentials")

/** Resolve the active credentials file path (respects TANGERINE_CREDENTIALS env var). */
export function resolveCredentialsPath(): string {
  return process.env["TANGERINE_CREDENTIALS"] ?? CREDENTIALS_PATH
}

/** Returns true when the server is running in test mode (TEST_MODE=1). */
export function isTestMode(): boolean {
  return process.env["TEST_MODE"] === "1"
}

/** Raw config shape before Zod validation */
export interface RawConfig {
  projects?: Array<Record<string, unknown>>
  model?: string
  integrations?: Record<string, unknown>
  [key: string]: unknown
}

/** Resolve the active config file path (respects TANGERINE_CONFIG env var). */
export function resolveConfigPath(): string {
  return process.env["TANGERINE_CONFIG"] ?? CONFIG_PATH
}

/** Read raw config from disk (pre-validation). Returns empty projects array if no file. */
export function readRawConfig(): RawConfig {
  const path = resolveConfigPath()
  const dir = join(path, "..")
  mkdirSync(dir, { recursive: true })
  if (!existsSync(path)) {
    return { projects: [] }
  }
  const raw = readFileSync(path, "utf-8")
  return JSON.parse(raw) as RawConfig
}

/** Write raw config to disk */
export function writeRawConfig(config: RawConfig): void {
  const path = resolveConfigPath()
  const dir = join(path, "..")
  mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n")
}

/** SslConfig with port resolved to a concrete number (never undefined). */
export type ResolvedSslConfig = Omit<SslConfig, "port"> & { port: number }

export interface AppConfig {
  config: TangerineConfig
  credentials: {
    tangerineAuthToken: string | null
    serverPort: number
    externalHost: string
    ssl: ResolvedSslConfig | null
  }
}

export const ALLOWED_CREDENTIAL_KEYS = [
  "TANGERINE_AUTH_TOKEN",
  "EXTERNAL_HOST",
] as const

export type CredentialKey = (typeof ALLOWED_CREDENTIAL_KEYS)[number]

/** Read credentials from the dotfile. Returns empty object if file missing. */
export function readCredentialsFile(): Partial<Record<CredentialKey, string>> {
  const path = resolveCredentialsPath()
  if (!existsSync(path)) return {}
  const content = readFileSync(path, "utf-8")
  const creds: Partial<Record<CredentialKey, string>> = {}
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eqIndex = trimmed.indexOf("=")
    if (eqIndex === -1) continue
    const key = trimmed.slice(0, eqIndex) as CredentialKey
    const value = trimmed.slice(eqIndex + 1)
    if (ALLOWED_CREDENTIAL_KEYS.includes(key)) {
      creds[key] = value
    }
  }
  return creds
}

/** Write credentials to the dotfile (mode 0600). Merges with existing. */
export function writeCredentialsFile(updates: Partial<Record<CredentialKey, string>>): void {
  const path = resolveCredentialsPath()
  mkdirSync(join(path, ".."), { recursive: true })
  const existing = readCredentialsFile()
  const merged = { ...existing, ...updates }
  // Remove keys with empty values
  const entries = Object.entries(merged).filter(([, v]) => v !== undefined && v !== "")
  const content = entries.map(([k, v]) => `${k}=${v}`).join("\n") + (entries.length ? "\n" : "")
  writeFileSync(path, content)
  chmodSync(path, 0o600)
}

/** Remove a credential key from the dotfile. */
export function unsetCredential(key: CredentialKey): boolean {
  const path = resolveCredentialsPath()
  const existing = readCredentialsFile()
  if (!(key in existing)) return false
  delete existing[key]
  // Write directly — don't call writeCredentialsFile which re-reads and merges
  const entries = Object.entries(existing).filter(([, v]) => v !== undefined && v !== "")
  const content = entries.map(([k, v]) => `${k}=${v}`).join("\n") + (entries.length ? "\n" : "")
  writeFileSync(path, content)
  chmodSync(path, 0o600)
  return true
}

/** Reads and parses a JSON config file, returning null if it doesn't exist */
function readConfigFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null
  const raw = readFileSync(path, "utf-8")
  return JSON.parse(raw) as Record<string, unknown>
}

/** Resolve a project config by name */
export function getProjectConfig(config: TangerineConfig, projectId: string): ProjectConfig | undefined {
  return config.projects.find((p) => p.name === projectId)
}

/** Resolve the workspace root, expanding ~ to the user's home directory */
export function resolveWorkspace(config: TangerineConfig): string {
  const ws = config.workspace
  if (ws.startsWith("~/")) {
    return join(homedir(), ws.slice(2))
  }
  return ws
}

/** Get the repo directory for a project: {workspace}/{projectId}/0 */
export function getRepoDir(config: TangerineConfig, projectId: string): string {
  return join(resolveWorkspace(config), projectId, "0")
}

/**
 * Loads config from ~/tangerine/config.json (or TANGERINE_CONFIG / --config override).
 * Validates with Zod and resolves credentials.
 */
export function loadConfig(overrides?: { configPath?: string }): AppConfig {
  mkdirSync(TANGERINE_HOME, { recursive: true })

  const configPath = overrides?.configPath ?? process.env["TANGERINE_CONFIG"] ?? join(TANGERINE_HOME, "config.json")
  const raw = readConfigFile(configPath)
  if (!raw) {
    throw new Error(
      `No config found at ${configPath}. Register a project first:\n` +
      `  tangerine project add --name <name> --repo <url> --image <image> --setup "<cmd>"`,
    )
  }

  const config = tangerineConfigSchema.parse(raw)

  // Dotfile credentials first, env vars override
  const dotfile = readCredentialsFile()

  const tangerineAuthToken = process.env["TANGERINE_AUTH_TOKEN"] ?? dotfile.TANGERINE_AUTH_TOKEN ?? null

  // HTTP port: TANGERINE_PORT env var overrides config.port, which overrides the default.
  const envPort = parseInt(process.env["TANGERINE_PORT"] ?? "", 10)
  const serverPort = Number.isFinite(envPort) && envPort > 0 ? envPort : config.port ?? DEFAULT_API_PORT

  // Resolve ssl: apply port default here so callers get a complete object
  const sslBase = config.ssl ?? null
  let ssl: ResolvedSslConfig | null = null
  if (sslBase) {
    const resolvedSslPort = sslBase.port ?? DEFAULT_SSL_PORT
    if (resolvedSslPort === serverPort) {
      throw new Error(
        `ssl.port (${resolvedSslPort}) must differ from the HTTP server port (${serverPort}). ` +
        `Set a different ssl.port or port in config.json, or change the TANGERINE_PORT env var.`,
      )
    }
    if (!existsSync(sslBase.cert)) {
      throw new Error(`ssl.cert file not found: ${sslBase.cert}`)
    }
    if (!existsSync(sslBase.key)) {
      throw new Error(`ssl.key file not found: ${sslBase.key}`)
    }
    ssl = { ...sslBase, port: resolvedSslPort }
  }

  return {
    config,
    credentials: {
      tangerineAuthToken,
      serverPort,
      externalHost: process.env["EXTERNAL_HOST"] ?? dotfile.EXTERNAL_HOST ?? "localhost",
      ssl,
    },
  }
}
