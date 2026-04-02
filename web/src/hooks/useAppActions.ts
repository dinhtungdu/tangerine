import { useEffect } from "react"
import { useNavigate } from "react-router-dom"
import { registerActions, registerActionCombos, setShortcutOverrides, type Action } from "../lib/actions"
import { cancelTask, retryTask, deleteTask, resolveTask } from "../lib/api"
import { useProjectNav } from "./useProjectNav"
import { useProject } from "../context/ProjectContext"
import { useTheme } from "./useTheme"
import { useShortcuts } from "./useShortcuts"

/**
 * Registers all app-wide actions and activates global keyboard shortcuts.
 * Call once near the app root (e.g. in Layout).
 */
export function useAppActions() {
  const navigate = useNavigate()
  const { link } = useProjectNav()
  const { actionCombos, shortcuts } = useProject()
  const { resolved, setTheme } = useTheme()

  // Activate the global shortcut listener
  useShortcuts()

  useEffect(() => {
    const actions: Action[] = [
      // Navigation
      {
        id: "navigate.runs",
        label: "Go to Runs",
        section: "Navigation",
        handler: () => navigate(link("/")),
      },
      {
        id: "navigate.crons",
        label: "Go to Crons",
        section: "Navigation",
        handler: () => navigate(link("/crons")),
      },
      {
        id: "navigate.status",
        label: "Go to Status",
        section: "Navigation",
        handler: () => navigate(link("/status")),
      },
      // Preferences
      {
        id: "theme.toggle",
        label: `Switch to ${resolved === "dark" ? "light" : "dark"} mode`,
        section: "Preferences",
        handler: () => setTheme(resolved === "dark" ? "light" : "dark"),
      },
      {
        id: "theme.system",
        label: "Use system theme",
        section: "Preferences",
        handler: () => setTheme("system"),
      },
      // Tasks
      {
        id: "task.create",
        label: "New task",
        description: "Create a new agent task",
        section: "Tasks",
        handler: () => navigate(link("/?focus=1")),
        shortcut: { key: "n", meta: true, shift: true },
      },
      {
        id: "task.cancel",
        label: "Cancel task",
        section: "Tasks",
        hidden: true,
        handler: async (args) => {
          const taskId = args?.taskId as string | undefined
          if (!taskId) return
          await cancelTask(taskId)
        },
      },
      {
        id: "task.retry",
        label: "Retry task",
        section: "Tasks",
        hidden: true,
        handler: async (args) => {
          const taskId = args?.taskId as string | undefined
          if (!taskId) return
          await retryTask(taskId)
        },
      },
      {
        id: "task.delete",
        label: "Delete task",
        section: "Tasks",
        hidden: true,
        handler: async (args) => {
          const taskId = args?.taskId as string | undefined
          if (!taskId) return
          await deleteTask(taskId)
        },
      },
      {
        id: "task.resolve",
        label: "Mark task as done",
        section: "Tasks",
        hidden: true,
        handler: async (args) => {
          const taskId = args?.taskId as string | undefined
          if (!taskId) return
          await resolveTask(taskId)
        },
      },
    ]

    return registerActions(actions)
  }, [navigate, link, resolved, setTheme])

  // Register user-defined combo actions from config
  useEffect(() => {
    if (actionCombos.length === 0) return
    return registerActionCombos(actionCombos)
  }, [actionCombos])

  // Apply user-defined shortcut overrides from global config.
  // setShortcutOverrides stores the map in the registry so overrides
  // are automatically reapplied when actions re-register or register late.
  useEffect(() => {
    setShortcutOverrides(shortcuts ?? {})
  }, [shortcuts])
}
