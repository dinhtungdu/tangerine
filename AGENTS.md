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
