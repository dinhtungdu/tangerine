# Tangerine

Local background coding agent platform. VMs + OpenCode + web dashboard.

## Setup

1. Read `specs/architecture.md` and `specs/v0-scope.md`
2. `bun install`
3. `bun run check` before commit

## Structure

```
src/
  api/           # Hono server (REST + WebSocket + webhooks)
  vm/            # VM layer (Lima provider, pool, SSH) — extracted from hal9999
  agent/         # OpenCode SDK bridge
  tasks/         # Task management, lifecycle
  integrations/  # GitHub webhook handler
  db/            # SQLite schema + queries
  image/         # Golden image build scripts
  types.ts
web/
  src/           # Vite + React dashboard
specs/           # Architecture and design docs
```

## Key Decisions

- OpenCode in server mode as agent backend (not fire-and-forget)
- Own chat UI built with OpenCode SDK (not OpenCode's web UI)
- Project-agnostic: each project defines golden image + setup + preview + test
- VM layer extracted from hal9999 (Lima/Incus providers, pool, SSH)
- Multiplayer-ready data model (user_id nullable for v0)
- Local-first, upgradeable to hosted

## Related Projects

- hal9999: `~/workspace/hal9999/` — VM provisioning source
- orange: `~/workspace/orange/` — workflow engine (future integration)
- OpenCode: agent backend (server mode + SDK)

## Rules

- Bun runtime, `bun:test` for tests
- No `any`
- Commits: `type(scope): msg`
- Comments explain "why" not "what"

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
