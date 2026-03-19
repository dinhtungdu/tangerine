# Credentials

How API keys and tokens flow from host to VM. Never baked into images.

## Credential Types

| Credential | Purpose | Source |
|------------|---------|--------|
| OpenCode `auth.json` | LLM provider auth for OpenCode (API keys or OAuth tokens) | Host's `~/.local/share/opencode/auth.json` |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code OAuth authentication | Host env var |
| `ANTHROPIC_API_KEY` | Direct Anthropic API key (both providers) | Host env var |
| `GITHUB_TOKEN` | git push, `gh pr create` | Static PAT (v0) / User OAuth (hosted) |
| `GH_HOST` | GitHub Enterprise | Server config |

## Injection Flow

Credentials are injected into the VM's `~/.env` file, then sourced by the agent process on startup.

```
1. Task starts → lifecycle.ts reads host credentials
2. SSH into VM
3. Copy host's auth.json → VM (for OpenCode provider)
4. Write env vars to ~/.env on VM
5. Agent start command sources ~/.env before launching
```

### auth.json Copy (OpenCode)

```bash
scp -P <ssh-port> ~/.local/share/opencode/auth.json \
  root@<vm-ip>:/root/.local/share/opencode/auth.json
```

### Environment Injection (~/.env)

All providers source `~/.env` before launching. The lifecycle writes credentials as env vars:

```bash
# Written to ~/.env on the VM
export GITHUB_TOKEN='ghp_...'
export GH_TOKEN='ghp_...'
export ANTHROPIC_API_KEY='sk-ant-...'
export CLAUDE_CODE_OAUTH_TOKEN='...'
```

The agent start commands all include: `test -f ~/.env && set -a && . ~/.env && set +a`

### Claude Code Auth

Claude Code uses `CLAUDE_CODE_OAUTH_TOKEN` for OAuth authentication. If not set, falls back to `ANTHROPIC_API_KEY`. Both are injected via `~/.env`.

### Fallback: ANTHROPIC_API_KEY

If `auth.json` doesn't exist on the host, `ANTHROPIC_API_KEY` is injected as an env var. Works for both OpenCode (env vars take highest priority) and Claude Code.

## OpenCode Auth Inheritance

OpenCode stores credentials in `~/.local/share/opencode/auth.json` (mode 0600). It supports three credential types:

| Type | Fields | Use Case |
|------|--------|----------|
| `api` | `key` | Direct API keys (Anthropic, OpenAI) |
| `oauth` | `refresh`, `access`, `expires` | ChatGPT Plus / GitHub Copilot OAuth |
| `wellknown` | `key`, `token` | Enterprise `.well-known/opencode` endpoints |

## Git Authentication

Inside VM:

```bash
git config --global credential.helper store
echo 'https://x-access-token:<GITHUB_TOKEN>@github.com' > ~/.git-credentials
chmod 600 ~/.git-credentials
```

## PR Creation

Agent uses `gh` CLI inside VM:

```bash
gh pr create --base main --head tangerine/abc123 --fill
```

`GH_TOKEN` and `GH_HOST` (if GHE) are in the environment.

### Attribution

v0: PRs authored by whoever owns the `GITHUB_TOKEN` (static PAT).
Future (hosted): user OAuth tokens per user.

## Credential Storage (v0)

Three sources on the host:

1. **OpenCode auth.json** (`~/.local/share/opencode/auth.json`) — LLM provider credentials for OpenCode
2. **Environment variables** — `GITHUB_TOKEN`, `GH_HOST`, `ANTHROPIC_API_KEY`
3. **`CLAUDE_CODE_OAUTH_TOKEN`** — OAuth token for Claude Code provider

## Security Notes

- Credentials exist in VM `~/.env` during session — acceptable for local VMs
- SSH tunnel means OpenCode API is not exposed on network (only localhost)
- Golden images never contain credentials
- Credential injection happens per-session, not at image build time
- `auth.json` is copied with mode 0600
- VM persists between tasks — credentials persist too (acceptable for local single-user)
