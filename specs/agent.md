# Agent Integration

Tangerine's target agent integration is ACP-only. Tangerine is the ACP client; coding agents are external ACP-compatible commands reached over stdio.

Legacy provider-specific implementations have been removed. See [ACP Migration](./acp-migration.md) for current migration status and [ACP Adapter Matrix](./acp-adapter-matrix.md) for observed adapter behavior/probe workflow.

## ACP Runtime

Implementation target: `agent/acp-provider.ts` (or equivalent thin ACP client wrapper).

Responsibilities:

- spawn the configured ACP agent command as a local subprocess
- speak JSON-RPC over newline-delimited stdio
- call `initialize` with ACP protocol version 1
- create sessions with `session/new`
- reconnect with `session/resume` when supported, then `session/load` when supported, otherwise create a fresh session and let Tangerine re-send the initial prompt when needed
- send prompts with `session/prompt`
- cancel active work with `session/cancel`
- close sessions with `session/close` when supported
- handle `session/request_permission`
- advertise and serve ACP filesystem callbacks `fs/read_text_file` and `fs/write_text_file`, restricted to the task worktree
- apply session configuration via `session/set_config_option`, or compatibility `session/set_model` / `session/set_mode` for ACP agents that expose legacy model/mode state
- expose session id and process pid for task persistence and cleanup

## Configured ACP Agents

Provider identity has become configured ACP agent identity. The compatibility `tasks.provider` column stores the selected ACP agent id until a future schema rename.

Config shape:

```json
{
  "defaultAgent": "claude",
  "agents": [
    { "id": "claude", "name": "Claude Agent", "command": "bunx", "args": ["--bun", "@agentclientprotocol/claude-agent-acp"] },
    { "id": "codex", "name": "Codex", "command": "bunx", "args": ["--bun", "@zed-industries/codex-acp"] },
    { "id": "opencode", "name": "OpenCode", "command": "bunx", "args": ["--bun", "opencode-ai", "acp"] },
    { "id": "pi", "name": "Pi", "command": "bunx", "args": ["--bun", "pi-acp"] }
  ]
}
```

Known commands:

| Agent | ACP command source |
|-------|--------------------|
| Claude Agent | ACP registry adapter `@agentclientprotocol/claude-agent-acp` (`claude-agent-acp`) |
| Codex | Zed adapter `@zed-industries/codex-acp` (`codex-acp`) |
| OpenCode | native ACP command `opencode acp` from `opencode-ai` |
| Pi | `pi-acp` adapter |

No hardcoded provider list should remain after the migration. These are documented setup examples only; users can configure any ACP-compatible command.

Projects can override the default ACP agent per task type. Orchestrators use `taskTypes.orchestrator.agent` when no explicit agent is supplied, then fall back to project/global `defaultAgent` resolution. The same task-type config may provide initial `model` and `reasoningEffort` hints without coupling Tangerine to a provider-specific model name.

## Streaming

ACP provides streaming via `session/update`, not a chat UI. Tangerine keeps its dashboard and maps ACP updates into its existing WebSocket/session log format.

Important ACP updates:

| ACP update | Tangerine event |
|------------|-----------------|
| `agent_message_chunk` | `message.streaming`, then final assistant message on prompt completion |
| `agent_thought_chunk` | `thinking.streaming`, then one persisted `thinking` message on prompt completion |
| `user_message_chunk` | user message log |
| `tool_call` | `tool.start` keyed by `toolCallId`; merges into an existing best-effort row if updates arrived first |
| `tool_call_update` before completion | `tool.update` keyed by `toolCallId`; updates live activity metadata/result text and creates a tool activity if no `tool_call` arrived first |
| `tool_call_update` completed/failed | `tool.end` keyed by `toolCallId`; final raw output/result text stored on the tool activity |
| `tool_call_update` content `diff` / `terminal` | native diff/terminal content-block card |
| `plan` | native plan card plus thinking text for compatibility |
| `current_mode_update` | refresh synthetic mode config option |
| `config_option_update` | refresh model/reasoning/mode options |
| `usage_update` | context token usage |
| non-text content block | generic ACP content-block card |

## Model, Reasoning, and Modes

Tangerine must stop discovering models via provider-specific APIs. Learn adapter behavior from source and `tangerine acp probe`, then encode generic ACP compatibility rules.

Prefer ACP session config options:

- `category: "model"` for model selection
- `category: "thought_level"` or `category: "effort"` for reasoning selection
- `category: "mode"` for agent mode selection

Compatibility: several public ACP adapters still return legacy `models` / `modes` session state instead of `configOptions`. Tangerine normalizes those into the same selector model and writes changes with `session/set_model` / `session/set_mode`. Legacy `modes` become `category: "thought_level"` only when the advertised values are semantic thinking/reasoning levels; otherwise they remain `category: "mode"`. Some adapters expose model effort as extension category `"effort"`; Tangerine treats it as the reasoning selector while preserving the original config option ID/category for `session/set_config_option` writes.

If an agent does not return relevant config options or legacy state, hide or disable that selector.

## Permissions

Initial unattended policy:

1. choose first `allow_once` / `allow_always` option
2. otherwise choose first provided option
3. record request and selected option in activity logs

Do not show interactive permission prompts for unattended v0 tasks. Future foreground/manual task modes may add dashboard approval UI.

## Client Capabilities

Current client capabilities:

- filesystem callbacks: `fs.readTextFile` and `fs.writeTextFile` are advertised and sandboxed to the task worktree
- terminal callbacks: not advertised
- image prompts: only send images when agent advertises image support

Filesystem callbacks let ACP adapters request editor-style reads/writes through the client, matching ACP client behavior without giving dashboard access outside the session worktree.

## Event Flow

ACP events fan out to the existing Tangerine surfaces:

- WebSocket task streams
- `session_logs`
- `activity_log`
- task working-state updates
- queued prompt updates for messages waiting on the active turn
- token/context usage persistence

The dashboard is a Tangerine task UI powered by ACP streams, not an embedded ACP UI.
