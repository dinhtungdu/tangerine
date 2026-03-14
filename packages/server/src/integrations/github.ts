// GitHub integration: polls for issues matching trigger criteria.
// Wrapped in Effect with typed errors so polling failures surface
// as GitHubPollError instead of uncaught exceptions.

import { Effect } from "effect"
import { createLogger } from "../logger"
import { GitHubPollError } from "../errors"
/** Config shape needed by GitHub polling */
interface ProjectConfig {
  repo: string
  integrations?: {
    github?: {
      trigger: {
        type: "label" | "assignee"
        value: string
      }
    }
  }
}

const log = createLogger("github")

export interface GitHubDeps {
  createTask(params: {
    source: "github"
    sourceId: string
    sourceUrl: string
    title: string
    description: string
  }): void
  isTaskExists(sourceId: string): boolean
}

interface GitHubIssue {
  number: number
  title: string
  body: string | null
  html_url: string
  labels: Array<{ name: string }>
  assignee: { login: string } | null
}

export function pollGitHubIssues(
  config: ProjectConfig,
  deps: GitHubDeps,
): Effect.Effect<number, GitHubPollError> {
  return Effect.gen(function* () {
    const trigger = config.integrations?.github?.trigger
    if (!trigger) return 0

    const repo = config.repo
    log.debug("Polling GitHub", { repo, trigger: `${trigger.type}:${trigger.value}` })

    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(
          `https://api.github.com/repos/${repo}/issues?state=open&per_page=50`,
          {
            headers: {
              Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
              Accept: "application/vnd.github+json",
            },
          },
        ),
      catch: (e) =>
        new GitHubPollError({ message: "GitHub API request failed", cause: e }),
    })

    if (!response.ok) {
      return yield* Effect.fail(
        new GitHubPollError({
          message: `GitHub API returned ${response.status}: ${response.statusText}`,
          statusCode: response.status,
        }),
      )
    }

    const issues = yield* Effect.tryPromise({
      try: () => response.json() as Promise<GitHubIssue[]>,
      catch: (e) =>
        new GitHubPollError({ message: "Failed to parse GitHub response", cause: e }),
    })

    // Filter issues that match the configured trigger
    const matching = issues.filter((issue) => {
      if (trigger.type === "label") {
        return issue.labels.some((l) => l.name === trigger.value)
      }
      if (trigger.type === "assignee") {
        return issue.assignee?.login === trigger.value
      }
      return false
    })

    if (matching.length > 0) {
      log.info("Found new issues", { count: matching.length, repo })
    }

    let created = 0
    for (const issue of matching) {
      const sourceId = `github:${repo}#${issue.number}`

      if (deps.isTaskExists(sourceId)) {
        log.debug("Issue skipped (duplicate)", { issueNumber: issue.number, repo })
        continue
      }

      deps.createTask({
        source: "github",
        sourceId,
        sourceUrl: issue.html_url,
        title: issue.title,
        description: issue.body ?? "",
      })
      created++
    }

    return created
  })
}

export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string,
): boolean {
  // HMAC-SHA256 verification for GitHub webhook payloads
  const hmac = new Bun.CryptoHasher("sha256", secret)
  hmac.update(payload)
  const expected = `sha256=${hmac.digest("hex")}`

  // Constant-time comparison to prevent timing attacks
  if (expected.length !== signature.length) return false
  let mismatch = 0
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ signature.charCodeAt(i)
  }
  return mismatch === 0
}
