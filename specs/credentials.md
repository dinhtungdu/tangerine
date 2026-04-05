# Credentials

How API keys and tokens are configured. All credentials live on the machine where Tangerine runs.

## Credential Types

| Credential | Purpose | Source |
|------------|---------|--------|
| OpenCode `auth.json` | LLM provider auth for OpenCode (API keys or OAuth tokens) | `~/.local/share/opencode/auth.json` |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code OAuth authentication | Dotfile or env var |
| `ANTHROPIC_API_KEY` | Direct Anthropic API key (both providers) | Dotfile or env var |
| `EXTERNAL_HOST` | External hostname for access (e.g. Tailscale hostname) | Dotfile or env var (default: `localhost`) |

## GitHub Authentication

All GitHub access goes through the `gh` CLI, which supports both `gh auth login` (OAuth) and the `GITHUB_TOKEN` environment variable. Tangerine does **not** store or manage `GITHUB_TOKEN` itself — configure it via `gh auth login` or set it in your shell environment before starting Tangerine.

The startup check (`tangerine start`) verifies `gh auth status` and warns if unauthenticated.

## Credential Storage

Three sources (in priority order — first match wins):

1. **Environment variables** — `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, etc.
2. **Dotfile** (`~/tangerine/.credentials`) — managed via CLI, mode 0600
3. **OpenCode auth.json** (`~/.local/share/opencode/auth.json`) — LLM provider credentials for OpenCode

### Credential Dotfile

`~/tangerine/.credentials` stores credentials as `KEY=VALUE` lines (mode 0600). Managed via CLI:

```bash
tangerine config set ANTHROPIC_API_KEY=sk-ant-...
tangerine config get ANTHROPIC_API_KEY
tangerine config unset ANTHROPIC_API_KEY
tangerine config list                          # shows all keys, values masked
```

Allowed keys: `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `EXTERNAL_HOST`.

Env vars override dotfile values. Server reads dotfile at startup via `loadConfig()`.

## Agent Credential Resolution

Agents run as local processes and inherit the server's environment. The task lifecycle sets credential env vars before spawning the agent.

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
- Credentials persist between tasks (acceptable for local single-user)
