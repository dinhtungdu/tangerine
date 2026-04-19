// Skill discovery utilities: scan filesystem directories for installed agent skills.
// Used by OpenCode (reads ~/.claude/skills/) and Codex (reads ~/.codex/skills/).

import { readdirSync, existsSync, statSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

/** Return non-hidden skill names (directory names) found directly under the given path.
 * Follows symlinks so that package-manager-linked skills (e.g. ~/.codex/skills/foo -> ...)
 * are included alongside real directories. */
export function scanSkillsDir(dir: string): string[] {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => {
        if (d.name.startsWith(".")) return false
        if (d.isDirectory()) return true
        // Symlinks to directories (common for linked skill packages)
        if (d.isSymbolicLink()) {
          try {
            return statSync(join(dir, d.name)).isDirectory()
          } catch {
            return false
          }
        }
        return false
      })
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
  // Deduplicate in case the same skill name appears in both directories.
  return [...new Set([
    ...scanSkillsDir(base),
    ...scanSkillsDir(join(base, ".system")),
  ])]
}

