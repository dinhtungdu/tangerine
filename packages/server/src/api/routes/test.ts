import { Hono } from "hono"
import type { AppDeps } from "../app"
import { processGitHubWebhook, type GitHubIssueWebhookPayload } from "../github-webhook"
import { loadDefaultSeedFixture, resetSeedData, seedFixtureData, type SeedFixture } from "../test-support"

interface WebhookSimulationRequest {
  event?: string
  payload?: GitHubIssueWebhookPayload
}

export function testRoutes(deps: AppDeps): Hono {
  const app = new Hono()

  app.post("/seed", async (c) => {
    const rawBody = await c.req.text()
    const fixture = rawBody.trim().length > 0 ? JSON.parse(rawBody) as SeedFixture : await loadDefaultSeedFixture()
    const inserted = seedFixtureData(deps.db, fixture, deps.config.config.projects)
    return c.json({ ok: true, inserted })
  })

  app.post("/reset", (c) => {
    const deleted = resetSeedData(deps.db)
    return c.json({ ok: true, deleted })
  })

  app.post("/simulate-webhook", async (c) => {
    const rawBody = await c.req.text()
    let event = c.req.header("x-github-event") ?? "issues"
    let webhookBody = rawBody

    if (rawBody.trim().length > 0) {
      const parsed = JSON.parse(rawBody) as GitHubIssueWebhookPayload | WebhookSimulationRequest
      if ("payload" in parsed) {
        event = parsed.event ?? event
        webhookBody = JSON.stringify(parsed.payload ?? {})
      }
    } else {
      webhookBody = "{}"
    }

    const result = await processGitHubWebhook(deps, {
      rawBody: webhookBody,
      event,
      verifySignature: false,
    })
    return c.json(result.body, result.status as 200 | 202 | 400 | 401 | 500)
  })

  return app
}
