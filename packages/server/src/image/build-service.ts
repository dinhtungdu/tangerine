// In-memory build state manager for base image builds.
// If the server restarts mid-build, state resets to idle — acceptable for local-first.

import { createLogger } from "../logger"
import { buildBase } from "./build"

export interface BuildState {
  status: "building" | "success" | "failed"
  imageName: string
  startedAt: string
  finishedAt?: string
  error?: string
}

let currentBuild: BuildState | null = null

export function startBaseBuild(): { ok: true } | { ok: false; reason: string } {
  if (currentBuild?.status === "building") {
    return { ok: false, reason: `Already building image "${currentBuild.imageName}"` }
  }

  currentBuild = {
    status: "building",
    imageName: "base",
    startedAt: new Date().toISOString(),
  }

  const log = createLogger("image:build")

  buildBase(log)
    .then(() => {
      if (currentBuild?.imageName === "base" && currentBuild.status === "building") {
        currentBuild = { ...currentBuild, status: "success", finishedAt: new Date().toISOString() }
      }
    })
    .catch((err) => {
      const errorMessage = err instanceof Error ? err.message : String(err)
      log.error("Base build failed", { error: errorMessage })
      if (currentBuild?.imageName === "base" && currentBuild.status === "building") {
        currentBuild = { ...currentBuild, status: "failed", finishedAt: new Date().toISOString(), error: errorMessage }
      }
    })

  return { ok: true }
}

export function getBuildStatus(): BuildState | { status: "idle" } {
  return currentBuild ?? { status: "idle" }
}
