# 🍊 Tangerine

Local background coding agent platform. Agents run in isolated VMs, users interact via web dashboard or terminal. Tasks sourced from GitHub/Linear issues.

Like [Ramp Inspect](https://builders.ramp.com/post/why-we-built-our-background-agent) or [Stripe Minion](https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents), but running locally.

## How It Works

1. GitHub issue labeled `agent` → Tangerine creates a task
2. VM spins up from pre-built golden image (Lima/Incus)
3. OpenCode agent starts inside VM, clones repo, begins work
4. Web dashboard: click task → chat with agent + live preview
5. Terminal: `opencode attach` to join session from terminal
6. Agent pushes branch, creates PR when done

## Architecture

See [specs/architecture.md](specs/architecture.md) for full details.

```
Web Dashboard → API Server → SSH Tunnel → OpenCode (in VM)
                                        → Dev Server (in VM)
```

## Stack

- **Runtime**: Bun
- **API**: Hono (REST + WebSocket)
- **Frontend**: Vite + React
- **Agent**: OpenCode (server mode + SDK)
- **VMs**: Lima (macOS) / Incus (Linux)
- **DB**: SQLite

## Specs

- [Architecture](specs/architecture.md)
- [Project Config](specs/project.md)
- [VM Layer](specs/vm.md)
- [Agent Integration](specs/agent.md)
- [Tasks](specs/tasks.md)
- [API](specs/api.md)
- [Web Dashboard](specs/web.md)
- [Credentials](specs/credentials.md)
- [Testing](specs/testing.md)
- [v0 Scope](specs/v0-scope.md)

## Running

Start the server directly:

```bash
bin/tangerine start
```

For auto-restart on updates (recommended for production), use the watch loop:

```bash
bin/tangerine-watch
```

The watch loop runs the server with `TANGERINE_SELF_UPDATE=1`, which enables a background poller that checks for new commits every 60 seconds. When an update is applied (via the dashboard's "Pull latest" button), the server exits cleanly and the watch loop restarts it automatically. Non-zero exits (crashes) stop the loop.

## Status

Planning phase. See [v0 scope](specs/v0-scope.md) for implementation plan.
