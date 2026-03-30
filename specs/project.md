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
    "image": "wordpress-dev",
    "setup": "npm install && npx wp-env start",
    "defaultProvider": "opencode",
    "previewCommand": "setup-vhost.sh $TANGERINE_PREVIEW_PORT",
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
| `image` | string | yes | Golden image name (built from image assets dir) |
| `setup` | string | yes | Shell commands to run after clone (install deps, start dev server) |
| `defaultProvider` | `"opencode" \| "claude-code"` | no | Default agent provider. Default: `"opencode"` |
| `previewCommand` | string | no | Command to run on first preview access (e.g. setup vhost, start server). Port available via `$TANGERINE_PREVIEW_PORT` |
| `test` | string | no | Command to run tests |
| `extraPorts` | number[] | no | Additional ports to forward |
| `env` | object | no | Extra env vars passed to VM |
| `model` | string | no | Model override for this project |

### Top-Level Config

```json
{
  "projects": [...],
  "model": "openai/gpt-5.4",
  "models": ["openai/gpt-5.4", "anthropic/claude-sonnet-4-20250514", ...],
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
| `model` | string | Default LLM model for new tasks |
| `models` | string[] | Available models shown in the UI |
| `workspace` | string | Base directory for project clones and worktrees (default: `~/tangerine-workspace`) |
| `sshHost` | string | SSH hostname for editor deep-links (e.g. `"dev-vm"`) |
| `sshUser` | string | SSH username for Zed editor links (e.g. `"tung.linux"`) |
| `editor` | `"vscode" \| "cursor" \| "zed"` | Editor for deep-link URIs. VS Code/Cursor use `vscode-remote` scheme; Zed uses `zed://ssh/` |
| `integrations` | object | GitHub webhook and polling configuration |

When `sshHost` and `editor` are set, the web dashboard shows "Open in {editor}" links on task cards and the task detail page for tasks with worktrees. `sshUser` is required for Zed links.

## Golden Images

Base environments with common tooling pre-installed. Project-specific setup runs on top at session start.

### Two-Layer Build

1. **Base layer** (`tangerine-base`): built from `tangerine.yaml` with cloud-init. Contains Node.js, Docker, OpenCode, Claude Code, gh CLI, etc. Slow (~10 min), rarely rebuilt.
2. **Project layer** (`tangerine-golden-<name>`): cloned from base via `limactl clone` (APFS CoW, instant). Runs project's `build.sh` for project-specific setup.

### Image Assets

Each image defines its build script in `~/.config/tangerine/images/<name>/`:

```
~/.config/tangerine/images/
  wordpress-dev/
    build.sh              # project-specific setup script
```

### Image Build

```bash
tangerine image build-base     # Build base VM (once, slow)
tangerine image build           # Build project golden image (fast, from base clone)
```

API endpoints also available: `POST /api/images/build-base`, `POST /api/images/build`.

## Project Setup Flow

When a task starts:

```
1. Get or create persistent VM for the project (ProjectVmManager)
2. Clone repo to /workspace/repo (or git fetch if already there)
3. Create git worktree: /workspace/worktrees/<task-prefix>
4. Run project.setup commands in worktree
5. Start agent (OpenCode or Claude Code) in worktree
6. Establish SSH tunnels (OpenCode) or pipe stdin/stdout (Claude Code)
7. Session ready for chat
```

## Multiple Projects

Config supports multiple projects in the `projects` array. Each project gets its own persistent VM. Dashboard shows project context.
