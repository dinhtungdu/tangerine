import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "fs"
import { join } from "path"
import { homedir, userInfo } from "os"
import { tangerineConfigSchema, DEFAULT_API_PORT } from "@tangerine/shared"
import type { TangerineConfig, ProjectConfig } from "@tangerine/shared"

export const TANGERINE_HOME = join(homedir(), "tangerine")
export const CONFIG_PATH = join(TANGERINE_HOME, "config.json")
export const CREDENTIALS_PATH = join(TANGERINE_HOME, ".credentials")

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

/** Read raw config from disk (pre-validation). Returns empty projects array if no file. */
export function readRawConfig(): RawConfig {
  mkdirSync(TANGERINE_HOME, { recursive: true })
  if (!existsSync(CONFIG_PATH)) {
    return { projects: [] }
  }
  const raw = readFileSync(CONFIG_PATH, "utf-8")
  return JSON.parse(raw) as RawConfig
}

/** Write raw config to disk */
export function writeRawConfig(config: RawConfig): void {
  mkdirSync(TANGERINE_HOME, { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n")
}

/** Path to OpenCode's credential store on the host */
export const OPENCODE_AUTH_PATH = join(homedir(), ".local", "share", "opencode", "auth.json")

/** Path to Claude Code's config directory on the host */
export const CLAUDE_AUTH_DIR = join(homedir(), ".claude")

/** Path to Claude Code's stored OAuth credentials */
export const CLAUDE_CREDENTIALS_PATH = join(CLAUDE_AUTH_DIR, ".credentials.json")

/** Read the OAuth token Claude Code CLI has already stored on disk, if any. */
export function readClaudeCliToken(): string | null {
  if (!existsSync(CLAUDE_CREDENTIALS_PATH)) return null
  try {
    const raw = JSON.parse(readFileSync(CLAUDE_CREDENTIALS_PATH, "utf-8")) as unknown
    if (typeof raw !== "object" || raw === null) return null
    const oauth = (raw as Record<string, unknown>)?.claudeAiOauth
    if (typeof oauth !== "object" || oauth === null) return null
    const { accessToken } = oauth as Record<string, unknown>
    if (typeof accessToken !== "string") return null
    return accessToken
  } catch {
    return null
  }
}

/** SSH user inside the VM — Lima defaults to the host username */
export const VM_USER = userInfo().username

/** Relative path for auth.json inside the VM (under user's home) */
export const VM_AUTH_RELPATH = ".local/share/opencode/auth.json"

export interface AppConfig {
  config: TangerineConfig
  credentials: {
    opencodeAuthPath: string | null
    claudeOauthToken: string | null
    anthropicApiKey: string | null
    githubToken: string | null
    serverPort: number
    externalHost: string
  }
}

export const ALLOWED_CREDENTIAL_KEYS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "GITHUB_TOKEN",
  "EXTERNAL_HOST",
] as const

export type CredentialKey = (typeof ALLOWED_CREDENTIAL_KEYS)[number]

/** Read credentials from the dotfile. Returns empty object if file missing. */
export function readCredentialsFile(): Partial<Record<CredentialKey, string>> {
  if (!existsSync(CREDENTIALS_PATH)) return {}
  const content = readFileSync(CREDENTIALS_PATH, "utf-8")
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
  mkdirSync(TANGERINE_HOME, { recursive: true })
  const existing = readCredentialsFile()
  const merged = { ...existing, ...updates }
  // Remove keys with empty values
  const entries = Object.entries(merged).filter(([, v]) => v !== undefined && v !== "")
  const content = entries.map(([k, v]) => `${k}=${v}`).join("\n") + (entries.length ? "\n" : "")
  writeFileSync(CREDENTIALS_PATH, content)
  chmodSync(CREDENTIALS_PATH, 0o600)
}

/** Remove a credential key from the dotfile. */
export function unsetCredential(key: CredentialKey): boolean {
  const existing = readCredentialsFile()
  if (!(key in existing)) return false
  delete existing[key]
  // Write directly — don't call writeCredentialsFile which re-reads and merges
  const entries = Object.entries(existing).filter(([, v]) => v !== undefined && v !== "")
  const content = entries.map(([k, v]) => `${k}=${v}`).join("\n") + (entries.length ? "\n" : "")
  writeFileSync(CREDENTIALS_PATH, content)
  chmodSync(CREDENTIALS_PATH, 0o600)
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

  const opencodeAuthPath = existsSync(OPENCODE_AUTH_PATH) ? OPENCODE_AUTH_PATH : null
  const claudeOauthToken =
    process.env["CLAUDE_CODE_OAUTH_TOKEN"] ?? dotfile.CLAUDE_CODE_OAUTH_TOKEN ?? readClaudeCliToken()
  const anthropicApiKey = process.env["ANTHROPIC_API_KEY"] ?? dotfile.ANTHROPIC_API_KEY ?? null

  if (!opencodeAuthPath && !claudeOauthToken && !anthropicApiKey) {
    throw new Error(
      "No LLM credentials found. Either:\n" +
      "  tangerine config set ANTHROPIC_API_KEY=sk-ant-...\n" +
      "  tangerine config set CLAUDE_CODE_OAUTH_TOKEN=...\n" +
      "  or run `opencode auth login`",
    )
  }

  return {
    config,
    credentials: {
      opencodeAuthPath,
      claudeOauthToken,
      anthropicApiKey,
      githubToken: process.env["GITHUB_TOKEN"] ?? dotfile.GITHUB_TOKEN ?? null,
      serverPort: parseInt(process.env["PORT"] ?? "", 10) || DEFAULT_API_PORT,
      externalHost: process.env["EXTERNAL_HOST"] ?? dotfile.EXTERNAL_HOST ?? "localhost",
    },
  }
}
