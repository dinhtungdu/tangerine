# Chat V2 Architecture

Rewrite of chat/message handling based on study of:
- **zed-industries/zed** — primary reference (also uses ACP)
- **formulahendry/vscode-acp** — ACP client reference
- **RAIT-09/obsidian-agent-client** — ACP client with perf optimizations
- **vercel-labs/open-agents** — parts-based model
- **pingdotgg/t3code** — streaming flags, work log separation

## Current Problems

1. **3-layer state tracking** fragile: acp-provider buffer → task-state buffer → client state
2. **Thinking blocks merge** when messageId not properly propagated
3. **No clear boundary** between streaming and persisted state
4. **Mixing concerns**: timeline merges messages + activities with timestamp sorting

## ACP Event Types (Reference)

From ACP protocol, the key session update events:
- `AgentMessageChunk` — assistant text delta
- `AgentThoughtChunk` — thinking delta
- `ToolCall` — tool use started
- `ToolCallUpdate` — tool status/result
- `UserMessageChunk` — user message (echo)

Zed's approach: **direct mapping** from ACP events to internal model, no intermediate buffering.

## Design Principles (from research)

| Pattern | Source | Adopt? |
|---------|--------|--------|
| Direct ACP event mapping | zed | Yes |
| Chunks in message (Message/Thought) | zed | Yes |
| Adjacent same-type coalescing | zed | Yes |
| Generate own messageIds | zed, vscode-acp | Yes |
| Per-chunk expansion | zed | Yes |
| Persist after completion | open-agents | Yes |
| Thinking in collapsible with duration | vscode-acp | Yes |
| RAF batching for streaming | obsidian-agent-client | Yes |
| O(1) tool call lookup | obsidian-agent-client | Yes |
| Domain/protocol separation | obsidian-agent-client | Yes |
| Permission in tool_call | obsidian-agent-client | Yes |

## Performance Patterns (from obsidian-agent-client)

### RAF Batching

High-frequency streaming updates batched via `requestAnimationFrame`:

```typescript
// hooks/useThread.ts

const pendingUpdates = useRef<StreamEvent[]>([])
const flushScheduled = useRef(false)

function enqueueUpdate(event: StreamEvent) {
  pendingUpdates.current.push(event)
  if (!flushScheduled.current) {
    flushScheduled.current = true
    requestAnimationFrame(flushPendingUpdates)
  }
}

function flushPendingUpdates() {
  flushScheduled.current = false
  const batch = pendingUpdates.current
  pendingUpdates.current = []
  
  setEntries(prev => batch.reduce(applyStreamEvent, prev))
}
```

### O(1) Tool Call Index

Map for fast tool call updates in long conversations:

```typescript
// Maintain index alongside entries
const toolCallIndex = useRef<Map<string, number>>(new Map())

function findToolCallEntry(toolCallId: string): number {
  const cached = toolCallIndex.current.get(toolCallId)
  if (cached !== undefined) return cached
  
  // Fallback linear scan, update index
  const idx = entries.findIndex(e => e.kind === "tool_call" && e.toolCallId === toolCallId)
  if (idx >= 0) toolCallIndex.current.set(toolCallId, idx)
  return idx
}
```

### Domain/Protocol Separation

ACP types vs internal types with converter:

```typescript
// types/thread.ts - domain types (ACP-agnostic)
type ThreadEntry = ...

// lib/acp-converter.ts - maps ACP → domain
function convertToolCall(acpToolCall: AcpToolCall): ToolCallEntry {
  return {
    kind: "tool_call",
    id: crypto.randomUUID(),
    toolCallId: acpToolCall.toolCallId,
    toolName: acpToolCall.toolName,
    // ... normalize input, handle permission
  }
}
```

## New Message Model (Zed-aligned)

```typescript
// shared/types.ts

// Matches Zed's AssistantMessageChunk
type MessageChunk =
  | { type: "message"; content: string }   // AgentMessageChunk
  | { type: "thought"; content: string }   // AgentThoughtChunk

// Thread entry types (like Zed's AgentThreadEntry)
type ThreadEntry =
  | { kind: "user"; id: string; content: string; timestamp: string; images?: MessageImage[] }
  | { kind: "assistant"; id: string; chunks: MessageChunk[]; timestamp: string; streaming: boolean }
  | { kind: "tool_call"; id: string; toolCallId: string; toolName: string; input: unknown; status: ToolCallStatus; result?: string; permissionRequest?: PermissionRequest }
  | { kind: "plan"; id: string; entries: PlanEntry[]; timestamp: string }

type ToolCallStatus = "pending_permission" | "running" | "done" | "error"

// Permission embedded in tool_call (from obsidian-agent-client)
// Simplifies UI correlation - no separate permission entry type
interface PermissionRequest {
  requestId: string
  options: Array<{ id: string; name: string; description?: string }>
}

// Note: No messageId from ACP - we generate our own UUIDs
```

Key differences from current:
- **Chunks not parts** — closer to Zed terminology
- **`message` vs `thought`** — matches ACP event names
- **`streaming` flag on entry** — not per-chunk state
- **Tool calls as separate entries** — like Zed's `ToolCall` entry type

## Streaming Model (Zed-aligned)

**Direct ACP event mapping** — no intermediate server-side buffering.

### ACP Event → Internal Event

```typescript
// acp-provider.ts - direct mapping like Zed's handle_session_update()

function handleSessionUpdate(update: AcpSessionUpdate, state: StreamState): InternalEvent[] {
  switch (update.type) {
    case "agent_message_chunk":
      return [pushAssistantChunk(state, "message", update.content)]
    
    case "agent_thought_chunk":
      return [pushAssistantChunk(state, "thought", update.content)]
    
    case "tool_call":
      return [{ kind: "tool_call.start", ...update }]
    
    case "tool_call_update":
      return [{ kind: "tool_call.update", ...update }]
    
    case "prompt_end":
      return [{ kind: "assistant.done", messageId: state.messageId }]
  }
}
```

### Coalescing Rule (from Zed)

```typescript
// Like Zed's push_assistant_content_block()

function pushAssistantChunk(
  state: StreamState,
  chunkType: "message" | "thought",
  delta: string
): InternalEvent {
  // If last chunk same type → append, else new chunk
  if (state.lastChunkType === chunkType) {
    return { kind: "chunk.delta", messageId: state.messageId, chunkIndex: state.chunkIndex, delta }
  }
  
  // Type changed → new chunk
  state.chunkIndex++
  state.lastChunkType = chunkType
  return { kind: "chunk.start", messageId: state.messageId, chunkIndex: state.chunkIndex, chunkType, delta }
}
```

### Server → Client Events

```typescript
// Simplified event types

type StreamEvent =
  | { type: "chunk.start"; messageId: string; chunkIndex: number; chunkType: "message" | "thought"; content: string }
  | { type: "chunk.delta"; messageId: string; chunkIndex: number; content: string }
  | { type: "assistant.done"; messageId: string }
  | { type: "tool_call.start"; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool_call.update"; toolCallId: string; status: string; result?: string }
```

### Client-Side

```typescript
// hooks/useThread.ts - like Zed's handle for AcpThreadEvent

function applyStreamEvent(entries: ThreadEntry[], event: StreamEvent): ThreadEntry[] {
  switch (event.type) {
    case "chunk.start": {
      const entry = findOrCreateAssistant(entries, event.messageId)
      entry.chunks.push({ type: event.chunkType, content: event.content })
      entry.streaming = true
      return [...entries]
    }
    
    case "chunk.delta": {
      const entry = findAssistant(entries, event.messageId)
      if (!entry) return entries
      const chunk = entry.chunks[event.chunkIndex]
      if (chunk) chunk.content += event.content
      return [...entries]
    }
    
    case "assistant.done": {
      const entry = findAssistant(entries, event.messageId)
      if (entry) entry.streaming = false
      return [...entries]
    }
    
    // ... tool_call handlers
  }
}
```

### No Server-Side Buffering

Remove `task-state.ts` active stream tracking entirely. The acp-provider:
1. Receives ACP events
2. Maps directly to internal events
3. Emits to WebSocket
4. Client accumulates

Persistence happens only on `assistant.done` or `tool_call.update` with final status.

## UI Rendering

### Timeline Structure

Simplified — entries are the timeline:

```typescript
// ThreadEntry[] IS the timeline
// No separate TimelineGroup/TimelineItem abstraction needed

// Render order: entries in array order (server maintains correct order)
entries.map(entry => {
  switch (entry.kind) {
    case "user": return <UserMessage entry={entry} />
    case "assistant": return <AssistantMessage entry={entry} />
    case "tool_call": return <ToolCallDisplay entry={entry} />
    case "plan": return <PlanDisplay entry={entry} />
  }
})
```

### Thinking Chunk Rendering (Zed + vscode-acp hybrid)

Per-chunk expansion state with duration display:

```typescript
// In AssistantMessage component
interface ThoughtState {
  expanded: boolean
  startTime: number | null
  duration: number | null  // seconds, set when streaming ends
}

const [thoughtStates, setThoughtStates] = useState<Map<number, ThoughtState>>(new Map())

// Auto-expand streaming thought, track duration
useEffect(() => {
  entry.chunks.forEach((chunk, idx) => {
    if (chunk.type !== "thought") return
    
    const state = thoughtStates.get(idx)
    if (!state && entry.streaming) {
      // New streaming thought → expand, start timer
      setThoughtStates(prev => new Map(prev).set(idx, {
        expanded: true,
        startTime: Date.now(),
        duration: null,
      }))
    } else if (state?.startTime && !entry.streaming && state.duration === null) {
      // Streaming ended → calculate duration, collapse
      setThoughtStates(prev => new Map(prev).set(idx, {
        expanded: false,
        startTime: state.startTime,
        duration: Math.round((Date.now() - state.startTime) / 1000),
      }))
    }
  })
}, [entry.chunks, entry.streaming])

// Render: "Thought for 5s" (collapsed) or full content (expanded)
```

### Expansion Modes (from Zed)

```typescript
type ThinkingDisplayMode = "auto" | "preview" | "always_expanded" | "always_collapsed"

// auto: expand while streaming, collapse after
// preview: show first N lines always
// always_expanded/collapsed: user preference
```

## Persistence

### What's Persisted

- Complete messages (after `message.done`)
- Activities (unchanged)

### What's NOT Persisted During Stream

- Part deltas (transient)
- Part states (derived from stream)

### Session Sync

On reconnect, fetch last N messages. If assistant message incomplete, resume streaming from current part.

## Migration Path

1. Add new event types alongside old ones
2. Update acp-provider to emit `part.delta` / `part.done`
3. Update client to handle new events
4. Remove old `thinking.streaming` / `message.streaming` handling
5. Remove `task-state.ts` active stream tracking
6. Update message persistence to store parts

## File Changes

| File | Change |
|------|--------|
| `shared/types.ts` | Add `MessagePart`, `ChatMessage` v2 |
| `server/agent/acp-provider.ts` | Emit part-based events |
| `server/tasks/task-state.ts` | Remove active stream tracking |
| `server/cli/start.ts` | Simplify event handling |
| `web/hooks/useSession.ts` | New part-based state |
| `web/components/ChatMessage.tsx` | Render parts, per-part expansion |
| `web/lib/timeline.ts` | Simplify (no message coalescing needed) |

## Open Questions

1. **Tool results**: Keep as activities or move to message parts?
   - Recommendation: Keep as activities (they have rich metadata, separate persistence)

2. **Images**: Separate part type or attribute on text part?
   - Recommendation: Attribute on message (current approach works)

3. **Plan blocks**: Part type or separate?
   - Recommendation: Separate `plan` part type
