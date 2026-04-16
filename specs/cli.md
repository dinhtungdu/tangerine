# CLI

The `tangerine` CLI is implemented under `packages/server/src/cli/`.

## Top-Level Commands

| Command | Description |
|---------|-------------|
| `tangerine start` | Start the Tangerine server |
| `tangerine install` | Create local directories and install skills for all providers |
| `tangerine project ...` | Manage registered projects |
| `tangerine task ...` | Create manual tasks |
| `tangerine config ...` | Manage stored credentials |

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
- symlinks repo skills into each provider's configured skill directory
- checks whether usable LLM credentials are present

Installed skills:

- `platform-setup`
- `tangerine-tasks`
- `browser-test`

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

## `tangerine config`

Subcommands:

- `set KEY=VALUE`
- `get KEY`
- `unset KEY`
- `list`

Allowed keys currently come from `ALLOWED_CREDENTIAL_KEYS`:

- `ANTHROPIC_API_KEY`
- `CLAUDE_CODE_OAUTH_TOKEN`
- `TANGERINE_AUTH_TOKEN`
- `EXTERNAL_HOST`

Credentials are stored in `~/tangerine/.credentials` with mode `0600`.
