import { Effect } from "effect"
import { Hono } from "hono"
import type { AppDeps } from "../app"
import { runEffect } from "../effect-helpers"
import { AgentError } from "../../errors"

export function previewRoutes(deps: AppDeps): Hono {
  const app = new Hono()

  // Proxy all methods to the task's preview port (tunnel created lazily on first access)
  app.all("/:id/*", async (c) => {
    const id = c.req.param("id")

    return runEffect(c,
      Effect.gen(function* () {
        const previewPort = yield* deps.getOrCreatePreviewPort(id).pipe(
          Effect.mapError((e) => new AgentError({ message: e.message ?? "No preview available", taskId: id }))
        )

        // Strip the /preview/:id prefix to get the downstream path
        const url = new URL(c.req.url)
        const prefix = `/preview/${id}`
        const downstreamPath = url.pathname.slice(prefix.length) || "/"
        const target = `http://localhost:${previewPort}${downstreamPath}${url.search}`

        const headers = new Headers(c.req.raw.headers)
        headers.set("Host", c.req.header("host") ?? `localhost:${previewPort}`)
        // Remove hop-by-hop headers that shouldn't be forwarded
        headers.delete("connection")
        headers.delete("keep-alive")

        const response = yield* Effect.tryPromise({
          try: () => fetch(target, {
            method: c.req.method,
            headers,
            body: c.req.method !== "GET" && c.req.method !== "HEAD" ? c.req.raw.body : undefined,
          }),
          catch: (e) => new AgentError({ message: "Preview service unavailable", taskId: id, cause: e }),
        })

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      }),
      { errorMap: { AgentError: 502 } }
    )
  })

  return app
}
