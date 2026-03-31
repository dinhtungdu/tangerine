// Shared utilities for shelling out to the `gh` CLI.
// Handles GHE SOCKS proxy injection so every call site gets it for free.

/**
 * Build env + spawn options for `gh` CLI commands.
 * When GHE_PROXY is set, injects ALL_PROXY/NO_PROXY so `gh` can reach
 * GitHub Enterprise through the SOCKS proxy. github.com traffic is excluded
 * via NO_PROXY so public repos still go direct.
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
      ALL_PROXY: proxy,
      all_proxy: proxy,
      NO_PROXY: "localhost,127.0.0.1,host.lima.internal,github.com,api.github.com",
      no_proxy: "localhost,127.0.0.1,host.lima.internal,github.com,api.github.com",
      ...(extra?.env as Record<string, string> | undefined),
    },
  }
}

/**
 * Match a PR URL from any GitHub host (github.com, github.a8c.com, etc).
 * Captures: host, owner, repo, PR number.
 */
const GITHUB_PR_URL_RE = /https:\/\/github(?:\.[a-z0-9-]+)*\.[a-z]+\/[\w.-]+\/[\w.-]+\/pull\/\d+/

/** Extract a GitHub PR URL from text (works with both github.com and GHE hosts). */
export function extractPrUrl(text: string): string | null {
  const match = text.match(GITHUB_PR_URL_RE)
  return match ? match[0] : null
}

/**
 * Extract `owner/repo` slug from a GitHub repo URL.
 * Handles both github.com and GHE hosts (e.g. github.a8c.com).
 */
export function extractGithubSlug(repoUrl: string): string | null {
  const match = repoUrl.match(/github(?:\.[a-z0-9-]+)*\.[a-z]+[/:]([^/]+\/[^/.]+?)(?:\.git)?$/)
  return match ? match[1]! : null
}

/**
 * Check if a repo string refers to a GitHub-hosted repo (including GHE).
 * Matches full URLs (github.com/o/r, github.a8c.com/o/r) and owner/repo shorthand.
 */
export function isGithubRepo(repo: string): boolean {
  return /github(?:\.[a-z0-9-]+)*\.[a-z]+/.test(repo) || /^[^/]+\/[^/]+$/.test(repo)
}
