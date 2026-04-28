import { useEffect } from "react"
import { TERMINAL_STATUSES } from "@tangerine/shared"
import type { Task } from "@tangerine/shared"
import {
  registerActions,
  setContext,
  clearContext,
  type Action,
} from "../lib/actions"
import {
  cancelTask,
  retryTask,
  deleteTask,
  resolveTask,
  abortTask,
  startTask,
} from "../lib/api"
import { formatTaskTitle } from "../lib/format"

/**
 * Registers task-contextual actions in the action registry.
 * Actions are gated on task capabilities and status.
 * Sets the action context to the task id so they appear in the command palette.
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
    const title = formatTaskTitle(task)

    // Cancel — running tasks
    if (task.status === "running") {
      defs.push({
        id: "task.cancel",
        label: "Cancel task",
        description: `Cancel "${title}"`,
        section: "Task",
        context: ctx,
        handler: async (args) => {
          const targetId = (args?.taskId as string) ?? task.id
          await cancelTask(targetId)
          onRefetch?.()
        },
      })
    }

    // Abort — running tasks (stops the agent immediately)
    if (task.status === "running") {
      defs.push({
        id: "task.abort",
        label: "Abort task",
        description: `Abort "${title}"`,
        section: "Task",
        context: ctx,
        handler: async (args) => {
          const targetId = (args?.taskId as string) ?? task.id
          await abortTask(targetId)
          onRefetch?.()
        },
      })
    }

    // Retry — failed or cancelled tasks
    if (task.status === "failed" || task.status === "cancelled") {
      defs.push({
        id: "task.retry",
        label: "Retry task",
        description: `Retry "${title}"`,
        section: "Task",
        context: ctx,
        handler: async (args) => {
          const targetId = (args?.taskId as string) ?? task.id
          await retryTask(targetId)
          onRefetch?.()
        },
      })
    }

    // Resolve — failed/cancelled tasks with the "resolve" capability
    if (task.capabilities.includes("resolve") && (task.status === "failed" || task.status === "cancelled")) {
      defs.push({
        id: "task.resolve",
        label: "Resolve task",
        description: `Mark "${title}" as resolved`,
        section: "Task",
        context: ctx,
        handler: async (args) => {
          const targetId = (args?.taskId as string) ?? task.id
          await resolveTask(targetId)
          onRefetch?.()
        },
      })
    }

    // Start — created tasks that haven't started yet
    if (task.status === "created") {
      defs.push({
        id: "task.start",
        label: "Start task",
        description: `Start "${title}"`,
        section: "Task",
        context: ctx,
        handler: async (args) => {
          const targetId = (args?.taskId as string) ?? task.id
          await startTask(targetId)
          onRefetch?.()
        },
      })
    }

    // Delete — terminated tasks
    if (TERMINAL_STATUSES.has(task.status)) {
      defs.push({
        id: "task.delete",
        label: "Delete task",
        description: `Delete "${title}"`,
        section: "Task",
        context: ctx,
        handler: async (args) => {
          const targetId = (args?.taskId as string) ?? task.id
          await deleteTask(targetId)
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
