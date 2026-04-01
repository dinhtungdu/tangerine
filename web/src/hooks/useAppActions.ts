import { useEffect } from "react"
import { useNavigate } from "react-router-dom"
import { registerActions, registerActionCombos, type Action } from "../lib/actions"
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
  const { actionCombos } = useProject()
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
        handler: () => navigate(link("/")),
        shortcut: { key: "n", meta: true, shift: true },
      },
    ]

    return registerActions(actions)
  }, [navigate, link, resolved, setTheme])

  // Register user-defined combo actions from config
  useEffect(() => {
    if (actionCombos.length === 0) return
    return registerActionCombos(actionCombos)
  }, [actionCombos])
}
