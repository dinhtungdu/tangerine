type TaskListChange = { taskId: string; change: "created" | "updated" | "deleted" }
type TaskListChangeHandler = (event: TaskListChange) => void

const taskListChangeListeners = new Set<TaskListChangeHandler>()

/** Broadcast list-visible task row mutations to global task-list listeners. */
export function emitTaskListChange(taskId: string, change: TaskListChange["change"]): void {
  for (const handler of taskListChangeListeners) {
    handler({ taskId, change })
  }
}

/** Subscribe to global task-list invalidation events. Returns an unsubscribe function. */
export function onTaskListChange(handler: TaskListChangeHandler): () => void {
  taskListChangeListeners.add(handler)
  return () => { taskListChangeListeners.delete(handler) }
}
