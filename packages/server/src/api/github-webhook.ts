import { Effect } from "effect"
import type { Database } from "bun:sqlite"
import { createLogger } from "../logger"
import { verifyWebhookSignature } from "../integrations/github"
import type { AppDeps } from "./app"

const log = createLogger("api:github-webhook")

export interface GitHubIssueWebhookPayload {
  action: string
  issue?: {
    number: number
    title: string
    body: string | null
    html_url: string
    labels: Array<{ name: string }>
    assignee: { login: string } | null
  }
  repository?: { full_name: string }
}

export interface GitHubWebhookResult {
  status: number
  body: Record<string, unknown>
}

function matchesConfiguredRepo(repo: string, repoFullName: string): boolean {
  return repo === repoFullName || repo.endsWith(`/${repoFullName}`) || repo.endsWith(`/${repoFullName}.git`)
}

function hasTaskForSourceId(db: Database, sourceId: string): boolean {
  const row = db.prepare("SELECT 1 FROM tasks WHERE source_id = ? LIMIT 1").get(sourceId)
  return Boolean(row)
}

export async function processGitHubWebhook(
  deps: AppDeps,
  params: {
    rawBody: string
    event?: string
    signature?: string
    verifySignature?: boolean
  },
): Promise<GitHubWebhookResult> {
  const verifySignatureEnabled = params.verifySignature ?? true
  const webhookSecret = deps.config.config.integrations?.github?.webhookSecret

  if (verifySignatureEnabled && webhookSecret) {
    const signature = params.signature ?? ""
    if (!verifyWebhookSignature(params.rawBody, signature, webhookSecret)) {
      return { status: 401, body: { error: "Invalid signature" } }
    }
  }

  let payload: GitHubIssueWebhookPayload
  try {
    payload = JSON.parse(params.rawBody) as GitHubIssueWebhookPayload
  } catch {
    return { status: 400, body: { error: "Invalid JSON payload" } }
  }

  const event = params.event
  if (event !== "issues" || !payload.issue || !payload.repository) {
    return { status: 202, body: { received: true, ignored: true } }
  }

  const actionableActions = new Set(["opened", "labeled", "assigned"])
  if (!actionableActions.has(payload.action)) {
    return { status: 202, body: { received: true, ignored: true } }
  }

  const repoFullName = payload.repository.full_name
  const project = deps.config.config.projects.find((candidate) => matchesConfiguredRepo(candidate.repo, repoFullName))
  if (!project) {
    log.warn("Webhook received for unknown repo", { repo: repoFullName })
    return { status: 202, body: { received: true, ignored: true } }
  }

  const trigger = deps.config.config.integrations?.github?.trigger
  if (trigger) {
    if (trigger.type === "label" && !payload.issue.labels.some((label) => label.name === trigger.value)) {
      return { status: 202, body: { received: true, ignored: true } }
    }
    if (trigger.type === "assignee" && payload.issue.assignee?.login !== trigger.value) {
      return { status: 202, body: { received: true, ignored: true } }
    }
  }

  const sourceId = `github:${repoFullName}#${payload.issue.number}`
  if (hasTaskForSourceId(deps.db, sourceId)) {
    return { status: 202, body: { received: true, ignored: true, duplicate: true } }
  }

  const result = await Effect.runPromiseExit(
    deps.taskManager.createTask({
      source: "github",
      projectId: project.name,
      title: payload.issue.title,
      description: payload.issue.body ?? undefined,
      sourceId,
      sourceUrl: payload.issue.html_url,
    }),
  )

  if (result._tag === "Failure") {
    log.error("Webhook task creation failed", { repo: repoFullName, issue: payload.issue.number })
    return { status: 500, body: { error: "Task creation failed" } }
  }

  log.info("Task created from webhook", { taskId: result.value.id, issue: payload.issue.number, repo: repoFullName })
  return { status: 202, body: { received: true, taskId: result.value.id } }
}
