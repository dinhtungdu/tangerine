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
  handler: (args?: Record<string, unknown>) => void | Promise<void>
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

/** Execute an action by id, forwarding optional args to the handler. */
export async function executeAction(id: string, args?: Record<string, unknown>): Promise<void> {
  const action = actions.get(id)
  if (action) {
    await action.handler(args)
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
  const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent)
  // On macOS, meta = Cmd (metaKey). On other platforms, meta = Ctrl (ctrlKey).
  // Never match Super/Windows key on Linux/Windows — it's reserved for OS shortcuts.
  const modKey = isMac ? e.metaKey : e.ctrlKey
  const metaMatch = s.meta ? modKey : !(e.metaKey || e.ctrlKey)
  const shiftMatch = s.shift ? e.shiftKey : !e.shiftKey
  const altMatch = s.alt ? e.altKey : !e.altKey
  return metaMatch && shiftMatch && altMatch && e.key.toLowerCase() === s.key.toLowerCase()
}

/** Register combo actions from config. Each combo executes its sequence in order. */
export function registerActionCombos(
  combos: Array<{
    id: string
    label: string
    shortcut?: Shortcut
    sequence: string[]
  }>,
): () => void {
  // Filter out combos that would collide with existing built-in actions
  const safe = combos.filter((combo) => {
    if (actions.has(combo.id)) {
      console.warn(`Action combo: id '${combo.id}' collides with existing action, skipping`)
      return false
    }
    return true
  })

  const comboActions: Action[] = safe.map((combo) => ({
    id: combo.id,
    label: combo.label,
    shortcut: combo.shortcut,
    section: "Combos",
    handler: async () => {
      for (const actionId of combo.sequence) {
        // Skip self-references to prevent infinite recursion
        if (actionId === combo.id) {
          console.warn(`Action combo: skipping self-reference '${actionId}'`)
          continue
        }
        const action = actions.get(actionId)
        if (!action) {
          console.warn(`Action combo: unknown action id '${actionId}', skipping`)
          continue
        }
        await action.handler()
      }
    },
  }))
  return registerActions(comboActions)
}

/** Reset the registry (for testing). */
export function _resetForTesting(): void {
  actions.clear()
  listeners.clear()
}
