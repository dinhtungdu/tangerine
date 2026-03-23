# CLI

`tangerine` CLI for managing the platform. All commands run locally.

## Commands

| Command | Description |
|---------|-------------|
| `tangerine start` | Start the API server |
| `tangerine install` | Install dependencies (Lima, base image) |
| `tangerine project add` | Register a project |
| `tangerine image build` | Build golden image for a project |
| `tangerine image build-base` | Build base image |
| `tangerine task list` | List tasks |
| `tangerine pool status` | VM pool status |
| `tangerine config` | Credential management |

## Credential Management

### Storage

Credentials stored in `~/tangerine/.credentials` (mode `0600`). Plain text, one `KEY=VALUE` per line.

### Allowed Keys

| Key | Provider | Purpose |
|-----|----------|---------|
| `ANTHROPIC_API_KEY` | Claude Code, OpenCode | LLM API key |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code | OAuth token (alternative to API key) |
| `GITHUB_TOKEN` | All | GitHub API + git HTTPS auth |
| `GH_ENTERPRISE_TOKEN` | All | GitHub Enterprise token |
| `GH_HOST` | All | GitHub Enterprise hostname (default: `github.com`) |

### Subcommands

```
tangerine config set KEY=VALUE   # Set a credential
tangerine config get KEY         # Get a credential value
tangerine config unset KEY       # Remove a credential
tangerine config list            # List all credentials (masked)
```

### Precedence

Environment variables override dotfile values:

```
env var > ~/tangerine/.credentials > OpenCode auth.json (for OpenCode only)
```

Resolved in `loadConfig()`:
- `ANTHROPIC_API_KEY`: `$ANTHROPIC_API_KEY` → dotfile → (not set)
- `CLAUDE_CODE_OAUTH_TOKEN`: `$CLAUDE_CODE_OAUTH_TOKEN` → dotfile → (not set)
- `GITHUB_TOKEN`: `$GITHUB_TOKEN` → dotfile → (not set)
- `GH_ENTERPRISE_TOKEN`: `$GH_ENTERPRISE_TOKEN` → dotfile → (not set)
- `GH_HOST`: `$GH_HOST` → dotfile → `"github.com"`
- OpenCode auth: existence check on `~/.local/share/opencode/auth.json`

### Validation

On task creation, the server validates credentials for the requested provider:

- **claude-code**: requires `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`
- **opencode**: requires OpenCode `auth.json` or `ANTHROPIC_API_KEY`

Missing credentials → 400 error with instructions to set them via `tangerine config set`.

### Credential Injection

During session start (`startSession`) and reconnect (`reconnectSession`), credentials are injected into the VM via SSH:

1. Write env vars to `~/.env` in the VM
2. Set up `~/.git-credentials` for HTTPS auth (if GitHub tokens present)
3. Copy OpenCode `auth.json` if it exists on host

Activity log records which credentials were injected (`creds.injected`) or missing (`creds.missing`).
