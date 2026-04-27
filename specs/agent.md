# Agent Integration

Tangerine's target agent integration is ACP-only. Tangerine is the ACP client; coding agents are external ACP-compatible commands reached over stdio.

Legacy provider-specific implementations have been removed. See [ACP Migration](./acp-migration.md) for current migration status.

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
- apply session configuration via `session/set_config_option`
- expose session id and process pid for task persistence and cleanup

## Configured ACP Agents

Provider identity has become configured ACP agent identity. The compatibility `tasks.provider` column stores the selected ACP agent id until a future schema rename.

Config shape:

```json
{
  "defaultAgent": "acp",
  "agents": [
    { "id": "acp", "name": "ACP Agent", "command": "acp-agent", "args": [], "env": {} }
  ]
}
```

No hardcoded provider list should remain after the migration.

## Streaming

ACP provides streaming via `session/update`, not a chat UI. Tangerine keeps its dashboard and maps ACP updates into its existing WebSocket/session log format.

Important ACP updates:

| ACP update | Tangerine event |
|------------|-----------------|
| `agent_message_chunk` | `message.streaming`, then final assistant message on prompt completion |
| `agent_thought_chunk` | `thinking` |
| `user_message_chunk` | user message log |
| `tool_call` | `tool.start` |
| `tool_call_update` | `tool.end` on completed/failed |
| `tool_call_update` content `diff` / `terminal` | native diff/terminal content-block card |
| `plan` | native plan card plus thinking text for compatibility |
| `config_option_update` | refresh model/reasoning/mode options |
| `usage_update` | context token usage |
| non-text content block | generic ACP content-block card |

## Model, Reasoning, and Modes

Tangerine must stop discovering models via provider-specific APIs.

Use ACP session config options:

- `category: "model"` for model selection
- `category: "thought_level"` for reasoning selection
- `category: "mode"` for agent mode selection

If an agent does not return relevant config options, hide or disable that selector.

## Permissions

Initial unattended policy:

1. choose first `allow_once` / `allow_always` option
2. otherwise choose first provided option
3. record request and selected option in activity logs

Do not show interactive permission prompts for unattended v0 tasks. Future foreground/manual task modes may add dashboard approval UI.

## Client Capabilities

First pass should advertise minimal capabilities unless needed by a chosen agent:

- filesystem callbacks: optional
- terminal callbacks: optional
- image prompts: only send images when agent advertises image support

Tangerine can add filesystem/terminal callbacks later without changing the core agent model.

## Event Flow

ACP events fan out to the existing Tangerine surfaces:

- WebSocket task streams
- `session_logs`
- `activity_log`
- task working-state updates
- token/context usage persistence

The dashboard is a Tangerine task UI powered by ACP streams, not an embedded ACP UI.
