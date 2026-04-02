import { useEffect } from "react"
import type { Task } from "@tangerine/shared"
import {
  registerActions,
  executeAction,
  setContext,
  clearContext,
  type Action,
} from "../lib/actions"

/**
 * Registers task-contextual actions in the action registry.
 * Actions are gated on task capabilities and status.
 * Sets the action context to the task id so they appear in the command palette.
 *
 * Handlers delegate to the global hidden actions (registered in useAppActions)
 * so API call logic lives in one place.
 *
 * @param task - The focused task (null clears context)
 * @param onRefetch - Callback to refresh task data after an action
 */
export function useTaskActions(
  task: Task | null,
  onRefetch?: () => void,
) {
  useEffect(() => {
    if (!task) {
      clearContext()
      return
    }

    setContext(task.id)

    const defs: Action[] = []
    const ctx = task.id

    // Cancel — running tasks
    if (task.status === "running") {
      defs.push({
        id: "task.cancel",
        label: "Cancel task",
        description: `Cancel "${task.title}"`,
        section: "Task",
        context: ctx,
        handler: async () => {
          await executeAction("task.cancel", { taskId: task.id })
          onRefetch?.()
        },
      })
    }

    // Abort — running tasks (stops the agent immediately)
    if (task.status === "running") {
      defs.push({
        id: "task.abort",
        label: "Abort task",
        description: `Abort "${task.title}"`,
        section: "Task",
        context: ctx,
        handler: async () => {
          await executeAction("task.abort", { taskId: task.id })
          onRefetch?.()
        },
      })
    }

    // Retry — failed or cancelled tasks
    if (task.status === "failed" || task.status === "cancelled") {
      defs.push({
        id: "task.retry",
        label: "Retry task",
        description: `Retry "${task.title}"`,
        section: "Task",
        context: ctx,
        handler: async () => {
          await executeAction("task.retry", { taskId: task.id })
          onRefetch?.()
        },
      })
    }

    // Resolve — failed/cancelled tasks with the "resolve" capability
    if (task.capabilities.includes("resolve") && (task.status === "failed" || task.status === "cancelled")) {
      defs.push({
        id: "task.resolve",
        label: "Resolve task",
        description: `Mark "${task.title}" as resolved`,
        section: "Task",
        context: ctx,
        handler: async () => {
          await executeAction("task.resolve", { taskId: task.id })
          onRefetch?.()
        },
      })
    }

    // Start — created tasks that haven't started yet
    if (task.status === "created") {
      defs.push({
        id: "task.start",
        label: "Start task",
        description: `Start "${task.title}"`,
        section: "Task",
        context: ctx,
        handler: async () => {
          await executeAction("task.start", { taskId: task.id })
          onRefetch?.()
        },
      })
    }

    // Delete — terminated tasks
    const terminated = new Set(["done", "completed", "failed", "cancelled"])
    if (terminated.has(task.status)) {
      defs.push({
        id: "task.delete",
        label: "Delete task",
        description: `Delete "${task.title}"`,
        section: "Task",
        context: ctx,
        handler: async () => {
          await executeAction("task.delete", { taskId: task.id })
          onRefetch?.()
        },
      })
    }

    if (defs.length === 0) return () => clearContext()

    const unregister = registerActions(defs)
    return () => {
      unregister()
      clearContext()
    }
  }, [task?.id, task?.status, task?.capabilities, task?.title, onRefetch])
}
