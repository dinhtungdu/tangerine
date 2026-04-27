# Credentials

How tokens are configured. All credentials live on the machine where Tangerine runs.

## Credential Types

| Credential | Purpose | Source |
|------------|---------|--------|
| `TANGERINE_AUTH_TOKEN` | Shared bearer token for dashboard/API/WebSocket access and agent self-calls | Dotfile or env var |
| `EXTERNAL_HOST` | External hostname for access (e.g. Tailscale hostname) | Dotfile or env var (default: `localhost`) |
| ACP agent credentials | LLM auth for the configured ACP agent command | Managed by that agent's own CLI/config |

## GitHub Authentication

All GitHub access goes through the `gh` CLI, which supports both `gh auth login` (OAuth) and the `GITHUB_TOKEN` environment variable. Tangerine does **not** store or manage `GITHUB_TOKEN` itself — configure it via `gh auth login` or set it in your shell environment before starting Tangerine.

The startup check (`tangerine start`) verifies `gh auth status` and warns if unauthenticated.

## Credential Storage

Two Tangerine-controlled sources (priority order — first match wins):

1. **Environment variables** — `TANGERINE_AUTH_TOKEN`, `EXTERNAL_HOST`, etc.
2. **Dotfile** (`~/tangerine/.credentials`) — managed via `tangerine secret`, mode 0600

ACP agent credentials are outside Tangerine. Configure and authenticate each ACP agent command directly before starting Tangerine.

### Credential Dotfile

`~/tangerine/.credentials` stores credentials as `KEY=VALUE` lines (mode 0600). Managed via `tangerine secret`:

```bash
tangerine secret set TANGERINE_AUTH_TOKEN=$(openssl rand -hex 32)
tangerine secret get TANGERINE_AUTH_TOKEN
tangerine secret delete TANGERINE_AUTH_TOKEN
tangerine secret list                          # shows all keys, values masked
```

Allowed keys: `TANGERINE_AUTH_TOKEN`, `EXTERNAL_HOST`.

Env vars override dotfile values. Server reads dotfile at startup via `loadConfig()`.

## Agent Credential Resolution

ACP agents run as local processes and inherit the server environment plus Tangerine task env vars.

Tangerine injects `TANGERINE_AUTH_TOKEN` into agent processes so prompts can use authenticated `curl` calls back into the Tangerine API.

Tangerine does not validate LLM credentials. If an ACP agent fails due to missing credentials, authenticate that agent's CLI/config directly and retry.

## PR Creation

Agent uses `gh` CLI:

```bash
gh pr create --base main --head tangerine/abc123 --fill
```

`gh` CLI handles auth automatically via `gh auth login` or `GITHUB_TOKEN` in the environment.

## Security Notes

- Dotfile stored with mode 0600
- The dashboard stores `TANGERINE_AUTH_TOKEN` in browser `localStorage` on the client machine after unlock
- ACP agent credentials stay in each agent's native storage
- Credentials persist between tasks (acceptable for local single-user)
- Remote access over LAN/Tailscale should use `TANGERINE_AUTH_TOKEN`
