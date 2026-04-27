// CLI entrypoint: one-time setup for Tangerine.
// Checks system deps, creates directories, and symlinks agent skills.

import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, readlinkSync } from "fs"
import { join, resolve } from "path"
import { homedir } from "os"
import { TANGERINE_HOME } from "../config"

// Walk up from this file to find the package root (directory with package.json
// containing the package name). Works from both source and bundled locations.
function findProjectRoot(): string {
  let dir = import.meta.dir
  for (let i = 0; i < 5; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
      if (pkg.name === "@dinhtungdu/tangerine") return dir
    } catch { /* not this directory */ }
    dir = resolve(dir, "..")
  }
  return resolve(import.meta.dir, "../../../../")
}
const PROJECT_ROOT = findProjectRoot()
export const ACP_SKILLS_DIR = join(homedir(), ".config", "acp", "skills")

// Skills to symlink into agent skill directories.
// source: path relative to PROJECT_ROOT
// - platform-setup: for the operator to set up projects
// - tangerine-tasks: for agents running inside tasks to understand the API
// - browser-test: for agents to visually verify web UI changes
const SKILLS_TO_INSTALL: Array<{ name: string; source: string }> = [
  { name: "platform-setup", source: join(PROJECT_ROOT, "skills", "platform-setup") },
  { name: "tangerine-tasks", source: join(PROJECT_ROOT, "skills", "tangerine-tasks") },
  { name: "browser-test", source: join(PROJECT_ROOT, ".agents", "skills", "browser-test") },
]

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

export function symlinkSkill(
  skillSource: string,
  targetDir: string,
): { created: boolean; skipped: string | null } {
  const skillName = skillSource.split("/").at(-1)!
  const target = join(targetDir, skillName)

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

  ensureDir(targetDir)
  symlinkSync(skillSource, target)
  return { created: true, skipped: null }
}

export async function install(): Promise<void> {
  console.log("\nTangerine install\n")

  // 1. Directory structure
  console.log("Directories:")
  ensureDir(TANGERINE_HOME)
  check(`${TANGERINE_HOME}`, true)

  console.log(`\nACP skills:`)
  for (const skill of SKILLS_TO_INSTALL) {
    if (!existsSync(skill.source)) {
      check(`${skill.name} skill`, false, `skill source not found at ${skill.source}`)
      continue
    }
    const result = symlinkSkill(skill.source, ACP_SKILLS_DIR)
    if (result.created) {
      check(`${skill.name} skill → ${ACP_SKILLS_DIR}/${skill.name}`, true)
    } else {
      check(`${skill.name} skill (${result.skipped})`, true)
    }
  }

  console.log()
}
