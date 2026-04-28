import { statSync } from "node:fs"
import { join } from "node:path"
import { cleanGitEnv } from "../git-env"

export interface MentionFile {
  path: string
}

export interface ListFilesForMentionOptions {
  limit?: number
  source?: "worktree" | "head"
}

export async function listFilesForMention(root: string, query = "", options: number | ListFilesForMentionOptions = {}): Promise<MentionFile[]> {
  const limit = typeof options === "number" ? options : (options.limit ?? 50)
  const source = typeof options === "number" ? "worktree" : (options.source ?? "worktree")
  const args = source === "head"
    ? ["git", "ls-tree", "-r", "--name-only", "HEAD"]
    : ["git", "ls-files", "-co", "--exclude-standard"]
  const proc = Bun.spawn(args, {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: cleanGitEnv(),
  })
  const [stdout, , exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode !== 0) return []

  const q = query.trim().toLowerCase()
  const seen = new Set<string>()
  const files: MentionFile[] = []
  for (const line of stdout.split("\n")) {
    const path = line.trim()
    if (!path || seen.has(path)) continue
    if (source === "worktree" && !isExistingMentionFile(root, path)) continue
    if (q && !path.toLowerCase().includes(q)) continue
    seen.add(path)
    files.push({ path })
    if (files.length >= limit) break
  }
  return files
}

function isExistingMentionFile(root: string, path: string): boolean {
  try {
    return statSync(join(root, path)).isFile()
  } catch {
    return false
  }
}
