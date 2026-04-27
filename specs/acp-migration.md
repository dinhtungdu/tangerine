# ACP Migration

Tangerine should use Agent Client Protocol (ACP) as its only agent integration surface.

## Goal

Remove provider-specific protocol maintenance from Tangerine. Tangerine becomes an ACP client that can run any ACP-compatible local agent command.

## Non-goals

- Do not maintain first-party Claude/Codex/OpenCode/Pi protocol adapters in Tangerine.
- Do not replace Tangerine's dashboard with an external chat UI.
- Do not implement draft remote ACP HTTP/WebSocket transport in the first pass; use stable stdio.
- Do not depend on ACP registry for runtime; registry install/discovery can come later.

## What ACP Provides

ACP provides a JSON-RPC protocol and streaming event model:

- `initialize` capability negotiation
- `session/new`, `session/resume`, `session/load`, `session/close`
- `session/prompt` prompt turns
- `session/update` streaming notifications for:
  - `agent_message_chunk`
  - `agent_thought_chunk`
  - `tool_call`
  - `tool_call_update`
  - `plan`
  - `config_option_update`
  - `session_info_update`
  - `usage_update`
- `session/request_permission` client callback
- optional client filesystem and terminal callbacks

ACP does not provide an official embeddable chat UI. Tangerine keeps its web dashboard and maps ACP streams into existing task logs, activity logs, and WebSocket messages. Third-party ACP clients exist, but replacing Tangerine's UI with one would lose Tangerine-specific task/worktree/PR orchestration.

## Target Architecture

```text
Tangerine task runtime
  -> ACP client wrapper
    -> ACP-compatible agent command over stdio
```

The custom provider runtimes have been removed. Tangerine no longer ships first-party protocol adapters, provider-specific parsers, SDK calls, approval code, or model discovery.

A single ACP runtime owns:

- spawning the configured ACP command
- ACP initialization
- session creation/resume/load/close
- prompt delivery
- cancellation
- session config option updates
- permission policy
- event mapping

## Configuration

Replace hardcoded provider IDs with configured ACP agents:

```json
{
  "defaultAgent": "acp",
  "agents": [
    {
      "id": "acp",
      "name": "ACP Agent",
      "command": "acp-agent",
      "args": [],
      "env": {}
    }
  ]
}
```

Existing `provider` task column can remain during migration as the selected ACP agent id. UI labels should call it `agent`/`harness` only after schema/API migration is complete.

## Model and Reasoning Selection

Do not hardcode model lists per provider.

Use ACP session config options:

- category `model` -> Tangerine model selector
- category `thought_level` -> Tangerine reasoning selector
- category `mode` -> optional mode selector

On session creation/resume, store the returned `configOptions`. On model/reasoning change, call `session/set_config_option`. If an agent lacks config options, hide or disable those controls.

## Permissions

Tangerine background tasks need unattended execution. Initial permission policy:

- auto-select first `allow_once` or `allow_always` option
- fallback to first option if no allow option exists
- log permission decisions to the activity log

Later UI can expose per-project permission policy.

## Streaming and Logs

Map ACP updates to Tangerine events:

| ACP update | Tangerine event |
|------------|-----------------|
| `agent_message_chunk` text | `message.streaming`, buffered to assistant complete on prompt result |
| `agent_thought_chunk` text | `thinking` |
| `user_message_chunk` text | `message.complete` role `user` |
| `tool_call` | `tool.start` |
| `tool_call_update` completed/failed | `tool.end` |
| `plan` | native plan card plus compatibility `thinking` text |
| non-text content block | native `content.block` card |
| `session_info_update` | `session.info` metadata + activity log |
| `config_option_update` | `config.options` state/UI update |
| `usage_update` | `usage.contextTokens` |
| prompt response usage | `usage.inputTokens/outputTokens/contextTokens` |

Keep current WebSocket and dashboard event format while migrating so UI changes stay small.

## Migration Status

Completed:

1. ACP stdio client wrapper with mock-agent tests.
2. Config schema for `agents` / `defaultAgent`; `defaultProvider` remains deprecated migration input only.
3. Task startup/reconnect routed through ACP wrapper only.
4. Provider/model/reasoning metadata APIs replaced by ACP agents and session config options.
5. Legacy provider files, tests, and dependencies removed.
6. ACP plan/content/config/session-info/permission events mapped into dashboard state and activity logs.
7. Install flow points skills at the ACP skills directory.

Remaining:

- Rename remaining DB/API compatibility field `provider` to `agent` in a future schema migration.
- Add richer ACP diff/terminal content block cards.
- Add remote ACP transport and registry install/discovery when stable.

## Verification

- mock ACP agent tests cover initialize, new session, resume fallback, prompt streaming, tool calls, permission requests, config option changes, close/cancel, and subprocess cleanup
- server tests cover task create/start/reconnect with ACP-only runtime
- web tests cover agent selector and hiding model/reasoning controls when unsupported
- `bun run check`
