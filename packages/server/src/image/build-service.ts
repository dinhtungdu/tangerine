// Build service — placeholder. Base image concept removed; each project VM
// provisions from template + base-setup.sh + build.sh on first use.

export interface BuildState {
  status: "building" | "success" | "failed"
  imageName: string
  startedAt: string
  finishedAt?: string
  error?: string
}

export function getBuildStatus(): { status: "idle" } {
  return { status: "idle" }
}
