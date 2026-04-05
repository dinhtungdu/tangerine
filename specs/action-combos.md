# Action Combos

User-defined macro sequences loaded from `config.json` and registered into the unified action registry at startup.

## Config Schema

Top-level `actionCombos` field on `TangerineConfig`:

```json
{
  "actionCombos": [
    {
      "id": "combo.focus-terminal",
      "label": "Focus Terminal",
      "shortcut": { "key": "t", "meta": true, "shift": true },
      "sequence": ["show-terminal", "hide-diff"]
    }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | yes | Unique action id (must not collide with built-in actions) |
| `label` | `string` | yes | Display name in command palette |
| `shortcut` | `Shortcut` | no | Keyboard shortcut |
| `sequence` | `string[]` | yes | Ordered list of action ids to execute |

Zod schema: `actionComboSchema` in `@tangerine/shared/config.ts`.

## Loader Lifecycle

1. App starts, `useAppActions()` registers built-in actions
2. Config is fetched via `/api/projects` (already includes `actionCombos`)
3. `registerActionCombos(combos)` iterates the array, creating an `Action` for each combo whose handler calls `executeAction(id)` for each entry in `sequence`
4. Returns an unregister function (for cleanup on config change)

## Sequence Execution

- Actions execute in order, awaiting each if async
- Unknown action ids: log `console.warn` and skip — do not throw
- Empty sequence: no-op (valid but does nothing)
- Combo actions appear in the command palette like any other action, with section "Combos"

## Error Handling

- Unknown action id in sequence → `console.warn` and skip, continue with remaining sequence
- Self-referencing combo (sequence contains own id) → `console.warn` and skip that step to prevent infinite recursion
- Combo id collides with existing built-in action → combo is rejected entirely, original action preserved
- Invalid config shape → Zod validation rejects at load time

## API Surface

The `/api/projects` endpoint already returns config fields. Adding `actionCombos` to the response is the only server change needed.

## Files Changed

- `packages/shared/src/config.ts` — add `actionComboSchema`, add `actionCombos` to `tangerineConfigSchema`
- `packages/server/src/api/routes/project.ts` — include `actionCombos` in GET response
- `web/src/lib/actions.ts` — add `registerActionCombos()` function
- `web/src/lib/api.ts` — add `actionCombos` to `fetchProjects` return type
- `web/src/hooks/useAppActions.ts` — call `registerActionCombos` after fetching config
- `web/src/__tests__/lib.test.ts` — tests for combo loader and sequence execution
