---
description: Orient yourself within Tangerine — get your task ID, API base URL, and available endpoints
---
Read sibling `SKILL.md` for full API reference. Skill install locations depend on the configured real agent (for example `~/.pi/agent/skills/tangerine-tasks/SKILL.md`, `~/.claude/skills/tangerine-tasks/SKILL.md`, `~/.codex/skills/tangerine-tasks/SKILL.md`, or `~/.config/opencode/skills/tangerine-tasks/SKILL.md`).

**You are running inside a Tangerine task.**

1. Get your task ID: `echo $TANGERINE_TASK_ID`
2. API base: `API=http://localhost:${TANGERINE_PORT:-3456}` (port can be customized via `TANGERINE_PORT` or config `port`; task prompt may show actual URL)
3. Check auth: `curl -s $API/api/auth/session | jq '{enabled, authenticated}'`; if `enabled=true`, require non-empty `$TANGERINE_AUTH_TOKEN` and add `-H "Authorization: Bearer $TANGERINE_AUTH_TOKEN"` to private API calls
4. Get your task: `curl -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" $API/api/tasks/$TANGERINE_TASK_ID` (header ignored when auth disabled)
5. Create a sub-task: `POST /api/tasks` with `{ projectId, title, description, source: "cross-project" }` (omit `provider` to use project/default configured agent; set `provider` only to a real configured agent ID)
6. Start from existing branch or PR: add `"branch": "feature/foo"` or `"branch": "#123"` to the create payload
7. Continue a previous task: add `"parentTaskId": "<task-id>"` to the create payload
8. Send a message to another task: `POST /api/tasks/<id>/prompt` with `{"text": "..."}`

$ARGUMENTS
