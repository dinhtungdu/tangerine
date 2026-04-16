import { Hono } from "hono"
import type { AppDeps } from "../app"
import { buildAuthSession } from "../../auth"

export function authRoutes(deps: AppDeps): Hono {
  const app = new Hono()

  app.get("/session", (c) => c.json(buildAuthSession(c, deps.config)))

  return app
}
