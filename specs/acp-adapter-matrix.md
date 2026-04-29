# ACP Adapter Matrix

Tangerine treats adapters as the source of provider-specific behavior. The Tangerine runtime should stay generic ACP client code: no `if agent === "claude"` branches.

Use the built-in probe to inspect configured adapters on a machine:

```bash
tangerine acp probe
tangerine acp probe --agent claude --json
tangerine acp probe --agent pi --prompt "Say hi" --json
```

Default probe behavior only runs `initialize` and `session/new`. Add `--prompt` when stream shape needs verification.

## Client responsibilities

Adapters normalize provider-specific SDK events into ACP. Tangerine still owns ACP-client responsibilities:

- merge prompt-active `agent_message_chunk` with stable `messageId` into one live assistant message; stream no-`messageId` prose as narration and split it at sentence boundaries when possible; ignore assistant chunks outside an active prompt turn
- split `agent_thought_chunk` into ordered Thought cards when `messageId` changes, visible events interleave, or no-`messageId` sentence-boundary prose indicates a new thought segment
- persist only final assistant/thinking messages after `session/prompt` completes while keeping in-memory active stream snapshots for task-switch reloads
- render non-text content blocks; do not render text chunks as generic content cards
- merge `tool_call_update` entries into the matching tool activity by `toolCallId`, including streamed/replaced result text from `content` or `rawOutput`
- map `models` / `modes` compatibility fields into selectors
- map config option categories `thought_level` and `effort` to the reasoning-effort selector
- map legacy `modes` to `thought_level` when the advertised values are semantic thinking/reasoning levels
- call `session/set_model` / `session/set_mode` for those compatibility selectors
- call `session/set_config_option` for real `configOptions`
- choose unattended permission options for background tasks

## Source observations

Observed from installed/open adapter packages on 2026-04-28.

| Adapter | Source | Session config shape | Stream shape | Notes |
|---|---|---|---|---|
| Claude Agent ACP `@agentclientprotocol/claude-agent-acp@0.31.1` | ACP registry metadata + package source + Zed screenshot | `configOptions` for `mode`, `model`, and model-dependent `effort` | `text`/`text_delta` -> `agent_message_chunk`; `thinking`/`thinking_delta` -> `agent_thought_chunk` | `session/set_config_option` with `configId: "effort"` calls SDK `applyFlagSettings({ effortLevel })`; effort options depend on selected model and can include `low`, `medium`, `high`, `xhigh`. |
| Codex ACP `@zed-industries/codex-acp@0.12.0` | Rust binary package + README + local probe | `configOptions` for `mode`, `model`, `thought_level`; also reports legacy `models` + `modes` | prompt probe on target machine required | supports `session/close`; package advertises images, tool calls, permission requests, following, edit review, TODOs, slash commands, MCP |
| OpenCode `opencode acp` from `opencode-ai@1.14.28` | native command package + local probe | `configOptions` for `model`, `mode`; also reports legacy `models` + `modes` | prompt probe on target machine required | native ACP command, not Tangerine-owned runtime; local probe saw `available_commands_update` on session start |
| Pi ACP `pi-acp@0.0.26` | JavaScript bundle source + local probe | legacy `models` + `modes`; modes are semantically thinking levels, so Tangerine exposes them as `thought_level` while still writing with `session/set_mode` | Pi `text_delta` -> `agent_message_chunk`; Pi `thinking_delta` -> `agent_thought_chunk` | `session/set_model`, `session/set_mode`; thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`; local probe emits startup info as `agent_message_chunk` |

## Compatibility rules

- If `configOptions` exist, expose those directly and write with `session/set_config_option`.
- Treat config option category `"effort"` as reasoning effort like `"thought_level"`, but keep original ID/category for writes.
- If legacy `models` exist, synthesize a `category: "model"` option and write with `session/set_model`.
- If legacy `modes` exist and values are session behavior modes, synthesize `category: "mode"` and write with `session/set_mode`.
- If legacy `modes` exist and all values are semantic thinking/reasoning levels, synthesize `category: "thought_level"` and write with `session/set_mode`.
- If text chunks have no `messageId`, Tangerine creates one active assistant/thought stream id per turn.
- If an assistant text chunk changes non-null `messageId`, Tangerine flushes the previous assistant message and starts a new one.
- Within one assistant message, if a multi-word prose text chunk starts after sentence-ending punctuation with no adapter whitespace, Tangerine inserts a `\n\n` paragraph separator.
- If an adapter replays or delays assistant text chunks outside the active prompt turn, Tangerine drops them instead of carrying them into the next completion.
- If `type: "text"` content has empty/missing text, ignore it; it is not a content block card.
- Treat repeated `tool_call_update.content` as replacement/progress state; ACP does not define a separate `tool_result_delta` event.
- If `tool_call_update` arrives without a prior `tool_call`, create a best-effort tool activity keyed by `toolCallId`.
- If the matching `tool_call` arrives later, merge it into that activity and reclassify the activity event/type when the tool name becomes known.
- Preserve the activity row timestamp as tool start time; track real progress freshness (new input/output, not status-only heartbeats) in metadata so replayed chat chronology stays stable.
- If an adapter emits invalid ACP, fix upstream or document a generic tolerance only when multiple adapters need it.

## Tangerine vs Zed

Zed is an editor UI and ACP client. Its adapters are often authored beside its client, so Zed can tune UI and adapter behavior together.

Tangerine is a local server plus web dashboard. Data flows through adapter stdio -> Tangerine ACP mapper -> DB/session logs -> WebSocket -> React UI. Therefore Tangerine must implement stream merging, persistence, permission policy, and dashboard rendering even when adapters correctly emit ACP.
