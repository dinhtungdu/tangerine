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

## Start Options

`tangerine start` accepts runtime overrides for isolated test instances:

- `--config <path>` — load config JSON from a non-default path
- `--db <path>` — use a non-default SQLite database file
- `--test-mode` — enable gated `/api/test/*` routes

## Credential Management

### Storage

Credentials stored in `~/tangerine/.credentials` (mode `0600`). Plain text, one `KEY=VALUE` per line.

### Allowed Keys

| Key | Provider | Purpose |
|-----|----------|---------|
| `ANTHROPIC_API_KEY` | Claude Code, OpenCode | LLM API key |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code | OAuth token (alternative to API key) |
| `GITHUB_TOKEN` | All | GitHub API + git HTTPS auth |

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
- OpenCode auth: existence check on `~/.local/share/opencode/auth.json`

### Validation

On task creation, the server validates credentials for the requested provider:

- **claude-code**: requires `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`
- **opencode**: requires OpenCode `auth.json` or `ANTHROPIC_API_KEY`

Missing credentials → 400 error with instructions to set them via `tangerine config set`.

### Credential Injection

Agents run as local processes and inherit credential env vars from the server. Activity log records which credentials were available (`creds.injected`) or missing (`creds.missing`).
