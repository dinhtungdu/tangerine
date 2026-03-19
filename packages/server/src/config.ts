import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import { homedir, userInfo } from "os"
import { tangerineConfigSchema } from "@tangerine/shared"
import type { TangerineConfig, ProjectConfig } from "@tangerine/shared"

export const TANGERINE_HOME = join(homedir(), "tangerine")
export const CONFIG_PATH = join(TANGERINE_HOME, "config.json")

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
    ghHost: string
  }
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
 * Loads config from ~/tangerine/config.json.
 * Validates with Zod and resolves credentials.
 */
export function loadConfig(): AppConfig {
  mkdirSync(TANGERINE_HOME, { recursive: true })

  const configPath = join(TANGERINE_HOME, "config.json")
  const raw = readConfigFile(configPath)
  if (!raw) {
    throw new Error(
      `No config found at ${configPath}. Register a project first:\n` +
      `  tangerine project add --name <name> --repo <url> --image <image> --setup "<cmd>"`,
    )
  }

  const config = tangerineConfigSchema.parse(raw)

  const opencodeAuthPath = existsSync(OPENCODE_AUTH_PATH) ? OPENCODE_AUTH_PATH : null
  const claudeOauthToken = process.env["CLAUDE_CODE_OAUTH_TOKEN"] ?? null
  const anthropicApiKey = process.env["ANTHROPIC_API_KEY"] ?? null

  if (!opencodeAuthPath && !claudeOauthToken && !anthropicApiKey) {
    throw new Error(
      "No LLM credentials found. Either run `opencode auth login`, " +
      "set CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`), " +
      "or set ANTHROPIC_API_KEY.",
    )
  }

  return {
    config,
    credentials: {
      opencodeAuthPath,
      claudeOauthToken,
      anthropicApiKey,
      githubToken: process.env["GITHUB_TOKEN"] ?? null,
      ghHost: process.env["GH_HOST"] ?? "github.com",
    },
  }
}
