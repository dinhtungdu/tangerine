# Tangerine

Local background coding agent platform. Multi-provider agents (OpenCode, Claude Code) + web dashboard.

## Setup

1. Read `specs/architecture.md` and `specs/v0-scope.md`
2. `bun install`
3. `bun run check` before commit

## Structure

```
packages/
  shared/src/      # @tangerine/shared — types, config schema, constants
  server/src/
    api/           # Hono server (REST + WebSocket + webhooks)
    agent/         # Agent providers (OpenCode, Claude Code) + provider abstraction
    tasks/         # Task lifecycle, cleanup, health, retry, worktree setup
    integrations/  # GitHub webhook handler
    db/            # SQLite schema + queries
web/
  src/             # Vite + React dashboard
specs/             # Architecture and design docs
```

## Key Decisions

- Multi-provider: OpenCode (HTTP/SSE) and Claude Code (stdin/stdout NDJSON) behind AgentProvider abstraction
- Git worktrees for task isolation
- Project-agnostic: each project defines setup + test commands
- Multiplayer-ready data model (user_id nullable for v0)
- Local-first, upgradeable to hosted

## Related Projects

- orange: `~/workspace/orange/` — workflow engine (future integration)
- OpenCode: agent backend (server mode + SDK)
- Claude Code: agent backend (CLI stdin/stdout with stream-json)

## Rules

- Bun runtime, `bun:test` for tests
- No `any`
- Commits: `type(scope): msg`
- Comments explain "why" not "what"
- **Keep specs up to date**: When changing architecture, DB schema, APIs, or agent providers, update the corresponding file in `specs/`. Specs are the source of truth for design decisions — stale specs cause bugs.
- **Spec-first for new features**: New features or architecture changes → write/update the spec before coding. Bug fixes, small refactors, spikes → code first, update specs if architecture changed. At the start of each task, ask: "Does this need a spec update first?"

## Web UI Rules

Use these skills when writing or reviewing web UI code:
- `/web-design-guidelines` — Review against Web Interface Guidelines (accessibility, UX)
- `/vercel-react-best-practices` — React/Next.js performance (62 rules)
- `/vercel-composition-patterns` — Component architecture and composition

### Responsive Design
- **CSS-first**: Use Tailwind responsive prefixes (`md:`, `lg:`) — never JS-based viewport detection
- **Single components**: One component handles all breakpoints via `hidden md:flex` / `md:hidden` patterns
- **No dedicated mobile files**: Never create `Mobile*.tsx` or `mobile/` directories

### Design Fidelity
- **Read Pencil designs first**: Before implementing any screen, `batch_get` the design node with `resolveInstances: true` and `resolveVariables: true` to get exact specs
- **Match exactly**: cornerRadius, padding, gap, fontSize, fontWeight, colors, icon sizes — all must match the design
- **No invention**: Never add UI elements (nav bars, tabs, buttons) not present in the design

### Component Architecture
- **Check existing components first**: Before creating anything new, search for existing components that can be extended with a `variant` prop
- **Extract shared logic**: If the same pattern appears in 2+ places, extract to a shared component immediately
- **Extend, don't duplicate**: Add props/variants to existing components instead of creating new ones
- **No boolean prop sprawl**: Use explicit variant components or compound components over boolean mode props
- **Composition over configuration**: Use `children` and slots, not `renderX` props

### Performance
- **No inline component definitions**: Never define components inside other components
- **Stable callbacks**: Use functional `setState` to avoid re-render dependencies
- **Parallel fetches**: Use `Promise.all()` for independent async operations
- **Defer heavy imports**: Use `React.lazy()` / dynamic imports for heavy components not needed on initial load

## Testing

- **All tests MUST pass before every commit** — no exceptions
- Run web tests from `web/` dir: `cd web && bun test` (needs `bunfig.toml` preload for DOM)
- Run server tests: `cd packages/server && bun test`
- Run build: `bun run build` (from root)
- **Always add tests** for new components, new lib functions, new API routes, and bug fixes
- Architecture tests in `web/src/__tests__/architecture.test.ts` enforce structural rules — keep them passing
- When refactoring APIs (renaming props, changing interfaces), update corresponding tests immediately
- Test files: `web/src/__tests__/` (web), `packages/server/src/__tests__/` (API)

### Test categories
- **Unit**: `web/src/__tests__/lib.test.ts` — pure functions in `lib/`
- **Architecture**: `web/src/__tests__/architecture.test.ts` — no mobile files, no inline components in pages, no JS viewport detection
- **Hooks**: `web/src/__tests__/hooks.test.tsx` — React hook state logic
- **Components**: `web/src/__tests__/components.test.tsx` — render + interaction tests (uses happy-dom via preload)
- **API**: `packages/server/src/__tests__/api-routes.test.ts` — Hono route contracts
- **Models**: `packages/server/src/__tests__/models.test.ts` — per-provider model discovery

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **tangerine** (634 symbols, 1548 relationships, 46 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## When Debugging

1. `gitnexus_query({query: "<error or symptom>"})` — find execution flows related to the issue
2. `gitnexus_context({name: "<suspect function>"})` — see all callers, callees, and process participation
3. `READ gitnexus://repo/tangerine/process/{processName}` — trace the full execution flow step by step
4. For regressions: `gitnexus_detect_changes({scope: "compare", base_ref: "main"})` — see what your branch changed

## When Refactoring

- **Renaming**: MUST use `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` first. Review the preview — graph edits are safe, text_search edits need manual review. Then run with `dry_run: false`.
- **Extracting/Splitting**: MUST run `gitnexus_context({name: "target"})` to see all incoming/outgoing refs, then `gitnexus_impact({target: "target", direction: "upstream"})` to find all external callers before moving code.
- After any refactor: run `gitnexus_detect_changes({scope: "all"})` to verify only expected files changed.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Tools Quick Reference

| Tool | When to use | Command |
|------|-------------|---------|
| `query` | Find code by concept | `gitnexus_query({query: "auth validation"})` |
| `context` | 360-degree view of one symbol | `gitnexus_context({name: "validateUser"})` |
| `impact` | Blast radius before editing | `gitnexus_impact({target: "X", direction: "upstream"})` |
| `detect_changes` | Pre-commit scope check | `gitnexus_detect_changes({scope: "staged"})` |
| `rename` | Safe multi-file rename | `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` |
| `cypher` | Custom graph queries | `gitnexus_cypher({query: "MATCH ..."})` |

## Impact Risk Levels

| Depth | Meaning | Action |
|-------|---------|--------|
| d=1 | WILL BREAK — direct callers/importers | MUST update these |
| d=2 | LIKELY AFFECTED — indirect deps | Should test |
| d=3 | MAY NEED TESTING — transitive | Test if critical path |

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/tangerine/context` | Codebase overview, check index freshness |
| `gitnexus://repo/tangerine/clusters` | All functional areas |
| `gitnexus://repo/tangerine/processes` | All execution flows |
| `gitnexus://repo/tangerine/process/{name}` | Step-by-step execution trace |

## Self-Check Before Finishing

Before completing any code modification task, verify:
1. `gitnexus_impact` was run for all modified symbols
2. No HIGH/CRITICAL risk warnings were ignored
3. `gitnexus_detect_changes()` confirms changes match expected scope
4. All d=1 (WILL BREAK) dependents were updated

## CLI

- Re-index: `npx gitnexus analyze`
- Check freshness: `npx gitnexus status`
- Generate docs: `npx gitnexus wiki`

<!-- gitnexus:end -->
