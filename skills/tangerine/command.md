---
description: Orient yourself within Tangerine — get your task ID, API base URL, and available endpoints
---
Read ~/.claude/skills/tangerine/SKILL.md for full API reference.

**You are running inside a Tangerine task.**

1. Get your task ID: `echo $TANGERINE_TASK_ID`
2. API is at `http://localhost:3456`
3. Get your task: `curl http://localhost:3456/api/tasks/$TANGERINE_TASK_ID`
4. Create a sub-task: `POST http://localhost:3456/api/tasks` with `{ projectId, title, description, source: "cross-project" }`
5. Start from existing branch or PR: add `"branch": "feature/foo"` or `"branch": "#123"` to the create payload

$ARGUMENTS
