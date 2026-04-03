/**
 * Default keyboard shortcuts for all actions.
 *
 * Uses the same Record<string, Shortcut> format as user-defined overrides
 * in config.json — so customizing is just overriding entries in this map.
 */
import type { Shortcut } from "./actions"

export const defaultShortcuts: Record<string, Shortcut> = {
  // Command palette
  "palette.toggle": { key: "k", meta: true },

  // Tasks
  "task.create": { key: "n", meta: true, shift: true },

  // Panels
  "panel.toggle-chat": { key: "1", meta: true, shift: true },
  "panel.toggle-terminal": { key: "`", meta: true },
  "panel.toggle-activity": { key: "3", meta: true, shift: true },
  "panel.toggle-diff": { key: "2", meta: true, shift: true },
}
