// CLI entrypoint: one-time setup for Tangerine.
// Checks system deps, creates directories, symlinks Claude Code skill.

import { existsSync, mkdirSync, symlinkSync, readlinkSync } from "fs"
import { join, resolve } from "path"
import { homedir } from "os"
import { TANGERINE_HOME, OPENCODE_AUTH_PATH, readCredentialsFile } from "../config"

const CLAUDE_SKILLS_DIR = join(homedir(), ".claude", "skills")

// Resolve project root relative to this file:
// packages/server/src/cli/install.ts → 4 levels up
const PROJECT_ROOT = resolve(import.meta.dir, "../../../../")

// Skills to symlink into ~/.claude/skills/:
// - tangerine-init: for the operator to set up projects
// - tangerine: for agents running inside tasks to understand the API
const SKILLS_TO_INSTALL = ["tangerine-init", "tangerine"]

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

function symlinkSkill(skillName: string): { created: boolean; skipped: string | null } {
  const skillSource = join(PROJECT_ROOT, "skills", skillName)
  const target = join(CLAUDE_SKILLS_DIR, skillName)

  if (existsSync(target)) {
    // Check if it already points to the right place
    try {
      const current = readlinkSync(target)
      if (resolve(current) === resolve(skillSource)) {
        return { created: false, skipped: "already linked" }
      }
    } catch {
      // Not a symlink — existing dir/file
    }
    return { created: false, skipped: "path exists, not overwriting" }
  }

  ensureDir(CLAUDE_SKILLS_DIR)
  symlinkSync(skillSource, target)
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

  // 3. Claude Code skills
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
