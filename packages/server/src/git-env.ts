const GIT_ENV_KEYS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR"]

// Git hooks export repo-scoped env vars. Strip them before running git with an explicit cwd.
export function cleanGitEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string | undefined>
  for (const key of GIT_ENV_KEYS) delete env[key]
  return env as Record<string, string>
}
