export {
  createTask,
  cancelTask,
  completeTask,
  abortAgent,
} from "./manager"
export type { TaskManagerDeps, TaskSource } from "./manager"

export { startSession } from "./lifecycle"
export type { SessionInfo, LifecycleDeps, ProjectConfig } from "./lifecycle"

export { cleanupSession } from "./cleanup"
export type { CleanupDeps } from "./cleanup"

export { startSessionWithRetry } from "./retry"
export type { RetryDeps } from "./retry"

export { checkTask, checkAllTasks, startHealthMonitor } from "./health"
export type { HealthCheckDeps } from "./health"

export { findOrphans, cleanupOrphans, startOrphanCleanup } from "./orphan-cleanup"
export type { OrphanCleanupDeps } from "./orphan-cleanup"
