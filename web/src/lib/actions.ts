/**
 * Unified action registry — single source of truth for all user-facing actions.
 * Actions can be triggered from keyboard shortcuts, command palette, or UI buttons.
 */

export interface Shortcut {
  key: string
  meta?: boolean
  shift?: boolean
  alt?: boolean
}

export interface Action {
  id: string
  label: string
  description?: string
  shortcut?: Shortcut
  handler: () => void | Promise<void>
  hidden?: boolean
  section?: string
}

type Listener = () => void

const actions = new Map<string, Action>()
const listeners = new Set<Listener>()

function notify() {
  for (const fn of listeners) fn()
}

/** Register actions. Returns an unregister function. */
export function registerActions(defs: Action[]): () => void {
  for (const a of defs) {
    actions.set(a.id, a)
  }
  notify()
  return () => {
    for (const a of defs) {
      actions.delete(a.id)
    }
    notify()
  }
}

/** Execute an action by id. */
export function executeAction(id: string): void {
  const action = actions.get(id)
  if (action) {
    action.handler()
  }
}

/** Get all registered actions (for palette listing). */
export function getActions(): Action[] {
  return Array.from(actions.values())
}

/** Get a single action by id (for button wiring). */
export function getAction(id: string): Action | undefined {
  return actions.get(id)
}

/** Subscribe to registry changes. Returns unsubscribe function. */
export function subscribe(cb: Listener): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** Format a shortcut for display (e.g. "⌘K"). */
export function formatShortcut(s: Shortcut): string {
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent)
  const parts: string[] = []
  if (s.meta) parts.push(isMac ? "⌘" : "Ctrl+")
  if (s.shift) parts.push(isMac ? "⇧" : "Shift+")
  if (s.alt) parts.push(isMac ? "⌥" : "Alt+")
  parts.push(s.key.length === 1 ? s.key.toUpperCase() : s.key)
  return parts.join("")
}

/** Check if a KeyboardEvent matches a Shortcut. */
export function matchesShortcut(e: KeyboardEvent, s: Shortcut): boolean {
  const metaMatch = s.meta ? (e.metaKey || e.ctrlKey) : (!e.metaKey && !e.ctrlKey)
  const shiftMatch = s.shift ? e.shiftKey : !e.shiftKey
  const altMatch = s.alt ? e.altKey : !e.altKey
  return metaMatch && shiftMatch && altMatch && e.key.toLowerCase() === s.key.toLowerCase()
}

/** Reset the registry (for testing). */
export function _resetForTesting(): void {
  actions.clear()
  listeners.clear()
}
