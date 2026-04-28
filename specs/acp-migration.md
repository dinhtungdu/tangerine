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

ACP does not define a separate queued-message protocol; ACP clients such as Zed queue/edit pending user prompts in the UI while one `session/prompt` turn is active, then send the next prompt after the active turn finishes. Tangerine mirrors that behavior in its server queue and dashboard.

ACP does not provide an official embeddable chat UI. Tangerine keeps its web dashboard and maps ACP streams into existing task logs, activity logs, queued prompt state, and WebSocket messages. Third-party ACP clients exist, but replacing Tangerine's UI with one would lose Tangerine-specific task/worktree/PR workflows.

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
- queued prompt drain after idle turns
- cancellation
- session config option updates
- permission policy
- filesystem read/write callbacks scoped to the task worktree
- event mapping

## Configuration

Replace hardcoded provider IDs with configured ACP agents:

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

Existing `provider` task column can remain during migration as the selected ACP agent id. UI labels should call it `agent`/`harness` only after schema/API migration is complete. These command entries are external ACP adapter examples, not built-in legacy provider runtimes.

## Model and Reasoning Selection

Do not hardcode model lists per provider.

Use ACP session config options:

- category `model` -> Tangerine model selector
- category `thought_level` or `effort` -> Tangerine reasoning selector
- category `mode` -> optional mode selector

On session creation/resume, store the returned `configOptions`. On model/reasoning change, call `session/set_config_option`. If an agent lacks config options, hide or disable those controls.

## Permissions

Tangerine background tasks need unattended execution. Current permission policy:

- `taskTypes.{type}.permissionMode` defaults to `skipPermissions`
- `skipPermissions` applies a matching ACP mode option at session start when exposed, such as Claude `bypassPermissions` or Codex `full-access`
- legacy `taskTypes.{type}.autoApprove` is rejected so configs do not silently change behavior on upgrade
- auto-select first `allow_once` or `allow_always` option
- fallback to first option if no allow option exists
- log permission decisions to the activity log

No interactive permission prompt is planned for unattended v0 tasks. Add dashboard approval UI only with a future foreground/manual task mode so background workers never block invisibly.

## Streaming and Logs

Map ACP updates to Tangerine events:

| ACP update | Tangerine event |
|------------|-----------------|
| `agent_message_chunk` text | `message.streaming`, buffered to assistant complete on prompt result |
| `agent_thought_chunk` text | `thinking` |
| `user_message_chunk` text | `message.complete` role `user` |
| `tool_call` | `tool.start` |
| `tool_call_update` completed/failed | `tool.end` |
| `tool_call_update` content `diff` / `terminal` | native `content.block` diff/terminal card |
| `plan` | native plan card plus compatibility `thinking` text |
| non-text content block | native `content.block` card |
| `session_info_update` | `session.info` metadata + activity log |
| `config_option_update` | `config.options` state/UI update |
| `usage_update` | `usage.contextTokens/contextWindowMax` |
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
- Add remote ACP transport and registry install/discovery when stable.

## Verification

- mock ACP agent tests cover initialize, new session, resume fallback, prompt streaming, tool calls, permission requests, config option changes, close/cancel, and subprocess cleanup
- server tests cover task create/start/reconnect with ACP-only runtime
- web tests cover agent selector and hiding model/reasoning controls when unsupported
- `bun run check`
