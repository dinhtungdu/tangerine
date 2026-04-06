// Skill discovery utilities: scan filesystem directories for installed agent skills.
// Used by OpenCode (reads ~/.claude/skills/) and Codex (reads ~/.codex/skills/).

import { readdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

/** Return non-hidden skill names (directory names) found directly under the given path. */
export function scanSkillsDir(dir: string): string[] {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name)
  } catch {
    return []
  }
}

export function scanClaudeSkills(): string[] {
  return scanSkillsDir(join(homedir(), ".claude", "skills"))
}

export function scanCodexSkills(): string[] {
  const base = join(homedir(), ".codex", "skills")
  // User-installed skills sit directly under base; system skills live under .system/.
  // We surface both so built-in codex skills (imagegen, openai-docs, etc.) are discoverable.
  return [
    ...scanSkillsDir(base),
    ...scanSkillsDir(join(base, ".system")),
  ]
}

