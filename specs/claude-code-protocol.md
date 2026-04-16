# Claude Code CLI — stream-json Wire Format

CLI version: **2.1.79** | Captured: 2026-03-19

## Invocation

```bash
# Text input, stream-json output (simpler)
echo "prompt" | claude -p --output-format stream-json --max-turns N

# JSON input + output (bidirectional)
echo '{"type":"user","message":{"role":"user","content":"prompt"}}' \
  | claude -p --output-format stream-json --input-format stream-json --max-turns N

# With token-level streaming (adds stream_event lines)
echo "prompt" | claude -p --output-format stream-json --include-partial-messages --max-turns N
```

### Key flags

| Flag | Purpose |
|------|---------|
| `--output-format stream-json` | NDJSON on stdout (one JSON object per line) |
| `--input-format stream-json` | Accept JSON messages on stdin |
| `--include-partial-messages` | Emit `stream_event` lines with Anthropic SSE deltas |
| `--replay-user-messages` | Echo user messages back on stdout (adds `isReplay: true`) |
| `--session-id <uuid>` | Use explicit session UUID |
| `--resume <session-id>` | Resume existing session (loads history) |
| `--continue` | Resume most recent session in cwd |
| `--fork-session` | When resuming, create new ID (keeps history) |
| `--no-session-persistence` | Don't save session to disk |
| `--max-turns N` | Limit agentic turns |
| `--max-budget-usd N` | Spending cap |
| `--dangerously-skip-permissions` | Auto-approve tool use |
| `--permission-mode <mode>` | `default`, `bypassPermissions`, `acceptEdits`, `plan`, `auto` |
| `--allowedTools <tools>` | Whitelist tools (e.g. `"Read Bash(git:*)"`) |
| `--model <model>` | Model override |
| `--system-prompt <prompt>` | Replace system prompt |
| `--append-system-prompt <prompt>` | Append to default system prompt |

## Stdin Schema (input-format: stream-json)

### User message

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": "your prompt here"
  }
}
```

One JSON object per line. Close stdin (EOF) to signal no more input.

## Stdout Event Types

All events are NDJSON (one JSON object per line). Every event has `"type"` as discriminator.

### 1. `system` (subtype: `init`)

First event, always. Contains session metadata.

```json
{
  "type": "system",
  "subtype": "init",
  "session_id": "b5c37d65-1d70-44b3-a350-d9df9ddea7b9",
  "cwd": "/Users/tung/workspace/tangerine",
  "model": "claude-opus-4-6[1m]",
  "permissionMode": "default",
  "claude_code_version": "2.1.79",
  "apiKeySource": "none",
  "output_style": "default",
  "fast_mode_state": "off",
  "tools": ["Bash", "Read", "Edit", "Write", "Grep", "Glob", ...],
  "mcp_servers": [
    {"name": "pencil", "status": "connected"},
    {"name": "claude.ai Gmail", "status": "needs-auth"}
  ],
  "slash_commands": ["compact", "review", ...],
  "agents": ["general-purpose", "Plan", ...],
  "skills": ["simplify", "batch", ...],
  "plugins": [
    {"name": "code-review", "path": "/Users/..."}
  ],
  "uuid": "95b3339b-dad6-4684-b5e6-e464a6679335"
}
```

**Key fields:**
- `session_id` — UUID, stable for the session. Same ID returned if you pass `--session-id`.
- `tools` — available tool names (built-in + MCP)
- `mcp_servers` — status: `"connected"` | `"pending"` | `"needs-auth"`
- `uuid` — unique ID for this specific event

### 2. `assistant`

Complete assistant message (after full turn). Emitted once per API call.

```json
{
  "type": "assistant",
  "session_id": "b5c37d65-...",
  "parent_tool_use_id": null,
  "uuid": "16a40454-...",
  "message": {
    "model": "claude-opus-4-6",
    "id": "msg_01QWiBF6FCPu5UjrfDZsFZg4",
    "type": "message",
    "role": "assistant",
    "content": [
      {"type": "text", "text": "Hello."}
    ],
    "stop_reason": null,
    "stop_sequence": null,
    "usage": {
      "input_tokens": 3,
      "output_tokens": 1,
      "cache_creation_input_tokens": 24186,
      "cache_read_input_tokens": 0,
      "cache_creation": {
        "ephemeral_5m_input_tokens": 0,
        "ephemeral_1h_input_tokens": 24186
      },
      "service_tier": "standard"
    },
    "context_management": null
  }
}
```

**Content block types observed:**

Text:
```json
{"type": "text", "text": "Hello."}
```

Tool use:
```json
{
  "type": "tool_use",
  "id": "toolu_01VYsHkxxPMgyKppci6Kn4HH",
  "name": "Read",
  "input": {"file_path": "/Users/tung/workspace/tangerine/package.json"},
  "caller": {"type": "direct"}
}
```

**Notes:**
- `stop_reason` is always `null` in `assistant` events (final stop reason is in `result`)
- `parent_tool_use_id` is `null` for top-level turns, non-null for sub-agent responses
- `message.id` is the Anthropic API message ID (`msg_...`)

### 3. `user` (tool results)

Emitted when a tool completes. Shows the tool result being fed back to the model.

```json
{
  "type": "user",
  "session_id": "4ab3d9ba-...",
  "parent_tool_use_id": null,
  "uuid": "c2ee3c06-...",
  "timestamp": "2026-03-19T08:23:00.565Z",
  "message": {
    "role": "user",
    "content": [
      {
        "tool_use_id": "toolu_01VYsHkxxPMgyKppci6Kn4HH",
        "type": "tool_result",
        "content": "     1\u2192{\n     2\u2192  \"name\": \"tangerine\"..."
      }
    ]
  },
  "tool_use_result": {
    "type": "text",
    "file": {
      "filePath": "/Users/tung/workspace/tangerine/package.json",
      "content": "{\n  \"name\": \"tangerine\"...",
      "numLines": 24,
      "startLine": 1,
      "totalLines": 24
    }
  }
}
```

**Notes:**
- `message.content` is array of `tool_result` blocks (Anthropic API format)
- `tool_use_result` is a Claude Code enrichment with structured metadata (file info, etc.)
- With `--replay-user-messages`, user input messages are also emitted with `"isReplay": true`

### 4. `rate_limit_event`

Emitted after each API call as informational telemetry. Per `SDKRateLimitInfo`
in `@anthropic-ai/claude-agent-sdk`, `rate_limit_info.status` is one of:

- `"allowed"` — request succeeded, plenty of capacity. **Ignore.**
- `"allowed_warning"` — request succeeded but approaching the limit. **Ignore.**
- `"rejected"` — request was actually rate limited. Surface as an error.

Only `"rejected"` is a real rate limit. Treating every `rate_limit_event` as
fatal will fail healthy tasks (the SDK emits this after every successful call).
Retry timing should be derived from `resetsAt` (unix seconds), not a
non-existent `retry_after` field.

```json
{
  "type": "rate_limit_event",
  "session_id": "b5c37d65-...",
  "uuid": "10d051d7-...",
  "rate_limit_info": {
    "status": "allowed",
    "resetsAt": 1773910800,
    "rateLimitType": "five_hour",
    "overageStatus": "rejected",
    "overageDisabledReason": "org_level_disabled",
    "isUsingOverage": false
  }
}
```

### 5. `result`

Final event, always last. Contains aggregated stats.

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "session_id": "b5c37d65-...",
  "uuid": "d600f29f-...",
  "result": "Hello.",
  "stop_reason": "end_turn",
  "duration_ms": 8274,
  "duration_api_ms": 8225,
  "num_turns": 1,
  "total_cost_usd": 0.1513025,
  "fast_mode_state": "off",
  "permission_denials": [],
  "usage": {
    "input_tokens": 3,
    "cache_creation_input_tokens": 24186,
    "cache_read_input_tokens": 0,
    "output_tokens": 5,
    "server_tool_use": {
      "web_search_requests": 0,
      "web_fetch_requests": 0
    },
    "service_tier": "standard",
    "iterations": [],
    "speed": "standard"
  },
  "modelUsage": {
    "claude-opus-4-6[1m]": {
      "inputTokens": 3,
      "outputTokens": 5,
      "cacheReadInputTokens": 0,
      "cacheCreationInputTokens": 24186,
      "webSearchRequests": 0,
      "costUSD": 0.1513025,
      "contextWindow": 1000000,
      "maxOutputTokens": 64000
    }
  }
}
```

**`stop_reason` values:** `"end_turn"` (normal), `"max_turns"` (hit limit)

**`subtype` values:** `"success"`, `"error"`

### 6. `stream_event` (only with `--include-partial-messages`)

Token-level streaming. Wraps Anthropic SSE events.

```json
{"type": "stream_event", "session_id": "...", "parent_tool_use_id": null, "uuid": "...",
 "event": {"type": "message_start", "message": {"model": "claude-opus-4-6", "id": "msg_...", ...}}}

{"type": "stream_event", ...,
 "event": {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}}

{"type": "stream_event", ...,
 "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Hello"}}}

{"type": "stream_event", ...,
 "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "."}}}

{"type": "stream_event", ...,
 "event": {"type": "content_block_stop", "index": 0}}

{"type": "stream_event", ...,
 "event": {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {...},
           "context_management": {"applied_edits": []}}}

{"type": "stream_event", ...,
 "event": {"type": "message_stop"}}
```

**Event sequence:** `message_start` -> `content_block_start` -> N x `content_block_delta` -> `content_block_stop` -> `message_delta` -> `message_stop`

For tool use blocks, deltas have `{"type": "input_json_delta", "partial_json": "..."}`.

## Event Order

### Simple text response
```
system (init)
assistant        # complete message
rate_limit_event
result (success)
```

### With --include-partial-messages
```
system (init)
stream_event (message_start)
stream_event (content_block_start)
stream_event (content_block_delta) x N
assistant        # complete message (between block events)
stream_event (content_block_stop)
stream_event (message_delta)
stream_event (message_stop)
rate_limit_event
result (success)
```

### Tool use (multi-turn)
```
system (init)
assistant        # tool_use content block
rate_limit_event
user             # tool_result
assistant        # text response
result (success)
```

## Session Management

- `--session-id <uuid>` — use explicit UUID, session persisted to disk
- `--resume <session-id>` — reload session history, continue conversation
- `--continue` — resume most recent session in cwd
- `--fork-session` — with `--resume`, creates new session ID but keeps history
- `--no-session-persistence` — ephemeral, not saved to disk
- Session ID is a UUID v4, returned in every event's `session_id` field
- Same `session_id` is reused when resuming (unless `--fork-session`)

## UUID Fields

Every event has two ID fields:
- `session_id` — stable across the entire session
- `uuid` — unique per event (for deduplication/ordering)

## Error Handling

When the CLI fails, `result` has:
```json
{
  "type": "result",
  "subtype": "error",
  "is_error": true,
  "result": "error message",
  ...
}
```

## Permission Denials

When a tool is blocked by permissions, the `result` event includes:
```json
{
  "permission_denials": [
    // tool name + reason pairs
  ]
}
```

Use `--dangerously-skip-permissions` or `--permission-mode bypassPermissions` to auto-approve.
Use `--allowedTools "Read Bash(git:*)"` for granular whitelisting.
