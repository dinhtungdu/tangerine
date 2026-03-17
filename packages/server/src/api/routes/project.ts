import { Hono } from "hono"
import type { AppDeps } from "../app"
import { discoverModels } from "../../models"

export function projectRoutes(deps: AppDeps): Hono {
  const app = new Hono()

  // List all configured projects + available models from OpenCode
  app.get("/", (c) => {
    const discovered = discoverModels()
    const configModels = deps.config.config.models
    // Use discovered models if available, fall back to config
    const models = discovered.length > 0
      ? discovered.map((m) => m.id)
      : configModels

    return c.json({
      projects: deps.config.config.projects,
      model: deps.config.config.model,
      models,
    })
  })

  // Get a single project by name
  app.get("/:name", (c) => {
    const name = c.req.param("name")
    const project = deps.config.config.projects.find((p) => p.name === name)
    if (!project) {
      return c.json({ error: "Project not found" }, 404)
    }
    return c.json(project)
  })

  return app
}
