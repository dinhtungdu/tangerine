// CLI entrypoint: one-time setup for Tangerine.
// Checks system deps, creates directories, symlinks Claude Code skill.

import { existsSync, mkdirSync, symlinkSync, readlinkSync } from "fs"
import { join, resolve } from "path"
import { homedir } from "os"
import { TANGERINE_HOME, OPENCODE_AUTH_PATH, readCredentialsFile } from "../config"

const CLAUDE_SKILLS_DIR = join(homedir(), ".claude", "skills")
const SKILL_NAME = "tangerine-init"

// Resolve project root relative to this file:
// packages/server/src/cli/install.ts → 4 levels up
const PROJECT_ROOT = resolve(import.meta.dir, "../../../../")
const SKILL_SOURCE = join(PROJECT_ROOT, "skills", SKILL_NAME)

function check(label: string, ok: boolean, hint?: string): void {
  if (ok) {
    console.log(`  ✓ ${label}`)
  } else {
    console.log(`  ✗ ${label}`)
    if (hint) console.log(`    → ${hint}`)
  }
}

async function checkLima(): Promise<boolean> {
  if (process.platform !== "darwin") return true
  const proc = Bun.spawn(["which", "lima"], { stdout: "pipe", stderr: "pipe" })
  await proc.exited
  return proc.exitCode === 0
}

async function checkIncus(): Promise<boolean> {
  if (process.platform === "darwin") return true
  const proc = Bun.spawn(["which", "incus"], { stdout: "pipe", stderr: "pipe" })
  await proc.exited
  return proc.exitCode === 0
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

function symlinkSkill(): { created: boolean; skipped: string | null } {
  const target = join(CLAUDE_SKILLS_DIR, SKILL_NAME)

  if (existsSync(target)) {
    // Check if it already points to the right place
    try {
      const current = readlinkSync(target)
      if (resolve(current) === resolve(SKILL_SOURCE)) {
        return { created: false, skipped: "already linked" }
      }
    } catch {
      // Not a symlink — existing dir/file
    }
    return { created: false, skipped: "path exists, not overwriting" }
  }

  ensureDir(CLAUDE_SKILLS_DIR)
  symlinkSync(SKILL_SOURCE, target)
  return { created: true, skipped: null }
}

export async function install(): Promise<void> {
  console.log("\nTangerine install\n")

  // 1. System dependencies
  console.log("System dependencies:")
  if (process.platform === "darwin") {
    const hasLima = await checkLima()
    check("Lima", hasLima, "brew install lima")
  } else {
    const hasIncus = await checkIncus()
    check("Incus", hasIncus, "See https://linuxcontainers.org/incus/docs/main/installing/")
  }

  // 2. Directory structure
  console.log("\nDirectories:")
  ensureDir(TANGERINE_HOME)
  check(`${TANGERINE_HOME}`, true)
  ensureDir(join(TANGERINE_HOME, "images"))
  check(`${TANGERINE_HOME}/images`, true)

  // 3. Claude Code skill
  console.log("\nClaude Code skill:")
  if (!existsSync(SKILL_SOURCE)) {
    check(`${SKILL_NAME} skill`, false, `skill source not found at ${SKILL_SOURCE}`)
  } else {
    const result = symlinkSkill()
    if (result.created) {
      check(`${SKILL_NAME} skill → ${CLAUDE_SKILLS_DIR}/${SKILL_NAME}`, true)
    } else {
      check(`${SKILL_NAME} skill (${result.skipped})`, true)
    }
  }

  // 4. Credentials (env vars override dotfile)
  console.log("\nCredentials:")
  const dotfile = readCredentialsFile()
  const hasOpencode = existsSync(OPENCODE_AUTH_PATH)
  const hasApiKey = !!(process.env["ANTHROPIC_API_KEY"] || dotfile.ANTHROPIC_API_KEY)
  const hasClaude = !!(process.env["CLAUDE_CODE_OAUTH_TOKEN"] || dotfile.CLAUDE_CODE_OAUTH_TOKEN)
  check(
    "LLM credentials",
    hasOpencode || hasApiKey || hasClaude,
    "Run `tangerine config set ANTHROPIC_API_KEY=...` or `opencode auth login`",
  )
  if (hasOpencode) console.log("    (using opencode auth.json)")
  if (hasApiKey) console.log("    (using ANTHROPIC_API_KEY)")
  if (hasClaude) console.log("    (using CLAUDE_CODE_OAUTH_TOKEN)")

  const hasGithub = !!(process.env["GITHUB_TOKEN"] || dotfile.GITHUB_TOKEN)
  check("GITHUB_TOKEN", hasGithub, "Set GITHUB_TOKEN for PR creation and repo access")

  console.log()
}
