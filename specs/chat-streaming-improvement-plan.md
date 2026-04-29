# Chat Streaming Improvement Plan

## Goal

Make Tangerine chat feel less like an append-only debug log and more like a readable agent timeline: clear turns, compact work narration, inspectable thinking, first-class tool state, and stable streaming without scroll/re-render noise.

## What was studied

- `pingdotgg/t3code`
  - `apps/web/src/components/chat/MessagesTimeline.tsx`
  - `apps/web/src/components/chat/MessagesTimeline.logic.ts`
  - `apps/web/src/session-logic.ts`
  - `apps/server/src/persistence/Layers/ProjectionThreadMessages.ts`
  - `packages/shared/src/toolActivity.ts`
- `zed-industries/zed`
  - `crates/agent/src/thread.rs`
  - `crates/agent_ui/src/conversation_view/thread_view.rs`
  - `crates/agent/src/tools/streaming_edit_file_tool.rs`
- Tangerine current implementation
  - `packages/server/src/agent/acp-provider.ts`
  - `packages/shared/src/types.ts`
  - `web/src/components/ChatPanel.tsx`
  - `web/src/components/AssistantMessageGroups.tsx`
  - `specs/web.md`

## Current Tangerine shape

Tangerine already has the hard backend pieces:

- ACP `session/update` mapping for assistant chunks, thought chunks, user chunks, tool calls, plans, content blocks, usage, config options, and slash commands.
- Persisted messages plus transient active stream snapshots on reload.
- Activity rows for tool lifecycle.
- Basic grouping in `AssistantMessageGroups` by merging messages and `tool.*` activities by timestamp.

Main gaps:

- Tool calls are stored/displayed as generic activity rows, not durable turn items.
- Thinking is a pseudo-message role, not a first-class block with lifecycle/visibility policy.
- Plan updates are duplicated as thinking text plus plan event.
- Timeline grouping is timestamp-driven, not turn/block-driven, so narration can feel jumpy.
- UI renders all transcript rows in a regular scroll container; long runs get heavy and noisy.
- Running-state text is generic: “Agent is working...” instead of saying what it is doing.

## Lessons from t3code

### 1. Use a derived timeline model

t3code separates raw session data from UI rows:

- `TimelineEntry = message | proposed-plan | work`
- `deriveTimelineEntries(...)`
- `deriveMessagesTimelineRows(...)`
- `computeStableMessagesTimelineRows(...)`

This keeps UI simple and lets product decisions live in pure, testable logic.

Tangerine should copy this pattern. Today `AssistantMessageGroups` does grouping inside the component.

### 2. Work log, not raw tool log

t3code derives `WorkLogEntry` with:

- `label`
- `detail`
- `command`
- `changedFiles`
- `tone: thinking | tool | info | error`
- `itemType`
- `requestKind`

Then consecutive work entries are grouped and capped (`MAX_VISIBLE_WORK_LOG_ENTRIES = 6`).

Tangerine should summarize low-value tool chatter by default and keep raw JSON behind expansion.

### 3. Stable rows for streaming

t3code preserves row object identity when shallow fields have not changed. This avoids re-rendering the entire chat on every token/tool update.

Tangerine should add stable timeline-row derivation before polishing animation/scroll behavior.

### 4. Persist projected messages

t3code persists projection messages with `isStreaming`, `turnId`, timestamps, attachments. That creates a durable UI-level transcript independent of raw provider events.

Tangerine has `session_logs` and `activity_log`; it should add a normalized `timeline_items` projection rather than forcing the web app to reconstruct from two streams forever.

## Lessons from Zed

### 1. Agent messages are structured content

Zed models assistant output as a sequence of content blocks:

- text
- thinking / redacted thinking
- tool use
- tool result
- plan entries

This is better than flattening into message text plus separate activity rows.

Tangerine should model one assistant turn as ordered blocks.

### 2. UI expansion state is per block

Zed tracks:

- expanded tool calls
- expanded raw tool inputs
- expanded thinking blocks
- discarded partial edits
- permission selection state

Tangerine should persist local UI expansion by block id/toolCallId, not global “expanded group”.

### 3. Streaming edits deserve special UI

Zed has a streaming edit tool path rather than treating edits as generic tool output. For coding agents, file edits are the main event.

Tangerine should promote file changes to a compact “Changed files” block with path/status/diff hooks, not hide them inside JSON.

### 4. Explicit following behavior

Zed tracks whether the user should be following the bottom. Tangerine has custom scroll logic but should formalize:

- if user is at bottom, follow streaming
- if user scrolls up, pause follow and show “Jump to latest”
- never yank scroll on tool spam

## Recommended model

Add a normalized turn timeline.

```ts
interface TimelineTurn {
  id: string
  taskId: string
  userMessageId?: string
  status: "running" | "completed" | "failed" | "cancelled"
  startedAt: string
  completedAt?: string
  blocks: TimelineBlock[]
}

type TimelineBlock =
  | TextBlock
  | ThinkingBlock
  | ToolBlock
  | PlanBlock
  | FileChangeBlock
  | PermissionBlock
  | UsageBlock
  | ErrorBlock

interface BaseBlock {
  id: string
  turnId: string
  order: number
  createdAt: string
  updatedAt: string
  streaming: boolean
}

interface TextBlock extends BaseBlock {
  kind: "text"
  role: "user" | "assistant" | "system"
  text: string
}

interface ThinkingBlock extends BaseBlock {
  kind: "thinking"
  text: string
  redacted?: boolean
}

interface ToolBlock extends BaseBlock {
  kind: "tool"
  toolCallId: string
  name: string
  status: "pending" | "running" | "success" | "error"
  summary: string
  detail?: string
  input?: unknown
  output?: unknown
}

interface FileChangeBlock extends BaseBlock {
  kind: "file_change"
  paths: Array<{ path: string; status: "created" | "modified" | "deleted" }>
}
```

Keep raw ACP/session logs as audit trail. Use timeline blocks as the read model for chat UI.

## Product behavior

### Default collapsed view

For each turn:

1. User prompt.
2. Compact live work strip, e.g. “Thinking · Read 4 files · Edited 2 files · Ran tests”.
3. Assistant answer.
4. Completion footer: duration, tokens, changed files, errors.

### Expanded view

Expansion shows ordered blocks:

- thinking text
- tool input/output
- terminal output
- plan steps
- file changes

Default expansion policy:

- latest running tool: expanded enough to show useful detail
- thinking: collapsed after completion
- failed tools: expanded
- changed files: visible summary, diff one click away
- raw JSON: hidden under “Raw”

### Narration labels

Replace generic labels with intent labels:

- `read_file` → “Read file” + path
- `search_files` / grep → “Searched” + query/path
- shell command → “Ran command” + command
- write/edit → “Edited file” + path
- test command → “Ran tests” + result
- browser → “Opened page” / “Clicked” / “Typed”

Use t3code-style pure derivation helpers, not component heuristics.

## Implementation phases

### Phase 1 — pure timeline derivation, no schema change

- Add `web/src/lib/timeline.ts` to derive rows from current `messages + activities + plan/content blocks`.
- Move `mergeMessagesAndActivities`, grouping, summaries, and status derivation out of `AssistantMessageGroups`.
- Add unit tests for ordering, tool grouping, failed tools, thinking, plans, and streaming last-tool state.
- Swap `AssistantMessageGroups` to render derived rows.

Outcome: less risky UI improvement, no DB migration.

### Phase 2 — better tool/work presentation

- Add `deriveToolPresentation(activity)` shared helper.
- Collapse consecutive work rows into a `WorkLogGroup` row.
- Show “what agent is doing” from latest active block, not generic working copy.
- Add per-tool expansion state keyed by `toolCallId`.
- Show changed file count/path chips directly in the turn.

Outcome: immediate readability win.

### Phase 3 — first-class timeline projection

- Add DB table `timeline_items` or `turn_blocks`.
- Normalize ACP events in server when received:
  - assistant text chunks append to text block
  - thought chunks append to thinking block
  - tool calls upsert tool blocks
  - plan events upsert plan blocks
  - file-oriented tool results emit file-change blocks
- Add REST endpoint `/api/tasks/:id/timeline`.
- Add WebSocket message `timeline_patch` for block upserts/appends/completions.
- Keep existing `/messages` and `/activities` as compatibility until migrated.

Outcome: durable, ordered, reload-safe chat.

### Phase 4 — virtualized, stable transcript

- Use a virtualized list for long transcripts.
- Add stable row identity logic like t3code.
- Formalize follow-bottom behavior and “Jump to latest”.
- Preserve expansion and scroll anchor on stream updates.

Outcome: chat remains smooth on long tasks.

### Phase 5 — richer coding-agent affordances

- Streaming file edit block with diff preview.
- Plan block with statuses and “create follow-up task” action.
- Permission blocks inline in the relevant tool position.
- Turn-level “copy answer”, “copy full turn”, “retry from here”.
- Optional feedback controls for agent answer quality.

Outcome: chat becomes a task control surface, not just transcript.

## Suggested first PR

Do Phase 1 + part of Phase 2 only:

- Extract timeline derivation from `AssistantMessageGroups`.
- Add tests.
- Add compact work row summaries.
- Do not migrate DB yet.

This is low-risk and creates the seam for the bigger normalized timeline projection.

## Non-goals

- Do not copy t3code’s whole product model.
- Do not copy Zed’s GPUI architecture.
- Do not add provider-specific UI hacks.
- Do not expose raw chain-of-thought beyond what ACP/provider already emits.

## Success metrics

- A 100-tool run is readable without expanding every tool.
- User can tell what the agent is currently doing in one line.
- Reload during a running turn preserves the same visible timeline.
- Streaming does not jump scroll when the user is reading older content.
- Failed tools and changed files are visible without digging into JSON.
