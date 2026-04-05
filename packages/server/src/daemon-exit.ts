export const DAEMON_RESTART_EXIT_CODE = 75

export function shouldRestartDaemon(exitCode: number | null): boolean {
  return exitCode !== 0
}
