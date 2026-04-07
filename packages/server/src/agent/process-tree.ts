// Utility to kill a process and all its descendant processes.
// Prevents orphaned subprocesses when an agent is aborted or shut down.

import { execSync } from "node:child_process"

/** Recursively collect all descendant PIDs of a process. */
function getDescendantPids(pid: number): number[] {
  try {
    const output = execSync(`pgrep -P ${pid}`, { encoding: "utf-8", timeout: 5000 })
    const children = output.trim().split("\n").filter(Boolean).map(Number).filter(n => !isNaN(n))
    const all: number[] = []
    for (const child of children) {
      all.push(child, ...getDescendantPids(child))
    }
    return all
  } catch {
    return [] // no children or pgrep not available
  }
}

/** Send a signal to all descendant processes (children killed first), but NOT the root. */
export function killDescendants(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  const descendants = getDescendantPids(pid)
  // Kill descendants bottom-up (deepest children first) so parents
  // don't respawn or re-adopt orphans before we reach them.
  for (const childPid of descendants.reverse()) {
    try { process.kill(childPid, signal) } catch { /* already dead */ }
  }
}

/** Send a signal to a process and all its descendants (children killed first). */
export function killProcessTree(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  killDescendants(pid, signal)
  try { process.kill(pid, signal) } catch { /* already dead */ }
}

/**
 * Kill a process tree with SIGTERM, then escalate to SIGKILL after a grace period.
 * Use for final shutdown to ensure no orphans survive.
 */
export function killProcessTreeEscalated(pid: number, graceMs = 2000): void {
  killProcessTree(pid, "SIGTERM")
  setTimeout(() => {
    killProcessTree(pid, "SIGKILL")
  }, graceMs).unref()
}
