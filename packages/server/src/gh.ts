// Shared utilities for shelling out to the `gh` CLI.
// Handles GHE SOCKS proxy injection so every call site gets it for free.

/**
 * Build env + spawn options for `gh` CLI commands.
 * When GHE_PROXY is set, injects HTTPS_PROXY/HTTP_PROXY so `gh` (Go net/http)
 * can reach GitHub Enterprise through the SOCKS proxy. github.com is excluded
 * via NO_PROXY so public repos still go direct.
 *
 * Uses HTTPS_PROXY rather than ALL_PROXY because Go's net/http honours
 * HTTPS_PROXY for HTTPS URLs but handles ALL_PROXY inconsistently with SOCKS5.
 */
export function ghSpawnEnv(extra?: Record<string, unknown>): Record<string, unknown> {
  const proxy = process.env.GHE_PROXY
  const base = {
    stdout: "pipe" as const,
    stderr: "pipe" as const,
    ...extra,
  }

  if (!proxy) return base

  return {
    ...base,
    env: {
      ...process.env,
      HTTPS_PROXY: proxy,
      HTTP_PROXY: proxy,
      NO_PROXY: "localhost,127.0.0.1,host.lima.internal,github.com,api.github.com",
      no_proxy: "localhost,127.0.0.1,host.lima.internal,github.com,api.github.com",
      ...(extra?.env as Record<string, string> | undefined),
    },
  }
}

/**
 * Extract the GitHub host from a repo URL (github.com, github.example.com, etc).
 * Returns null if the URL is not a recognisable GitHub URL.
 */
export function extractGithubHost(repoUrl: string): string | null {
  const match = repoUrl.match(/(github(?:\.[a-z0-9-]+)*\.[a-z]+)[/:]/)
  return match ? (match[1] ?? null) : null
}

/**
 * Build spawn env for `gh` commands targeting a specific GitHub host.
 * Explicitly sets GH_HOST so the CLI doesn't fall back to the active account's
 * host (e.g. GHE) when the target is github.com.
 */
export function ghSpawnEnvForHost(ghHost: string): Record<string, unknown> {
  const proxy = process.env.GHE_PROXY
  return {
    stdout: "pipe" as const,
    stderr: "pipe" as const,
    env: {
      ...process.env,
      GH_HOST: ghHost,
      ...(proxy ? {
        HTTPS_PROXY: proxy,
        HTTP_PROXY: proxy,
        NO_PROXY: "localhost,127.0.0.1,host.lima.internal,github.com,api.github.com",
        no_proxy: "localhost,127.0.0.1,host.lima.internal,github.com,api.github.com",
      } : {}),
    },
  }
}

/**
 * Match a PR URL from any GitHub host (github.com, github.example.com, etc).
 * Captures: host, owner, repo, PR number.
 */
const GITHUB_PR_URL_RE = /https:\/\/github(?:\.[a-z0-9-]+)*\.[a-z]+\/[\w.-]+\/[\w.-]+\/pull\/\d+/

/** Extract a GitHub PR URL from text (works with both github.com and GHE hosts). */
export function extractPrUrl(text: string): string | null {
  const match = text.match(GITHUB_PR_URL_RE)
  return match ? match[0] : null
}

/**
 * Extract a repo slug suitable for the `gh` CLI from a GitHub repo URL.
 * For github.com returns `owner/repo`; for GHE returns `host/owner/repo`
 * so that `gh` targets the correct host.
 */
export function extractGithubSlug(repoUrl: string): string | null {
  const match = repoUrl.match(/(github(?:\.[a-z0-9-]+)*\.[a-z]+)[/:]([^/]+\/[^/.]+?)(?:\.git)?$/)
  if (!match) return null
  const [, host, slug] = match
  // gh CLI defaults to github.com for bare owner/repo slugs
  return host === "github.com" ? slug! : `${host}/${slug}`
}

// Re-export from shared — single source of truth for both server and web
export { isGithubRepo } from "@tangerine/shared"

export interface RepoForkInfo {
  isFork: boolean
  parentSlug: string | null
}

/**
 * Resolve a repo config value to a slug usable with `gh` CLI.
 * Handles full URLs (via extractGithubSlug) and bare `owner/repo` shorthand.
 */
export function resolveGithubSlug(repo: string): string | null {
  return extractGithubSlug(repo) ?? (/^[^/]+\/[^/]+$/.test(repo) ? repo : null)
}

/**
 * Check if a GitHub repo is a fork and return its parent slug.
 * Uses `gh repo view` which handles both bare and host-qualified slugs.
 * Throws on gh CLI failure (auth/network) so callers can distinguish
 * "not a fork" from "couldn't check".
 */
export async function getRepoForkInfo(repoSlug: string, repoUrl?: string): Promise<RepoForkInfo> {
  const host = (repoUrl ? extractGithubHost(repoUrl) : null) ?? "github.com"
  const proc = Bun.spawn(
    ["gh", "repo", "view", repoSlug, "--json", "isFork,parent", "--jq", "[.isFork, .parent.nameWithOwner] | @tsv"],
    ghSpawnEnvForHost(host),
  )
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || stdout.trim() || `gh repo view exited with ${exitCode}`)
  }
  const parts = stdout.trim().split("\t")
  const isFork = parts[0] === "true"
  const parentSlug = isFork && parts[1] ? parts[1] : null
  return { isFork, parentSlug }
}

/**
 * Sync a forked repo from its upstream using `gh repo sync`.
 * Returns stdout on success, throws on failure.
 */
export async function syncForkRepo(repoSlug: string, repoUrl?: string): Promise<string> {
  const host = (repoUrl ? extractGithubHost(repoUrl) : null) ?? "github.com"
  const proc = Bun.spawn(
    ["gh", "repo", "sync", repoSlug],
    ghSpawnEnvForHost(host),
  )
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || stdout.trim() || `gh repo sync exited with ${exitCode}`)
  }
  return stdout.trim()
}
