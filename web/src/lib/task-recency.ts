import type { Task, TaskStatus } from "@tangerine/shared"

export const RECENT_TASK_STATUSES = new Set<TaskStatus>(["running", "provisioning", "created"])

export function getRecentTasks(tasks: Task[]): Task[] {
  return [...tasks]
    .filter((task) => RECENT_TASK_STATUSES.has(task.status))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
}

export function getMostRecentTask(tasks: Task[]): Task | null {
  return getRecentTasks(tasks)[0] ?? null
}
