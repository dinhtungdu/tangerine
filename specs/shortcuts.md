# Unified Action System

## Overview

Every user-facing action in the web UI has a single implementation in a central action registry. Actions can be triggered from three callers:

1. **Keyboard shortcuts** — globally registered from the registry
2. **Command palette** — `Cmd+K` opens a searchable list of all actions
3. **UI buttons** — reference action by id to get label + handler

Callers are thin: they call `executeAction(id)` and never duplicate logic.

## Action Shape

```ts
interface Action {
  id: string                          // e.g. "navigate.runs", "theme.toggle"
  label: string                       // Human-readable, shown in palette
  description?: string                // Optional longer description
  shortcut?: Shortcut                 // Optional keyboard shortcut
  handler: () => void | Promise<void> // The single implementation
  hidden?: boolean                    // Hide from command palette (e.g. palette.open)
  section?: string                    // Grouping in palette: "Navigation", "Tasks", etc.
}

interface Shortcut {
  key: string          // KeyboardEvent.key value (e.g. "k", "n", "/")
  meta?: boolean       // Cmd on macOS, Ctrl elsewhere
  shift?: boolean
  alt?: boolean
}
```

## Registry API

```ts
// Register actions (called at app init or from hooks)
function registerActions(actions: Action[]): () => void  // returns unregister fn

// Execute by id
function executeAction(id: string): void

// Get all registered actions (for palette listing)
function getActions(): Action[]

// Get a single action (for button wiring)
function getAction(id: string): Action | undefined

// Subscribe to registry changes
function subscribe(cb: () => void): () => void
```

The registry is a plain module singleton (not React context), so it can be imported anywhere.

## Keyboard Shortcut Strategy

- A single `useShortcuts()` hook attaches one `keydown` listener on `document`.
- On each keypress, it checks all registered actions for a matching shortcut.
- Shortcuts are suppressed when focus is inside an `<input>`, `<textarea>`, or `[contenteditable]` element (unless the shortcut uses `meta`).
- The hook reads from the registry via `subscribe()` so it stays in sync.

## Command Palette UX

- `Cmd+K` toggles the palette open/closed.
- The palette replaces the existing QuickOpen component, which becomes a "task search" mode within the palette.
- Default view (no query): shows available actions grouped by section.
- Typing filters actions by label fuzzy match.
- Prefix `>` filters to actions only (like VS Code).
- Without prefix: mixed mode shows both tasks and actions (preserving QuickOpen behavior).
- Arrow keys navigate, Enter executes, Escape closes.

## Initial Actions

| ID | Label | Shortcut | Section |
|----|-------|----------|---------|
| `palette.open` | Open command palette | `Cmd+K` | (hidden) |
| `navigate.runs` | Go to Runs | `g then r` | Navigation |
| `navigate.crons` | Go to Crons | `g then c` | Navigation |
| `navigate.status` | Go to Status | `g then s` | Navigation |
| `theme.toggle` | Toggle dark mode | — | Preferences |
| `task.create` | New task | — | Tasks |

Note: `g then r` style sequences are deferred to a future iteration. Initial shortcuts use single-key combos only.

## User-Defined Shortcut Overrides

Users can rebind action shortcuts globally via `config.json`:

```json
{
  "shortcuts": {
    "task.create": { "key": "t", "meta": true },
    "navigate.runs": { "key": "r", "meta": true, "shift": true }
  }
}
```

- `shortcuts` is a top-level field on `TangerineConfig` (global, not per-project).
- Keys are action IDs, values are `Shortcut` objects (`{ key, meta?, shift?, alt? }`).
- Overrides are applied via `patchActionShortcut(id, shortcut)` after built-in actions are registered.
- Only the shortcut binding is replaced — the handler and all other action properties are preserved.
- The server returns `shortcuts` from `GET /api/projects`; the web app reads it from `ProjectContext` and applies overrides in `useAppActions`.

## File Structure

```
web/src/lib/actions.ts       # Registry singleton (includes patchActionShortcut)
web/src/hooks/useShortcuts.ts # Global keydown listener hook
web/src/components/CommandPalette.tsx  # Replaces QuickOpen
```

## Pull-to-Refresh Interception (Mobile)

On touch devices, the pull-down-from-top gesture (which normally triggers browser refresh) opens the command palette instead.

- CSS `overscroll-behavior: contain` on `html, body` prevents the browser default.
- `useShortcuts` tracks `touchstart`/`touchend` events: if the user pulls down 80px+ while at `scrollY === 0`, it calls `executeAction("palette.open")`.
- This uses the same unified action system — no separate code path.

## Migration from QuickOpen

- `QuickOpen.tsx` is replaced by `CommandPalette.tsx`.
- Task search functionality is preserved within the palette.
- `Layout.tsx` swaps `<QuickOpen />` for `<CommandPalette />`.
- Existing QuickOpen tests are updated to test CommandPalette.
