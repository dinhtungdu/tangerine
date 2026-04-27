# TODOs: ACP-only agent integration

## Active backlog

- [x] ACP config options → backend state + API/WS + model/reasoning/mode UI.
- [x] Legacy provider deletion → removed hardcoded provider runtime, tests, deps.
- [x] Native ACP plan/content-block UI → plan cards, generic content cards, and diff/terminal-specific blocks.
- [x] Web verification → `cd web && bun test` + browser-test changed chat/task pages.

## Spec / planning

- [x] Read ACP docs: intro, overview, transports, initialization, session setup, prompt turn, content, tool calls, config options.
- [x] Update `specs/agent.md` to ACP-only target.
- [x] Update `specs/architecture.md` to ACP runtime target.
- [x] Add `specs/acp-migration.md` plan.
- [x] Update `specs/api.md` after API shape changes.
- [x] Update `specs/web.md` after dashboard/chat changes.
- [x] Update `specs/tasks.md` after task lifecycle changes.

## ACP runtime

- [x] Add ACP client wrapper over stdio JSON-RPC.
- [x] Add mock ACP stdio agent test harness.
- [x] Cover `initialize` negotiation.
- [x] Cover `session/new`.
- [x] Cover `session/resume` support path.
- [x] Cover `session/load` fallback path.
- [x] Cover fresh-session fallback when resume/load unsupported.
- [x] Cover `session/prompt` streaming.
- [x] Cover `session/cancel`.
- [x] Cover `session/close` when supported.
- [x] Cover subprocess cleanup / process-tree kill.
- [x] Persist `agent_session_id` from ACP `sessionId`.
- [x] Persist agent pid.

## ACP event mapping

- [x] Map `agent_message_chunk` to current streaming UI event.
- [x] Buffer streamed assistant text and persist final assistant log on prompt response.
- [x] Map `agent_thought_chunk` to thinking log/event.
- [x] Map `user_message_chunk` for history/load replay.
- [x] Map `tool_call` to tool/activity start.
- [x] Map `tool_call_update` to tool/activity update/end.
- [x] Map `plan` to current narration/thinking first.
- [x] Add native plan card later.
- [x] Map `usage_update` to context token usage.
- [x] Map prompt response `usage` to input/output/context token persistence.
- [x] Map `config_option_update` to session option state.
- [x] Map `session_info_update` to task/session metadata where useful.

## Permissions

- [x] Implement unattended permission policy: prefer first allow option.
- [x] Fallback to first option when no allow option exists.
- [x] Log permission requests and selected option to activity log.
- [x] Decide later if dashboard needs interactive permission UI → no interactive UI for unattended v0; keep auto policy + activity log, revisit with foreground/manual mode.

## Config migration

- [x] Add config schema `agents[]`.
- [x] Add config schema `defaultAgent`.
- [x] Keep legacy `defaultProvider` read path during migration.
- [x] Reject old provider IDs unless explicitly configured as ACP agent IDs.
- [x] Update project config docs.
- [ ] Update CLI `project add/show/list` if config output changes.

## Provider deletion

- [x] Replace `ProviderType` hardcoded union with configured agent id string or `AgentId`.
- [x] Remove `SUPPORTED_PROVIDERS` hardcoded list from runtime paths.
- [x] Delete legacy provider fallback; only configured ACP agent IDs or `acp` are valid.
- [x] Remove legacy runtime files.
- [x] Remove provider-specific tests and model discovery tests.
- [x] Remove provider-specific dependencies.
- [x] Remove provider-specific model discovery.
- [x] Remove provider-specific skill install assumptions; install skills to ACP skills dir.
- [x] Update tests so legacy provider IDs are negative assertions, not canonical providers.

## Model / reasoning / mode

- [x] Add shared `AgentConfigOption` / value types.
- [x] Add `AgentEvent` for ACP config option state.
- [x] Capture `configOptions` from `session/new`, `session/resume`, `session/load` responses.
- [x] Map ACP `config_option_update` to session option state.
- [x] Store active task/session config options in memory first.
- [x] Expose task config options through API or WebSocket.
- [x] Implement `session/set_config_option` in ACP provider `updateConfig`.
- [x] Use option category `model` for model selector.
- [x] Use option category `thought_level` for reasoning selector.
- [x] Use option category `mode` for mode selector when needed.
- [x] Hide selector when agent does not provide matching config option.
- [x] Update task DB `model` / `reasoning_effort` from ACP option state where category matches.
- [x] Update tests for selector visibility and option updates.

## Dashboard chat

- [x] Keep current dashboard; do not embed external ACP UI.
- [x] Audit chat assumptions tied to old normalized provider events.
- [x] Ensure streaming text still renders live.
- [x] Ensure final assistant messages persist without duplicate chunks.
- [x] Render ACP tool status transitions cleanly.
- [x] Render ACP plan updates as basic text first.
- [x] Add native plan card component.
- [x] Add native plan WebSocket/API payload shape.
- [x] Add content-block renderer for ACP text/image first.
- [x] Add content-block renderer for `resource_link`, `resource`, diff, terminal.
- [x] Verify mobile/task detail still works.

## API / WebSocket

- [x] Keep existing WebSocket event contract during first migration.
- [x] Add API shape for configured agents.
- [x] Add API shape for session config options.
- [x] Remove provider metadata/model discovery API; use agents + ACP config options.
- [x] Update API route tests.

## Tests / verification

- [x] `cd packages/server && bun test`.
- [x] `cd web && bun test`.
- [x] `bun run build`.
- [x] `bun run check`.
- [x] Add/adjust server tests for ACP config option events + `session/set_config_option`.
- [x] Add/adjust web component tests for ACP selectors.
- [x] Add/adjust web component tests for plan/content UI.
- [x] Browser-test affected chat/task pages after UI changes.
