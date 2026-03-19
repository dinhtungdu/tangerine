# v0 Scope

Minimal viable version. Single project, single user, local VMs.

## In Scope

### Core
- [x] Project config (`.tangerine/config.json`) with `defaultProvider` field
- [x] VM provisioning via Lima (reuse hal9999 provider)
- [x] Golden image build (two-layer: base + project)
- [x] Per-project persistent VMs (`ProjectVmManager`)
- [x] SSH tunnel management (agent API + preview port)
- [x] Git worktrees for task isolation

### Agent
- [x] Multi-provider abstraction (`AgentFactory` → `AgentHandle`)
- [x] OpenCode server mode inside VM (SSE events via tunnel)
- [x] Claude Code CLI inside VM (NDJSON via stdin/stdout)
- [x] Normalized `AgentEvent` stream from both providers
- [x] Credential injection (ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, GITHUB_TOKEN)
- [x] Terminal attach (`opencode attach`) for OpenCode tasks

### API Server
- [x] Hono + Bun
- [x] REST: tasks CRUD, proxy to agent, VM management
- [x] WebSocket: real-time chat relay (AgentEvent → WS → browser)
- [x] Preview proxy (reverse proxy to VM dev server)
- [x] GitHub webhook handler (issues → tasks)
- [x] Image build endpoints (base + project)
- [x] System logs, activity log

### Web Dashboard
- [x] Vite + React
- [x] Dashboard: task list with real-time status
- [x] Task detail: chat panel + preview iframe
- [x] Streaming agent output
- [x] Send prompts, abort execution
- [x] Provider selector (OpenCode / Claude Code)
- [x] VM summary card
- [x] Activity log panel

### Integration
- [x] GitHub issues as task source (webhook, label trigger)
- [x] PR creation via `gh` CLI in VM
- [x] Branch management (auto-create per task via worktrees)

### CLI
- [x] `tangerine start` — start API server + dashboard
- [x] `tangerine image build <name>` — build golden image
- [x] `tangerine image build-base` — build base image
- [x] `tangerine task create` — manual task creation

## Out of Scope (future)

- Multiplayer (data model ready, not wired)
- Linear integration
- GitHub OAuth (static PAT for v0)
- Hosted version + user accounts
- Orange workflow engine (plan/review loops)
- Multiple projects simultaneously
- Incus/DO providers
- code-server (web VS Code) embed
- Image registry with periodic auto-rebuild
- Slack bot
- Chrome extension
- Statistics/analytics page
- Voice input

## Implementation Order

### Phase 1: Foundation
1. Project scaffolding (Bun + Hono + Vite + React)
2. DB schema (tasks, VMs)
3. Project config loading
4. Extract/import hal9999 VM layer (Lima provider, SSH)

### Phase 2: VM + Agent
5. Golden image build (two-layer: base + project)
6. Session lifecycle: get/create VM → worktree → start agent → tunnel
7. Agent provider abstraction + OpenCode provider
8. Credential injection

### Phase 3: API + WebSocket
9. REST endpoints (tasks, sessions, VMs, images)
10. WebSocket endpoint (AgentEvent bridge)
11. Preview proxy
12. GitHub webhook handler

### Phase 4: Web Dashboard
13. Dashboard page (task list + VM summary)
14. Task detail page (chat + preview + activity log)
15. Provider selector
16. Streaming chat UI

### Phase 5: Multi-Provider + Polish
17. Claude Code provider
18. NDJSON parser + event mapping
19. Error handling + recovery
20. Server restart reconciliation
