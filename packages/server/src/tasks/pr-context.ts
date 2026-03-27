// Fetch PR metadata and diff for review tasks using the `gh` CLI.

import { createLogger } from "../logger"

const log = createLogger("pr-context")

export interface PrContext {
  number: number
  title: string
  body: string
  author: string
  baseBranch: string
  headBranch: string
  url: string
  files: string[]
  diff: string
}

/**
 * Fetch full PR context (metadata + diff) for a review task.
 * Requires `gh` CLI authenticated with access to the repo.
 */
export async function fetchPrContext(repoDir: string, prNumber: number): Promise<PrContext | null> {
  try {
    // Fetch metadata and diff in parallel
    const [metaResult, diffResult] = await Promise.all([
      runGh(repoDir, ["pr", "view", String(prNumber), "--json", "title,body,author,baseRefName,headRefName,url,files"]),
      runGh(repoDir, ["pr", "diff", String(prNumber)]),
    ])

    if (!metaResult || !diffResult) return null

    const meta = JSON.parse(metaResult) as {
      title: string
      body: string
      author: { login: string }
      baseRefName: string
      headRefName: string
      url: string
      files: Array<{ path: string }>
    }

    return {
      number: prNumber,
      title: meta.title,
      body: meta.body ?? "",
      author: meta.author.login,
      baseBranch: meta.baseRefName,
      headBranch: meta.headRefName,
      url: meta.url,
      files: meta.files.map((f) => f.path),
      diff: diffResult,
    }
  } catch (err) {
    log.error("Failed to fetch PR context", { prNumber, error: String(err) })
    return null
  }
}

async function runGh(cwd: string, args: string[]): Promise<string | null> {
  const proc = Bun.spawn(["gh", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, , exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode !== 0) return null
  return stdout
}
