// Shared system tool checks used by both daemon and foreground startup.
// Sync (spawnSync) so it works in both contexts without async plumbing.

import { spawnSync } from "child_process"
import { type SystemCapabilities } from "@tangerine/shared"

export interface SystemCheckResult {
  errors: string[]
  warnings: string[]
  capabilities: SystemCapabilities
}

/** Merge login-shell PATH entries into process.env.PATH so tool checks see
 *  the same executables the server will find at runtime. Mutates process.env. */
export function applyLoginShellPath(): void {
  try {
    const shell = process.env["SHELL"] || "/bin/bash"
    const result = spawnSync(shell, ["-lc", 'echo "$PATH"'], { encoding: "utf-8", timeout: 3_000 })
    const loginPath = result.stdout?.trim().split("\n").pop()
    if (result.status === 0 && loginPath) {
      const currentPath = process.env["PATH"] || ""
      const currentDirs = new Set(currentPath.split(":").filter(Boolean))
      const newDirs = loginPath.split(":").filter((d) => d && !currentDirs.has(d))
      if (newDirs.length > 0) {
        process.env["PATH"] = [currentPath, ...newDirs].filter(Boolean).join(":")
      }
    }
  } catch { /* non-fatal — proceed with existing PATH */ }
}

/** Run all system tool checks. Returns errors (fatal), warnings (non-fatal),
 *  and capabilities for the API. Call applyLoginShellPath() first if PATH
 *  may be incomplete. */
export function checkSystemTools(options: {
  hasGithubProject: boolean
  providers?: Array<{ id: string; cliCommand: string }>
}): SystemCheckResult {
  const errors: string[] = []
  const warnings: string[] = []
  const capabilities: SystemCapabilities = {
    git: { available: true },
    gh: { available: false, authenticated: false },
    dtach: { available: false },
    providers: {},
  }

  const cmdExists = (cmd: string): boolean =>
    spawnSync("which", [cmd], { stdio: "ignore" }).status === 0

  // git — required for worktrees, fetch, branch operations
  if (!cmdExists("git")) {
    capabilities.git.available = false
    errors.push("git is not installed — worktree setup and branch operations will not work.")
  }

  // gh — required for PR capture and polling when GitHub projects are configured
  const ghProxy: NodeJS.ProcessEnv | undefined = process.env["GHE_PROXY"]
    ? {
      ...process.env,
      HTTPS_PROXY: process.env["GHE_PROXY"],
      HTTP_PROXY: process.env["GHE_PROXY"],
      NO_PROXY: "localhost,127.0.0.1,host.lima.internal,github.com,api.github.com",
      no_proxy: "localhost,127.0.0.1,host.lima.internal,github.com,api.github.com",
    }
    : undefined

  if (cmdExists("gh")) {
    capabilities.gh.available = true
    const ghAuth = spawnSync("gh", ["auth", "status"], { stdio: "ignore", env: ghProxy })
    if (ghAuth.status === 0) {
      capabilities.gh.authenticated = true
    } else if (options.hasGithubProject) {
      warnings.push("gh CLI is not authenticated — PR capture and GitHub polling will not work. Run `gh auth login`.")
    }
  } else if (options.hasGithubProject) {
    warnings.push("gh CLI is not installed — PR capture and auto-complete will not work. Install from https://cli.github.com/")
  }

  // dtach — needed for persistent terminal sessions
  if (cmdExists("dtach")) {
    capabilities.dtach.available = true
  } else {
    warnings.push("dtach is not installed — terminal sessions will not work.")
  }

  // Agent provider CLIs
  for (const { id, cliCommand } of options.providers ?? []) {
    const available = cmdExists(cliCommand)
    capabilities.providers[id] = { available, cliCommand }
    if (!available) {
      warnings.push(`${cliCommand} CLI is not installed — provider "${id}" will not be available.`)
    }
  }

  return { errors, warnings, capabilities }
}
