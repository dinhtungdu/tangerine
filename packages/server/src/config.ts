import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { tangerineConfigSchema } from "@tangerine/shared"
import type { TangerineConfig } from "@tangerine/shared"

/** Path to OpenCode's credential store on the host */
export const OPENCODE_AUTH_PATH = join(homedir(), ".local", "share", "opencode", "auth.json")

/** Path where auth.json is placed inside the VM */
export const VM_AUTH_PATH = "/home/agent/.local/share/opencode/auth.json"

export interface AppConfig {
  config: TangerineConfig
  credentials: {
    opencodeAuthPath: string | null
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

/**
 * Loads config by merging project-local tangerine.json over global ~/.config/tangerine/config.json,
 * validates with Zod, and resolves credentials.
 *
 * LLM credentials: prefers OpenCode's auth.json (supports API keys + OAuth).
 * Falls back to ANTHROPIC_API_KEY env var. At least one must be available.
 */
export function loadConfig(): AppConfig {
  const globalPath = join(homedir(), ".config", "tangerine", "config.json")
  const projectPath = join(process.cwd(), "tangerine.json")

  const globalConfig = readConfigFile(globalPath) ?? {}
  const projectConfig = readConfigFile(projectPath) ?? {}

  // Project config overrides global config
  const merged = { ...globalConfig, ...projectConfig }

  const config = tangerineConfigSchema.parse(merged)

  const opencodeAuthPath = existsSync(OPENCODE_AUTH_PATH) ? OPENCODE_AUTH_PATH : null
  const anthropicApiKey = process.env["ANTHROPIC_API_KEY"] ?? null

  if (!opencodeAuthPath && !anthropicApiKey) {
    throw new Error(
      "No LLM credentials found. Either run `opencode auth login` to set up auth, " +
      "or set the ANTHROPIC_API_KEY environment variable.",
    )
  }

  return {
    config,
    credentials: {
      opencodeAuthPath,
      anthropicApiKey,
      githubToken: process.env["GITHUB_TOKEN"] ?? null,
      ghHost: process.env["GH_HOST"] ?? "github.com",
    },
  }
}
