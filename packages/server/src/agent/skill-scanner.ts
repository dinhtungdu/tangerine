// Skill discovery utilities: scan filesystem directories for installed agent skills.
// Used by OpenCode (reads ~/.claude/skills/) and Codex (reads ~/.codex/skills/).

import { readdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

/** Return skill names (directory names) found under the given path. */
export function scanSkillsDir(dir: string): string[] {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
}

export function scanClaudeSkills(): string[] {
  return scanSkillsDir(join(homedir(), ".claude", "skills"))
}

export function scanCodexSkills(): string[] {
  return scanSkillsDir(join(homedir(), ".codex", "skills"))
}
