// Skill discovery utilities: scan filesystem directories for installed agent skills.
// Used by OpenCode (reads ~/.claude/skills/) and Codex (reads ~/.codex/skills/).

import { readdirSync, existsSync, readFileSync } from "node:fs"
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

/**
 * Read SKILL.md content for a named skill, searching each directory in order.
 * Returns the content of the first match, or null if not found in any directory.
 */
export function readSkillContent(skillName: string, ...skillsDirs: string[]): string | null {
  for (const dir of skillsDirs) {
    const skillPath = join(dir, skillName, "SKILL.md")
    if (existsSync(skillPath)) {
      try {
        return readFileSync(skillPath, "utf-8")
      } catch {
        continue
      }
    }
  }
  return null
}

/**
 * If `text` starts with a slash command (`/skill-name`), replace it with the skill's
 * SKILL.md content. Additional text after the skill name is appended after the content.
 * Returns the original text unchanged if the skill is not found or text doesn't start
 * with a slash command.
 *
 * This is used for providers that lack native skill support (all providers except
 * claude-code, which handles /skill-name natively via its CLI).
 */
export function resolveSkillInvocation(text: string, ...skillsDirs: string[]): string {
  const trimmed = text.trim()
  const match = trimmed.match(/^\/(\S+)([\s\S]*)$/)
  if (!match) return text
  const skillName = match[1]!
  const rest = (match[2] ?? "").trim()
  const content = readSkillContent(skillName, ...skillsDirs)
  if (!content) return text
  return rest ? `${content}\n\n${rest}` : content
}
