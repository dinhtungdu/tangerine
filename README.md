# Tangerine

Local background coding agent platform. Tangerine runs as a local Bun server, spawns agent CLIs as local processes, isolates work in git worktrees, and exposes a web dashboard for managing runs.

## Current Architecture

- Single-machine runtime: no per-project VMs, SSH tunnels, or image builds in the active codepath
- Multi-provider agents: OpenCode, Claude Code, and Codex
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
    agent/         # provider adapters: OpenCode, Claude Code, Codex
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

- Manual, GitHub, and cross-project task creation
- Task types: `worker`, `orchestrator`, `reviewer`
- Task capabilities derived from type, not title
- On-demand orchestrator startup
- Model and reasoning-effort changes on running tasks
- Git diff, activity log, terminal attach, system log, and project update controls in the UI
- GitHub PR reference resolution from branch input like `#123` or full PR URLs
- Self-update flow for project repos via `postUpdateCommand`
- SSH editor deep-links to open task worktrees in VS Code, Cursor, or Zed (requires `sshHost`/`editor` in config and a matching `Host` entry in `~/.ssh/config` on the host machine)

## Development

```bash
bun install
bun link        # make `tangerine` available globally
bun run check
bun test
bun run build
```

Add a project, then start:

```bash
tangerine project add --name <name> --repo <url> --setup "<cmd>"  # once
tangerine install  # install agent skills (once)
tangerine start
```

During development you can run the API and web processes separately:

```bash
bun run dev:api
bun run dev:web
```

## CLI

- `tangerine start`
- `tangerine install`
- `tangerine project add|list|show|remove`
- `tangerine task create`
- `tangerine config set|get|unset|list`

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
