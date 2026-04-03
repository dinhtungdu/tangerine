// Filesystem-based skill discovery for providers that don't report skills at init.
// Scans skill directories (e.g. ~/.claude/skills/, ~/.codex/skills/) and reads
// SKILL.md frontmatter to build a skills list.

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

/**
 * Scan a directory for skill subdirectories containing SKILL.md.
 * Returns an array of skill names found.
 */
export function scanSkillsDir(dir: string): string[] {
  try {
    const entries = readdirSync(dir)
    const skills: string[] = []
    for (const entry of entries) {
      if (entry.startsWith(".")) continue
      const skillPath = join(dir, entry)
      try {
        if (!statSync(skillPath).isDirectory()) continue
        // Check for SKILL.md (case-insensitive)
        const files = readdirSync(skillPath)
        const hasSkillMd = files.some((f) => f.toLowerCase() === "skill.md")
        if (hasSkillMd) {
          // Try to read the name from frontmatter, fall back to dir name
          const name = readSkillName(join(skillPath, files.find((f) => f.toLowerCase() === "skill.md")!)) ?? entry
          skills.push(name)
        }
      } catch {
        // Skip unreadable entries
      }
    }
    return skills
  } catch {
    return []
  }
}

function readSkillName(path: string): string | null {
  try {
    const content = readFileSync(path, "utf-8")
    const match = content.match(/^---\s*\n[\s\S]*?^name:\s*(.+)/m)
    return match?.[1]?.trim() ?? null
  } catch {
    return null
  }
}
