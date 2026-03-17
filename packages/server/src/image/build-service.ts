// In-memory build state manager for golden image builds.
// If the server restarts mid-build, state resets to idle — acceptable for local-first.

import { createLogger } from "../logger"
import { buildImage } from "./build"

export interface BuildState {
  status: "building" | "success" | "failed"
  imageName: string
  startedAt: string
  finishedAt?: string
  error?: string
}

let currentBuild: BuildState | null = null

export function startBuild(imageName: string): { ok: true } | { ok: false; reason: string } {
  if (currentBuild?.status === "building") {
    return { ok: false, reason: `Already building image "${currentBuild.imageName}"` }
  }

  currentBuild = {
    status: "building",
    imageName,
    startedAt: new Date().toISOString(),
  }

  const log = createLogger("image:build")

  // Fire-and-forget — state updated on completion/failure
  // Dashboard rebuilds only the project layer; base must already exist
  buildImage(imageName, log, { requireBase: true })
    .then(() => {
      if (currentBuild?.imageName === imageName && currentBuild.status === "building") {
        currentBuild = {
          ...currentBuild,
          status: "success",
          finishedAt: new Date().toISOString(),
        }
      }
    })
    .catch((err) => {
      const errorMessage = err instanceof Error ? err.message : String(err)
      log.error("Build failed", { imageName, error: errorMessage })
      if (currentBuild?.imageName === imageName && currentBuild.status === "building") {
        currentBuild = {
          ...currentBuild,
          status: "failed",
          finishedAt: new Date().toISOString(),
          error: errorMessage,
        }
      }
    })

  return { ok: true }
}

export function getBuildStatus(): BuildState | { status: "idle" } {
  return currentBuild ?? { status: "idle" }
}
