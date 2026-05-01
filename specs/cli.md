# CLI

The `tangerine` CLI is implemented under `packages/server/src/cli/`.

## Top-Level Commands

| Command | Description |
|---------|-------------|
| `tangerine start` | Start the Tangerine server |
| `tangerine install` | Create local directories and install Tangerine skills into configured real agent skill dirs |
| `tangerine uninstall` | Remove Tangerine skills from configured real agent skill dirs |
| `tangerine migrate` | Migrate projects from old numbered worktree layout to current sibling layout |
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
- reads configured ACP adapter commands from `~/tangerine/config.json` (or `TANGERINE_CONFIG`)
- maps known adapter commands to skills.sh agent IDs, then runs the `skills` CLI to install Tangerine skills globally into those real agents
- never treats `acp` as a skill target; ACP is the protocol, not an agent skill directory
- does not install ACP agent adapters or manage LLM credentials

Adapter-to-skill-agent mapping:

| Configured adapter command | skills.sh agent |
|----------------------------|-----------------|
| `@agentclientprotocol/claude-agent-acp` / `claude-agent-acp` | `claude-code` |
| `@zed-industries/codex-acp` / `codex-acp` | `codex` |
| `opencode-ai acp` / `opencode acp` | `opencode` |
| `pi-acp` | `pi` |

Configured ACP agent examples:

| Agent | No-global-install command | Global command |
|-------|---------------------------|----------------|
| Claude Agent | `bunx --bun @agentclientprotocol/claude-agent-acp` | `claude-agent-acp` |
| Codex | `bunx --bun @zed-industries/codex-acp` | `codex-acp` |
| OpenCode | `bunx --bun opencode-ai acp` | `opencode acp` |
| Pi | `bunx --bun pi-acp` | `pi-acp` |

Installed skills:

- `platform-setup`
- `tangerine-tasks`
- `release-semver`

Install command shape:

```bash
npx skills add <tangerine-package-root> --global --agent <detected-agent> --skill platform-setup --skill tangerine-tasks --skill release-semver -y
```

`browser-test` remains project-local and is not installed globally.

## `tangerine uninstall`

Current behavior:

- uses the same config-based adapter detection as `install`
- runs `npx skills remove --global --agent <detected-agent> --skill platform-setup --skill tangerine-tasks --skill release-semver -y`
- leaves `~/tangerine`, project config, credentials, and external ACP agent adapters untouched
- idempotent; rerunning is safe

## `tangerine migrate`

Migrates existing project directories from the old layout (`{workspace}/{project}/0`, `/1`, `/2`) to the current sibling layout (`{workspace}/{project}`, `{project}--1`, `{project}--2`).

Behavior:

- scans all configured projects by default
- `--project, -p <name>` limits migration to one project
- releases stale slots bound to terminal or missing tasks before migration
- skips projects with active bound slots or active task worktree paths in the old layout, and exits non-zero so the user can finish/cancel tasks and rerun
- clears terminal task `worktree_path` values that pointed at old numbered worktrees
- recreates the worktree pool after a successful migration

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
