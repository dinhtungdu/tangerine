# Tangerine

Local background coding agent platform. Tangerine runs as a local Bun server, spawns agent CLIs as local processes, isolates work in git worktrees, and exposes a web dashboard for managing runs.

## Current Architecture

- Single-machine runtime, use it on your host machine or inside a VM.
- Shared bearer-token auth for dashboard, API, and task/terminal WebSockets when `TANGERINE_AUTH_TOKEN` is set
- ACP-only agents: configured external ACP commands (for example Claude Code, Codex, OpenCode, or Pi adapters)
- Git worktrees per task under a shared workspace
- Hono API server with REST + WebSocket endpoints
- Vite + React dashboard served from `web/dist`
- SQLite for tasks, session logs, activity logs, system logs, and worktree slots

See [specs/architecture.md](specs/architecture.md) for the source-of-truth architecture doc.

## Repo Layout

```text
packages/
  shared/src/      # shared types, config schema, constants
  server/src/
    agent/         # ACP stdio client/runtime
    api/           # Hono routes + WebSocket handlers
    cli/           # tangerine CLI
    db/            # SQLite schema + queries
    integrations/  # GitHub webhook + polling
    tasks/         # lifecycle, retry, health, PR monitor, worktree pool
web/src/           # React dashboard
skills/            # in-repo skills installed for agents
specs/             # design and implementation docs
```

## Key Features

- Manual and cross-project task creation
- Task types: `worker`, `orchestrator`, `reviewer`
- Task capabilities derived from type, not title
- On-demand orchestrator startup
- Model and reasoning-effort changes on running tasks
- Git diff, activity log, terminal attach, system log, and project update controls in the UI
- GitHub PR reference resolution from branch input like `#123` or full PR URLs
- Self-update flow for project repos via `postUpdateCommand`
- SSH editor deep-links to open task worktrees in VS Code, Cursor, or Zed (requires `sshHost`/`editor` in config and a matching `Host` entry in `~/.ssh/config` on the host machine)
- Cron scheduling: create recurring agent tasks on a cron schedule via UI or API
- GitHub fork sync: sync forked repos to upstream before running tasks
- Watchdog: detects and restarts agents stuck on hung tools
- Runtime system-tool detection: UI features gate on available tools (e.g. `dtach`, `gh`)

## Getting started

Install the package:
```bash
bun i -g @dinhtungdu/tangerine
```

Install the skills:
```bash
tangerine install
```

Configure at least one ACP agent command in `~/tangerine/config.json`. Common no-global-install examples:

```json
{
  "agents": [
    { "id": "claude", "name": "Claude Code", "command": "bunx", "args": ["--bun", "@zed-industries/claude-code-acp"] },
    { "id": "codex", "name": "Codex", "command": "bunx", "args": ["--bun", "@zed-industries/codex-acp"] },
    { "id": "opencode", "name": "OpenCode", "command": "bunx", "args": ["--bun", "opencode-ai", "acp"] },
    { "id": "pi", "name": "Pi", "command": "bunx", "args": ["--bun", "pi-acp"] }
  ],
  "defaultAgent": "claude"
}
```

Authenticate the underlying agent CLI/config outside Tangerine, then ask your clanker to set up Tangerine and add projects using the `platform-setup` skill (`/platform-setup`).

Then start:
```bash
tangerine start
```

## Auth Setup

If you want dashboard/API auth, or you plan to bind Tangerine on a non-loopback host, set a shared token before starting:

```bash
tangerine secret set TANGERINE_AUTH_TOKEN=$(openssl rand -hex 32)
tangerine start
```

How it works:

- The dashboard shows an unlock screen. Enter the same token once per browser.
- The browser stores that token in `localStorage` on the client machine.
- REST calls use `Authorization: Bearer <token>`.
- WebSocket clients connect, then immediately send `{"type":"auth","token":"<token>"}`.
- Agent tasks inherit `TANGERINE_AUTH_TOKEN` automatically for self-calls back into the Tangerine API.

Useful example:

```bash
curl -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" http://localhost:3456/api/tasks
```

Notes:

- `GET /api/health` and `GET /api/auth/session` stay public.
- If Tangerine binds a non-loopback host and no token is configured, startup fails unless `TANGERINE_INSECURE_NO_AUTH=1` is set explicitly.

## Development

```bash
bun install
bun run build
bun link # make `tangerine` available globally
```

During development you can run the API and web processes separately:

```bash
bun run dev:api
bun run dev:web
```

## CLI

- `tangerine start` — start the server as a background daemon
- `tangerine stop` — stop the running daemon
- `tangerine status` — show daemon status
- `tangerine logs` — tail the server log file
- `tangerine install` — install agent skills
- `tangerine project add|list|show|remove`
- `tangerine task create`
- `tangerine secret set|get|list|delete`

## Specs

- [Architecture](specs/architecture.md)
- [Agent Integration](specs/agent.md)
- [API](specs/api.md)
- [Tasks](specs/tasks.md)
- [Web Dashboard](specs/web.md)
- [CLI](specs/cli.md)
- [Credentials](specs/credentials.md)
- [v0 Scope](specs/v0-scope.md)
- [v1 Local Server](specs/v1-local-server.md)
