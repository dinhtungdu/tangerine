# CLI

The `tangerine` CLI is implemented under `packages/server/src/cli/`.

## Top-Level Commands

| Command | Description |
|---------|-------------|
| `tangerine start` | Start the Tangerine server |
| `tangerine install` | Create local directories and install Tangerine skills into the ACP skills dir |
| `tangerine project ...` | Manage registered projects |
| `tangerine task ...` | Create manual tasks |
| `tangerine acp probe` | Probe configured ACP adapter capabilities/config/events |
| `tangerine secret ...` | Manage secrets stored in `.credentials` |

## `tangerine start`

Starts the Bun server and loads config/database state.

Supported flags:

- `--config <path>`
- `--db <path>`

The server verifies required external tools at startup, including `git`, `gh` for GitHub-backed repos, and optional agent CLIs.

If the server binds a non-loopback host (for example `0.0.0.0`) and `TANGERINE_AUTH_TOKEN` is not configured, startup must fail unless `TANGERINE_INSECURE_NO_AUTH=1` is explicitly set.

## `tangerine install`

Current behavior:

- ensures `~/tangerine` exists
- symlinks repo skills into the provider-neutral ACP skills directory (`~/.config/acp/skills`)
- does not install ACP agent adapters or manage LLM credentials

Configured ACP agent examples:

| Agent | No-global-install command | Global command |
|-------|---------------------------|----------------|
| Claude Code | `bunx --bun @zed-industries/claude-code-acp` | `claude-code-acp` |
| Codex | `bunx --bun @zed-industries/codex-acp` | `codex-acp` |
| OpenCode | `bunx --bun opencode-ai acp` | `opencode acp` |
| Pi | `bunx --bun pi-acp` | `pi-acp` |

Installed skills:

- `platform-setup`
- `tangerine-tasks`
- `browser-test`

## `tangerine acp probe`

Inspects configured external ACP agents without adding provider-specific runtime code.

Default behavior runs `initialize` and `session/new` for each configured agent, then prints a capability/config matrix. `--prompt` additionally runs `session/prompt` and summarizes stream events.

Supported flags:

- `--agent, -a <id>`: probe one configured agent
- `--cwd <path>`: session working directory (default: current directory)
- `--prompt, -p <text>`: run one prompt and summarize streaming updates
- `--timeout, -t <ms>`: per-agent timeout, default `5000`
- `--json`: print raw JSON result

Examples:

```bash
tangerine acp probe
tangerine acp probe --agent claude --json
tangerine acp probe --agent pi --prompt "Say hi" --json
```

## `tangerine project`

Subcommands:

- `add`
- `list`
- `show <name>`
- `remove <name>`

`project add` currently supports:

- `--name`
- `--repo`
- `--setup`
- `--branch`
- `--test`

## `tangerine task`

Current subcommands:

- `create`

`task create` supports:

- `--project`
- `--title`
- `--description`
- `--branch`

It inserts a manual task row directly into the DB.

## `tangerine secret`

Manages Tangerine secrets stored in `~/tangerine/.credentials` (mode 0600). ACP agent LLM credentials are managed by each agent's own CLI/config.

Subcommands:

- `set KEY=VALUE`
- `get KEY`
- `list`
- `delete KEY`

Allowed keys currently come from `ALLOWED_CREDENTIAL_KEYS`:

- `TANGERINE_AUTH_TOKEN`
- `EXTERNAL_HOST`

Credentials are stored in `~/tangerine/.credentials` with mode `0600`.

Examples:

```bash
tangerine secret set TANGERINE_AUTH_TOKEN=$(openssl rand -hex 32)
tangerine secret get TANGERINE_AUTH_TOKEN
tangerine secret list
tangerine secret delete TANGERINE_AUTH_TOKEN
```
