export const DAEMON_RESTART_EXIT_CODE = 75
// Unrecoverable config errors (missing credentials, bad config) — daemon should not restart
export const DAEMON_FATAL_EXIT_CODE = 76

export function shouldRestartDaemon(exitCode: number | null): boolean {
  if (exitCode === DAEMON_FATAL_EXIT_CODE) return false
  return exitCode !== 0
}
