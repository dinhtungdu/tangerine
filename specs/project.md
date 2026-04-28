# Project Configuration

Each project defines its own environment. The platform is project-agnostic — WordPress, React, Rails, whatever.

## Project Config

Stored in `tangerine.json` at the project root (or `~/.config/tangerine/config.json` for global defaults).

```json
{
  "projects": [{
    "name": "wordpress-develop",
    "repo": "https://github.com/WordPress/wordpress-develop",
    "defaultBranch": "trunk",
    "setup": "npm install && npx wp-env start",
    "defaultAgent": "claude",
    "taskTypes": {
      "worker": {
        "mode": "bypass-permissions"
      },
      "runner": {
        "agent": "codex",
        "model": "gpt-5",
        "reasoningEffort": "high"
      }
    },
    "test": "npx wp-env run tests-wordpress phpunit",
    "env": {
      "PHP_VERSION": "8.2"
    }
  }]
}
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Human-readable project name (also used as project ID) |
| `repo` | string | yes | Repository URL (or `owner/repo` shorthand) |
| `defaultBranch` | string | no | Default: `main` |
| `setup` | string | yes | Shell commands to run in task worktrees |
| `defaultAgent` | string | no | Configured ACP agent ID. Default: top-level `defaultAgent` or `acp` |
| `test` | string | no | Command to run tests |
| `env` | object | no | Extra env vars passed to agent process |
| `model` | string | no | Model override for this project |
| `prMode` | `"ready" \| "draft" \| "none"` | no | How worker agents handle PRs. `ready`: normal PR, `draft`: draft PR, `none`: commit only, no push/PR. Default: `"none"` |
| `taskTypes` | object | no | Per-task-type prompt, quick reply, agent, model, mode, and reasoning-effort defaults for `worker`, `reviewer`, and `runner`. `taskTypes.worker.mode` sets the default agent mode (e.g. `"bypass-permissions"` for Claude). |

### Top-Level Config

```json
{
  "projects": [...],
  "agents": [
    { "id": "claude", "name": "Claude Agent", "command": "bunx", "args": ["--bun", "@agentclientprotocol/claude-agent-acp"] },
    { "id": "codex", "name": "Codex", "command": "bunx", "args": ["--bun", "@zed-industries/codex-acp"] },
    { "id": "opencode", "name": "OpenCode", "command": "bunx", "args": ["--bun", "opencode-ai", "acp"] },
    { "id": "pi", "name": "Pi", "command": "bunx", "args": ["--bun", "pi-acp"] }
  ],
  "defaultAgent": "claude",
  "model": "gpt-5",
  "sshHost": "dev-vm",
  "sshUser": "tung.linux",
  "editor": "vscode",
  "integrations": {
    "github": {
      "webhookSecret": "...",
      "pollIntervalMinutes": 60,
      "trigger": { "type": "label", "value": "agent" }
    }
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `agents` | object[] | Configured ACP agent commands |
| `defaultAgent` | string | Default ACP agent ID |
| `model` | string | Optional initial model hint for ACP agents |
| `workspace` | string | Base directory for project clones and worktrees (default: `~/tangerine-workspace`) |
| `sshHost` | string | SSH hostname for editor deep-links (e.g. `"dev-vm"`) |
| `sshUser` | string | SSH username for Zed editor links (e.g. `"tung.linux"`) |
| `editor` | `"vscode" \| "cursor" \| "zed"` | Editor for deep-link URIs. VS Code/Cursor use `vscode-remote` scheme; Zed uses `zed://ssh/` |
| `integrations` | object | GitHub webhook and polling configuration |

Known ACP adapter examples:

| Agent ID | Command config |
|----------|----------------|
| `claude` | `bunx --bun @agentclientprotocol/claude-agent-acp` or global `claude-agent-acp` |
| `codex` | `bunx --bun @zed-industries/codex-acp` or global `codex-acp` |
| `opencode` | `bunx --bun opencode-ai acp` or global `opencode acp` |
| `pi` | `bunx --bun pi-acp` or global `pi-acp` |

These are examples only. Tangerine accepts any ACP-compatible command and expects each underlying agent to be installed/authenticated outside Tangerine.

When `sshHost` and `editor` are set, the web dashboard shows "Open in {editor}" links on task cards and the task detail page for tasks with worktrees. `sshUser` is required for Zed links.

The `sshHost` value must match an entry in `~/.ssh/config` on the **host machine** (where the editor runs). Example:

```
Host dev-vm
  HostName 192.168.64.5
  User tung.linux
```

## Project Setup Flow

When a task starts:

```
1. Clone repo to workspace (or git fetch if already there)
2. Create git worktree for task
3. Run project.setup commands in worktree
4. Start configured ACP agent in worktree
5. Connect to ACP agent over stdio
6. Session ready for chat
```

## Multiple Projects

Config supports multiple projects in the `projects` array. Dashboard shows project context.
