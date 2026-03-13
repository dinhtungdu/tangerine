# v0 Scope

Minimal viable version. Single project, single user, local VMs.

## In Scope

### Core
- [ ] Project config (`.tangerine/config.json`)
- [ ] VM provisioning via Lima (reuse hal9999 provider)
- [ ] Golden image build (`tangerine image build`)
- [ ] Warm pool (acquire/release/reap)
- [ ] SSH tunnel management (OpenCode API + preview port)

### Agent
- [ ] OpenCode server mode inside VM
- [ ] SDK bridge: create session, send prompts, stream events, abort
- [ ] Credential injection (ANTHROPIC_API_KEY, GITHUB_TOKEN)
- [ ] Terminal attach (`opencode attach`)

### API Server
- [ ] Hono + Bun
- [ ] REST: tasks CRUD, proxy to OpenCode
- [ ] WebSocket: real-time chat relay (OpenCode SSE → WS → browser)
- [ ] Preview proxy (reverse proxy to VM dev server)
- [ ] GitHub webhook handler (issues → tasks)

### Web Dashboard
- [ ] Vite + React
- [ ] Dashboard: task list with real-time status
- [ ] Task detail: chat panel + preview iframe
- [ ] Streaming agent output
- [ ] Send prompts, abort execution
- [ ] Diff view

### Integration
- [ ] GitHub issues as task source (webhook, label trigger)
- [ ] PR creation via `gh` CLI in VM
- [ ] Branch management (auto-create per task)

### CLI
- [ ] `tangerine start` — start API server + dashboard
- [ ] `tangerine image build <name>` — build golden image
- [ ] `tangerine task create` — manual task creation (testing)
- [ ] `tangerine pool status` — warm pool info

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
4. Extract/import hal9999 VM layer (Lima provider, pool, SSH)

### Phase 2: VM + Agent
5. Golden image build script (base: Debian + OpenCode + Docker + git)
6. Session lifecycle: provision → clone → start OpenCode → tunnel
7. OpenCode SDK bridge (connect, prompt, events, abort)
8. Credential injection

### Phase 3: API + WebSocket
9. REST endpoints (tasks, proxy to OpenCode)
10. WebSocket endpoint (SSE bridge)
11. Preview proxy
12. GitHub webhook handler

### Phase 4: Web Dashboard
13. Dashboard page (task list)
14. Task detail page (chat + preview)
15. Streaming chat UI
16. Diff view

### Phase 5: Polish
17. Error handling + recovery
18. Warm pool tuning
19. CLI commands
20. README + setup docs
