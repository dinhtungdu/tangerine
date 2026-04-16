# Credentials

How API keys and tokens are configured. All credentials live on the machine where Tangerine runs.

## Credential Types

| Credential | Purpose | Source |
|------------|---------|--------|
| OpenCode `auth.json` | LLM provider auth for OpenCode (API keys or OAuth tokens) | `~/.local/share/opencode/auth.json` |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code OAuth authentication | Dotfile or env var |
| `ANTHROPIC_API_KEY` | Direct Anthropic API key (both providers) | Dotfile or env var |
| `TANGERINE_AUTH_TOKEN` | Shared bearer token for dashboard/API/WebSocket access | Dotfile or env var |
| `EXTERNAL_HOST` | External hostname for access (e.g. Tailscale hostname) | Dotfile or env var (default: `localhost`) |

## GitHub Authentication

All GitHub access goes through the `gh` CLI, which supports both `gh auth login` (OAuth) and the `GITHUB_TOKEN` environment variable. Tangerine does **not** store or manage `GITHUB_TOKEN` itself — configure it via `gh auth login` or set it in your shell environment before starting Tangerine.

The startup check (`tangerine start`) verifies `gh auth status` and warns if unauthenticated.

## Credential Storage

Three sources (in priority order — first match wins):

1. **Environment variables** — `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `TANGERINE_AUTH_TOKEN`, etc.
2. **Dotfile** (`~/tangerine/.credentials`) — managed via `tangerine secret`, mode 0600
3. **OpenCode auth.json** (`~/.local/share/opencode/auth.json`) — LLM provider credentials for OpenCode

### Credential Dotfile

`~/tangerine/.credentials` stores credentials as `KEY=VALUE` lines (mode 0600). Managed via `tangerine secret`:

```bash
tangerine secret set ANTHROPIC_API_KEY=sk-ant-...
tangerine secret set TANGERINE_AUTH_TOKEN=$(openssl rand -hex 32)
tangerine secret get ANTHROPIC_API_KEY
tangerine secret delete ANTHROPIC_API_KEY
tangerine secret list                          # shows all keys, values masked
```

Allowed keys: `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `TANGERINE_AUTH_TOKEN`, `EXTERNAL_HOST`.

Env vars override dotfile values. Server reads dotfile at startup via `loadConfig()`.

## Agent Credential Resolution

Agents run as local processes and inherit the server's environment. The task lifecycle sets credential env vars before spawning the agent.

This includes `TANGERINE_AUTH_TOKEN`, so agent prompts can use authenticated `curl` calls back into the Tangerine API.

### Per-Provider Validation

Task creation validates that credentials exist for the requested provider:

- `claude-code` → requires `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`
- `opencode` → requires `auth.json` or `ANTHROPIC_API_KEY`

Missing credentials fail fast with an actionable error message before the task starts.

## PR Creation

Agent uses `gh` CLI:

```bash
gh pr create --base main --head tangerine/abc123 --fill
```

`gh` CLI handles auth automatically via `gh auth login` or `GITHUB_TOKEN` in the environment.

## Security Notes

- Dotfile stored with mode 0600
- `auth.json` stored with mode 0600
- The dashboard stores `TANGERINE_AUTH_TOKEN` in browser `localStorage` on the client machine after unlock
- Credentials persist between tasks (acceptable for local single-user)
- Remote access over LAN/Tailscale should use `TANGERINE_AUTH_TOKEN`
