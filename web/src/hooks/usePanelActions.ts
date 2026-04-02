import { useEffect } from "react"
import type { Task } from "@tangerine/shared"
import { registerActions, type Action } from "../lib/actions"

type PaneId = "chat" | "diff" | "terminal" | "activity"

/**
 * Registers panel toggle actions in the command palette, colocated with the
 * pane state that owns them. Actions are gated on task capabilities where
 * applicable (e.g. diff pane requires "diff" capability).
 */
export function usePanelActions(
  task: Task | null,
  togglePane: (pane: PaneId) => void,
) {
  useEffect(() => {
    const hasDiff = task?.capabilities.includes("diff") ?? false

    const defs: Action[] = [
      {
        id: "panel.toggle-chat",
        label: "Toggle chat panel",
        section: "Panels",
        shortcut: { key: "1", meta: true, shift: true },
        handler: () => togglePane("chat"),
      },
      {
        id: "panel.toggle-terminal",
        label: "Toggle terminal panel",
        section: "Panels",
        // Ctrl+` mirrors the VS Code terminal shortcut
        shortcut: { key: "`", meta: true },
        handler: () => togglePane("terminal"),
      },
      {
        id: "panel.toggle-activity",
        label: "Toggle activity panel",
        section: "Panels",
        shortcut: { key: "3", meta: true, shift: true },
        handler: () => togglePane("activity"),
      },
    ]

    if (hasDiff) {
      defs.push({
        id: "panel.toggle-diff",
        label: "Toggle diff panel",
        section: "Panels",
        shortcut: { key: "2", meta: true, shift: true },
        handler: () => togglePane("diff"),
      })
    }

    return registerActions(defs)
  }, [task?.capabilities, togglePane])
}
