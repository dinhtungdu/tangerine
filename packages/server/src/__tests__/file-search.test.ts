import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"
import { listFilesForMention } from "../api/file-search"
import { cleanGitEnv } from "../git-env"

const gitEnvKeys = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR"]
const originalGitEnv = Object.fromEntries(gitEnvKeys.map((key) => [key, process.env[key]]))

afterEach(() => {
  for (const key of gitEnvKeys) {
    const value = originalGitEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe("listFilesForMention", () => {
  test("ignores inherited git hook env and lists the requested repo", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tangerine-file-search-"))
    try {
      mkdirSync(join(repo, "src"), { recursive: true })
      writeFileSync(join(repo, "src", "only-here.ts"), "export {}\n")
      Bun.spawnSync(["git", "init", repo], { env: cleanGitEnv() })

      const gitDir = Bun.spawnSync(["git", "rev-parse", "--git-dir"], { env: cleanGitEnv() }).stdout.toString().trim()
      const gitCommonDir = Bun.spawnSync(["git", "rev-parse", "--git-common-dir"], { env: cleanGitEnv() }).stdout.toString().trim()
      const moduleUrl = pathToFileURL(join(import.meta.dir, "..", "api", "file-search.ts")).href
      const script = `const { listFilesForMention } = await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify(await listFilesForMention(${JSON.stringify(repo)}, "only", 10)))`
      const result = Bun.spawnSync(["bun", "-e", script], {
        cwd: process.cwd(),
        env: {
          ...cleanGitEnv(),
          GIT_DIR: gitDir,
          GIT_WORK_TREE: process.cwd(),
          GIT_COMMON_DIR: gitCommonDir,
        },
      })

      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout.toString()) as Array<{ path: string }>).toEqual([{ path: "src/only-here.ts" }])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test("omits deleted tracked files from worktree results", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tangerine-file-search-deleted-"))
    try {
      writeFileSync(join(repo, "keep.ts"), "export const keep = true\n")
      writeFileSync(join(repo, "deleted.ts"), "export const deleted = true\n")
      Bun.spawnSync(["git", "init", repo], { env: cleanGitEnv() })
      Bun.spawnSync(["git", "-C", repo, "add", "."], { env: cleanGitEnv() })
      Bun.spawnSync(["git", "-C", repo, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "init"], { env: cleanGitEnv() })
      rmSync(join(repo, "deleted.ts"), { force: true })

      const files = await listFilesForMention(repo, "", { source: "worktree" })

      expect(files).toContainEqual({ path: "keep.ts" })
      expect(files).not.toContainEqual({ path: "deleted.ts" })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
