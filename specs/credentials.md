# Credentials

How API keys and tokens flow from host to VM. Never baked into images.

## Credential Types

| Credential | Purpose | Source |
|------------|---------|--------|
| OpenCode `auth.json` | LLM provider auth (API keys or OAuth tokens) | Host's `~/.local/share/opencode/auth.json` |
| `GITHUB_TOKEN` | git push, `gh pr create` | Static PAT (v0) / User OAuth (hosted) |
| `GH_HOST` | GitHub Enterprise | Server config |
| `OPENCODE_SERVER_PASSWORD` | Protect OpenCode API in VM | Generated per session |

## OpenCode Auth Inheritance

OpenCode stores credentials in `~/.local/share/opencode/auth.json` (mode 0600). It supports three credential types:

```json
{
  "anthropic": { "type": "api", "key": "sk-ant-..." },
  "github-copilot": { "type": "oauth", "refresh": "...", "access": "...", "expires": 1234567890 },
  "some-enterprise": { "type": "wellknown", "key": "...", "token": "..." }
}
```

| Type | Fields | Use Case |
|------|--------|----------|
| `api` | `key` | Direct API keys (Anthropic, OpenAI) |
| `oauth` | `refresh`, `access`, `expires`, optional `accountId`/`enterpriseUrl` | ChatGPT Plus / GitHub Copilot OAuth |
| `wellknown` | `key`, `token` | Enterprise `.well-known/opencode` endpoints |

OpenCode resolves credentials in this order: env vars → project `.env` → `auth.json` → config file.

### Why Inherit auth.json

- **Provider-agnostic**: user authenticates once on host (API key or OAuth), VMs inherit it
- **OAuth support**: users with ChatGPT Plus / GitHub Copilot can use OAuth tokens without managing API keys
- **No config needed**: Tangerine doesn't need to know which provider or auth method the user chose

## Injection Flow

```
1. Session starts → API server reads host credentials
2. SSH into VM
3. Copy host's auth.json → VM's ~/.local/share/opencode/auth.json
4. Inject GitHub token + server password into environment
5. Start opencode serve (picks up auth.json automatically)
```

### auth.json Copy

```bash
# From host → VM via SCP
scp -P <ssh-port> ~/.local/share/opencode/auth.json \
  agent@<vm-ip>:/home/agent/.local/share/opencode/auth.json
ssh -p <ssh-port> agent@<vm-ip> "chmod 600 /home/agent/.local/share/opencode/auth.json"
```

### Environment Injection

GitHub token and server password still go via environment (not in auth.json):

```bash
_CREDS=$(mktemp)
cat > "$_CREDS" <<'EOF'
export GITHUB_TOKEN='ghp_...'
export GH_TOKEN='ghp_...'
export OPENCODE_SERVER_PASSWORD='<generated>'
EOF
source "$_CREDS"
rm -f "$_CREDS"
```

### Fallback: ANTHROPIC_API_KEY

If `auth.json` doesn't exist on the host (user hasn't set up OpenCode locally), fall back to injecting `ANTHROPIC_API_KEY` as an environment variable. OpenCode env vars take highest priority, so this still works.

## Git Authentication

Inside VM:

```bash
git config --global credential.helper store
echo 'https://x-access-token:<GITHUB_TOKEN>@github.com' > ~/.git-credentials
chmod 600 ~/.git-credentials
```

For GitHub Enterprise:
```bash
echo 'https://x-access-token:<TOKEN>@github.mycompany.com' >> ~/.git-credentials
git config --global "url.https://github.mycompany.com/.insteadOf" "git@github.mycompany.com:"
```

## PR Creation

Agent uses `gh` CLI inside VM:

```bash
gh pr create --base main --head tangerine/abc123 --fill
```

`GH_TOKEN` and `GH_HOST` (if GHE) are in the environment.

### Attribution

v0: PRs authored by whoever owns the `GITHUB_TOKEN` (static PAT).

Future (hosted):
- User logs in via GitHub OAuth
- Their token stored server-side per user
- Injected into VM for their tasks
- PRs show up as the actual user

## Credential Storage (v0)

Two sources on the host:

1. **OpenCode auth.json** (`~/.local/share/opencode/auth.json`) — LLM provider credentials (API keys or OAuth tokens). Managed by `opencode auth login` or OpenCode's `/connect` command.
2. **Environment variables** — `GITHUB_TOKEN`, `GH_HOST`. Set in `.env` or shell profile.

Users who prefer not to use OpenCode's auth system can still set `ANTHROPIC_API_KEY` as an env var — the fallback path handles this.

Future (hosted): encrypted credential store per user, similar to hal9999's auth module (Keychain / Secret Service / encrypted file).

## VM Credential Cleanup

On session end / VM release:
1. Remove `~/.local/share/opencode/auth.json`
2. Unset env vars
3. Remove `~/.git-credentials`
4. VM returned to warm pool clean

## Security Notes

- Credentials exist in VM memory during session — acceptable for local VMs
- SSH tunnel means OpenCode API is not exposed on network (only localhost)
- `OPENCODE_SERVER_PASSWORD` adds a layer even if tunnel leaks
- Golden images never contain credentials
- Credential injection happens per-session, not at image build time
- `auth.json` is copied with mode 0600 — only the agent user can read it
