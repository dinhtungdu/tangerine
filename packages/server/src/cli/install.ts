// CLI entrypoint: one-time setup for Tangerine.
// Checks system deps, creates directories, symlinks Claude Code skill.

import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, readlinkSync } from "fs"
import { join, resolve } from "path"
import { homedir } from "os"
import { TANGERINE_HOME, OPENCODE_AUTH_PATH, readCredentialsFile, readClaudeCliToken } from "../config"

const CLAUDE_SKILLS_DIR = join(homedir(), ".claude", "skills")

// Resolve project root relative to this file:
// packages/server/src/cli/install.ts → 4 levels up
const PROJECT_ROOT = resolve(import.meta.dir, "../../../../")

// Skills to symlink into ~/.claude/skills/:
// - platform-setup: for the operator to set up projects
// - tangerine-tasks: for agents running inside tasks to understand the API
const SKILLS_TO_INSTALL = ["platform-setup", "tangerine-tasks"]

function check(label: string, ok: boolean, hint?: string): void {
  if (ok) {
    console.log(`  ✓ ${label}`)
  } else {
    console.log(`  ✗ ${label}`)
    if (hint) console.log(`    → ${hint}`)
  }
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

function symlinkSkill(skillName: string): { created: boolean; skipped: string | null } {
  const skillSource = join(PROJECT_ROOT, "skills", skillName)
  const target = join(CLAUDE_SKILLS_DIR, skillName)

  // lstatSync detects broken symlinks that existsSync misses
  let targetExists = false
  try {
    lstatSync(target)
    targetExists = true
  } catch {
    // Does not exist at all
  }

  if (targetExists) {
    try {
      const current = readlinkSync(target)
      if (resolve(current) === resolve(skillSource)) {
        return { created: false, skipped: "already linked" }
      }
    } catch {
      // Not a symlink — existing dir/file, don't touch
      return { created: false, skipped: "path exists (not a symlink), not overwriting" }
    }
    // Symlink exists but points elsewhere — replace it
    rmSync(target)
  }

  ensureDir(CLAUDE_SKILLS_DIR)
  symlinkSync(skillSource, target)
  return { created: true, skipped: null }
}

export async function install(): Promise<void> {
  console.log("\nTangerine install\n")

  // 1. Directory structure
  console.log("Directories:")
  ensureDir(TANGERINE_HOME)
  check(`${TANGERINE_HOME}`, true)

  // 2. Claude Code skills
  console.log("\nClaude Code skills:")
  for (const skillName of SKILLS_TO_INSTALL) {
    const skillSource = join(PROJECT_ROOT, "skills", skillName)
    if (!existsSync(skillSource)) {
      check(`${skillName} skill`, false, `skill source not found at ${skillSource}`)
    } else {
      const result = symlinkSkill(skillName)
      if (result.created) {
        check(`${skillName} skill → ${CLAUDE_SKILLS_DIR}/${skillName}`, true)
      } else {
        check(`${skillName} skill (${result.skipped})`, true)
      }
    }
  }

  // 3. Credentials (env vars override dotfile)
  console.log("\nCredentials:")
  const dotfile = readCredentialsFile()
  const hasOpencode = existsSync(OPENCODE_AUTH_PATH)
  const hasApiKey = !!(process.env["ANTHROPIC_API_KEY"] || dotfile.ANTHROPIC_API_KEY)
  const hasClaude = !!(process.env["CLAUDE_CODE_OAUTH_TOKEN"] || dotfile.CLAUDE_CODE_OAUTH_TOKEN || readClaudeCliToken())
  check(
    "LLM credentials",
    hasOpencode || hasApiKey || hasClaude,
    "Run `tangerine config set ANTHROPIC_API_KEY=...` or `opencode auth login`",
  )
  if (hasOpencode) console.log("    (using opencode auth.json)")
  if (hasApiKey) console.log("    (using ANTHROPIC_API_KEY)")
  if (process.env["CLAUDE_CODE_OAUTH_TOKEN"] || dotfile.CLAUDE_CODE_OAUTH_TOKEN)
    console.log("    (using CLAUDE_CODE_OAUTH_TOKEN)")
  else if (readClaudeCliToken()) console.log("    (using ~/.claude/.credentials.json)")

  const hasGithub = !!(process.env["GITHUB_TOKEN"] || dotfile.GITHUB_TOKEN)
  check("GITHUB_TOKEN", hasGithub, "Set GITHUB_TOKEN for PR creation and repo access")

  console.log()
}
