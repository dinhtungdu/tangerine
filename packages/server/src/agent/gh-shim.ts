// Generates and installs a `gh` shim script into a worktree's .tangerine/bin/
// directory. The shim intercepts `gh pr create` and enforces the project's
// prMode setting (draft/ready/none) at the infrastructure level, so agents
// can't bypass it regardless of their instructions.

import { Effect } from "effect"
import { createLogger } from "../logger"

const log = createLogger("gh-shim")

export type PrMode = "draft" | "ready" | "none"

/**
 * Generate the gh shim script content with baked-in configuration.
 * Exported for testing.
 */
export function generateShimScript(realGhPath: string, prMode: PrMode): string {
  // Use array join to avoid template literal $ escaping issues with bash variables
  const lines = [
    '#!/usr/bin/env bash',
    `# Tangerine gh shim — enforces prMode="${prMode}" for gh pr create.`,
    'set -euo pipefail',
    '',
    `REAL_GH="${realGhPath}"`,
    '',
    '# Pass through if not `gh pr create`',
    'is_pr_create=false',
    'prev=""',
    'for arg in "$@"; do',
    '  if [[ "$arg" == "create" && "$prev" == "pr" ]]; then',
    '    is_pr_create=true',
    '    break',
    '  fi',
    '  prev="$arg"',
    'done',
    '',
    'if [[ "$is_pr_create" != "true" ]]; then',
    '  exec "$REAL_GH" "$@"',
    'fi',
    '',
    '# Enforce prMode',
    `case "${prMode}" in`,
    '  none)',
    '    echo "Error: PR creation is disabled for this project (prMode=none)." >&2',
    '    exit 1',
    '    ;;',
    '  draft)',
    '    has_draft=false',
    '    for arg in "$@"; do',
    '      if [[ "$arg" == "--draft" ]]; then',
    '        has_draft=true',
    '        break',
    '      fi',
    '    done',
    '    if [[ "$has_draft" == "false" ]]; then',
    '      exec "$REAL_GH" "$@" --draft',
    '    else',
    '      exec "$REAL_GH" "$@"',
    '    fi',
    '    ;;',
    '  *)',
    '    exec "$REAL_GH" "$@"',
    '    ;;',
    'esac',
    '',
  ]
  return lines.join('\n')
}

/**
 * Find the real gh binary path, skipping any tangerine shim directories.
 */
function findRealGh(): Effect.Effect<string, Error> {
  return Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(["which", "gh"], {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          // Strip any .tangerine/bin dirs from PATH to find the real binary
          PATH: (process.env["PATH"] ?? "")
            .split(":")
            .filter((p) => !p.includes(".tangerine/bin"))
            .join(":"),
        },
      })
      const stdout = await new Response(proc.stdout).text()
      const exitCode = await proc.exited
      if (exitCode !== 0 || !stdout.trim()) {
        throw new Error("gh CLI not found in PATH")
      }
      return stdout.trim()
    },
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  })
}

/**
 * Install the gh shim into a worktree. Returns the bin directory path
 * that should be prepended to the agent's PATH.
 */
export function installGhShim(
  worktreePath: string,
  prMode: PrMode,
): Effect.Effect<string, Error> {
  return Effect.gen(function* () {
    const realGh = yield* findRealGh()
    const shimDir = `${worktreePath}/.tangerine/bin`
    const shimPath = `${shimDir}/gh`

    const script = generateShimScript(realGh, prMode)

    yield* Effect.tryPromise({
      try: async () => {
        await Bun.spawn(["mkdir", "-p", shimDir], { stdout: "ignore", stderr: "ignore" }).exited
        await Bun.write(shimPath, script)
        await Bun.spawn(["chmod", "+x", shimPath], { stdout: "ignore", stderr: "ignore" }).exited
      },
      catch: (e) => (e instanceof Error ? e : new Error(String(e))),
    })

    log.debug("Installed gh shim", { worktreePath, prMode, shimPath, realGh })
    return shimDir
  })
}
