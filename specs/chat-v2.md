# Chat Architecture

Chat/message handling design based on study of:
- **zed-industries/zed** — primary reference (ACP client)
- **formulahendry/vscode-acp** — ACP client reference
- **RAIT-09/obsidian-agent-client** — ACP client with perf optimizations
- **vercel-labs/open-agents** — parts-based model
- **pingdotgg/t3code** — streaming flags, work log separation

## ACP Event Types

From ACP protocol, the key session update events:
- `agent_message_chunk` — assistant text delta
- `agent_thought_chunk` — thinking delta
- `tool_call` — tool use started
- `tool_call_update` — tool status/result
- `user_message_chunk` — user message (echo)
- `prompt_end` — turn complete

## Design Principles

| Pattern | Source |
|---------|--------|
| Direct ACP event mapping | zed |
| Chunks in message (message/thought) | zed |
| Adjacent same-type coalescing | zed |
| Generate own messageIds | zed, vscode-acp |
| Per-chunk expansion | zed |
| Persist after completion | open-agents |
| Thinking collapsible with duration | vscode-acp |
| RAF batching for streaming | obsidian-agent-client |
| O(1) tool call lookup | obsidian-agent-client |
| Domain/protocol separation | obsidian-agent-client |
| Permission in tool_call | obsidian-agent-client |

## Thread Model

```typescript
// types/thread.ts

// Matches Zed's AssistantMessageChunk
type MessageChunk =
  | { type: "message"; content: string }   // agent_message_chunk
  | { type: "thought"; content: string }   // agent_thought_chunk

// Thread entry types (like Zed's AgentThreadEntry)
type ThreadEntry =
  | UserEntry
  | AssistantEntry
  | ToolCallEntry
  | PlanEntry

interface UserEntry {
  kind: "user"
  id: string
  content: string
  timestamp: string
  images?: MessageImage[]
}

interface AssistantEntry {
  kind: "assistant"
  id: string
  chunks: MessageChunk[]
  timestamp: string
  streaming: boolean
}

interface ToolCallEntry {
  kind: "tool_call"
  id: string
  toolCallId: string
  toolName: string
  input: unknown
  status: ToolCallStatus
  result?: string
  permissionRequest?: PermissionRequest
}

interface PlanEntry {
  kind: "plan"
  id: string
  entries: PlanItem[]
  timestamp: string
}

type ToolCallStatus = "pending_permission" | "running" | "done" | "error"

// Permission embedded in tool_call (from obsidian-agent-client)
interface PermissionRequest {
  requestId: string
  options: Array<{ id: string; name: string; description?: string }>
}

interface MessageImage {
  src: string
  mediaType?: string
}
```

## ACP Event Handling

Direct mapping from ACP events (like Zed's `handle_session_update`):

```typescript
// lib/acp-handler.ts

interface StreamState {
  messageId: string | null
  chunkIndex: number
  lastChunkType: "message" | "thought" | null
}

function handleSessionUpdate(
  update: AcpSessionUpdate,
  state: StreamState
): StreamEvent[] {
  switch (update.type) {
    case "agent_message_chunk":
      return pushChunk(state, "message", update.content.text)

    case "agent_thought_chunk":
      return pushChunk(state, "thought", update.content.text)

    case "tool_call":
      return [{
        type: "tool_call.start",
        toolCallId: update.toolCallId,
        toolName: update.toolName,
        input: update.input,
      }]

    case "tool_call_update":
      return [{
        type: "tool_call.update",
        toolCallId: update.toolCallId,
        status: update.status,
        result: update.result,
        permissionRequest: update.permissionRequest,
      }]

    case "prompt_end":
      const events: StreamEvent[] = []
      if (state.messageId) {
        events.push({ type: "assistant.done", messageId: state.messageId })
        state.messageId = null
        state.chunkIndex = -1
        state.lastChunkType = null
      }
      return events
  }
}

// Coalescing rule (from Zed)
function pushChunk(
  state: StreamState,
  chunkType: "message" | "thought",
  text: string
): StreamEvent[] {
  // First chunk of new message
  if (!state.messageId) {
    state.messageId = crypto.randomUUID()
    state.chunkIndex = 0
    state.lastChunkType = chunkType
    return [{
      type: "chunk.start",
      messageId: state.messageId,
      chunkIndex: 0,
      chunkType,
      content: text,
    }]
  }

  // Same type → append to existing chunk
  if (state.lastChunkType === chunkType) {
    return [{
      type: "chunk.delta",
      messageId: state.messageId,
      chunkIndex: state.chunkIndex,
      content: text,
    }]
  }

  // Type changed → new chunk
  state.chunkIndex++
  state.lastChunkType = chunkType
  return [{
    type: "chunk.start",
    messageId: state.messageId,
    chunkIndex: state.chunkIndex,
    chunkType,
    content: text,
  }]
}
```

## Stream Events

Events sent from server to client:

```typescript
// types/events.ts

type StreamEvent =
  | ChunkStartEvent
  | ChunkDeltaEvent
  | AssistantDoneEvent
  | ToolCallStartEvent
  | ToolCallUpdateEvent
  | UserMessageEvent

interface ChunkStartEvent {
  type: "chunk.start"
  messageId: string
  chunkIndex: number
  chunkType: "message" | "thought"
  content: string
}

interface ChunkDeltaEvent {
  type: "chunk.delta"
  messageId: string
  chunkIndex: number
  content: string
}

interface AssistantDoneEvent {
  type: "assistant.done"
  messageId: string
}

interface ToolCallStartEvent {
  type: "tool_call.start"
  toolCallId: string
  toolName: string
  input: unknown
}

interface ToolCallUpdateEvent {
  type: "tool_call.update"
  toolCallId: string
  status: ToolCallStatus
  result?: string
  permissionRequest?: PermissionRequest
}

interface UserMessageEvent {
  type: "user.message"
  id: string
  content: string
  images?: MessageImage[]
}
```

## Client State Management

### RAF Batching (from obsidian-agent-client)

```typescript
// hooks/useThread.ts

function useThread(sessionId: string) {
  const [entries, setEntries] = useState<ThreadEntry[]>([])
  const pendingUpdates = useRef<StreamEvent[]>([])
  const flushScheduled = useRef(false)
  const toolCallIndex = useRef<Map<string, number>>(new Map())

  const enqueueUpdate = useCallback((event: StreamEvent) => {
    pendingUpdates.current.push(event)
    if (!flushScheduled.current) {
      flushScheduled.current = true
      requestAnimationFrame(flushPendingUpdates)
    }
  }, [])

  const flushPendingUpdates = useCallback(() => {
    flushScheduled.current = false
    const batch = pendingUpdates.current
    pendingUpdates.current = []
    if (batch.length === 0) return

    setEntries(prev => {
      let next = prev
      for (const event of batch) {
        next = applyStreamEvent(next, event, toolCallIndex.current)
      }
      return next
    })
  }, [])

  // ... WebSocket setup, etc.
}
```

### Event Application

```typescript
// lib/thread-reducer.ts

function applyStreamEvent(
  entries: ThreadEntry[],
  event: StreamEvent,
  toolCallIndex: Map<string, number>
): ThreadEntry[] {
  switch (event.type) {
    case "chunk.start": {
      const idx = entries.findIndex(
        e => e.kind === "assistant" && e.id === event.messageId
      )
      if (idx >= 0) {
        // Existing assistant entry
        const entry = entries[idx] as AssistantEntry
        const updated: AssistantEntry = {
          ...entry,
          chunks: [...entry.chunks, { type: event.chunkType, content: event.content }],
        }
        return replaceAt(entries, idx, updated)
      }
      // New assistant entry
      const newEntry: AssistantEntry = {
        kind: "assistant",
        id: event.messageId,
        chunks: [{ type: event.chunkType, content: event.content }],
        timestamp: new Date().toISOString(),
        streaming: true,
      }
      return [...entries, newEntry]
    }

    case "chunk.delta": {
      const idx = entries.findIndex(
        e => e.kind === "assistant" && e.id === event.messageId
      )
      if (idx < 0) return entries
      const entry = entries[idx] as AssistantEntry
      const chunk = entry.chunks[event.chunkIndex]
      if (!chunk) return entries
      const updatedChunks = [...entry.chunks]
      updatedChunks[event.chunkIndex] = {
        ...chunk,
        content: chunk.content + event.content,
      }
      return replaceAt(entries, idx, { ...entry, chunks: updatedChunks })
    }

    case "assistant.done": {
      const idx = entries.findIndex(
        e => e.kind === "assistant" && e.id === event.messageId
      )
      if (idx < 0) return entries
      const entry = entries[idx] as AssistantEntry
      return replaceAt(entries, idx, { ...entry, streaming: false })
    }

    case "tool_call.start": {
      const newEntry: ToolCallEntry = {
        kind: "tool_call",
        id: crypto.randomUUID(),
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input,
        status: "running",
      }
      toolCallIndex.set(event.toolCallId, entries.length)
      return [...entries, newEntry]
    }

    case "tool_call.update": {
      const idx = findToolCall(entries, event.toolCallId, toolCallIndex)
      if (idx < 0) return entries
      const entry = entries[idx] as ToolCallEntry
      return replaceAt(entries, idx, {
        ...entry,
        status: event.status,
        result: event.result,
        permissionRequest: event.permissionRequest,
      })
    }

    case "user.message": {
      const newEntry: UserEntry = {
        kind: "user",
        id: event.id,
        content: event.content,
        timestamp: new Date().toISOString(),
        images: event.images,
      }
      return [...entries, newEntry]
    }
  }
}

function replaceAt<T>(arr: T[], idx: number, value: T): T[] {
  const next = [...arr]
  next[idx] = value
  return next
}

function findToolCall(
  entries: ThreadEntry[],
  toolCallId: string,
  index: Map<string, number>
): number {
  const cached = index.get(toolCallId)
  if (cached !== undefined && entries[cached]?.kind === "tool_call") {
    return cached
  }
  // Fallback linear scan
  const idx = entries.findIndex(
    e => e.kind === "tool_call" && e.toolCallId === toolCallId
  )
  if (idx >= 0) index.set(toolCallId, idx)
  return idx
}
```

## UI Rendering

### Thread View

```typescript
// components/ThreadView.tsx

function ThreadView({ entries }: { entries: ThreadEntry[] }) {
  return (
    <div className="thread">
      {entries.map(entry => {
        switch (entry.kind) {
          case "user":
            return <UserMessage key={entry.id} entry={entry} />
          case "assistant":
            return <AssistantMessage key={entry.id} entry={entry} />
          case "tool_call":
            return <ToolCallDisplay key={entry.id} entry={entry} />
          case "plan":
            return <PlanDisplay key={entry.id} entry={entry} />
        }
      })}
    </div>
  )
}
```

### Thinking Chunks (Zed + vscode-acp)

```typescript
// components/AssistantMessage.tsx

interface ThoughtState {
  expanded: boolean
  startTime: number | null
  duration: number | null
}

function AssistantMessage({ entry }: { entry: AssistantEntry }) {
  const [thoughtStates, setThoughtStates] = useState<Map<number, ThoughtState>>(new Map())

  // Auto-expand streaming thought, track duration
  useEffect(() => {
    entry.chunks.forEach((chunk, idx) => {
      if (chunk.type !== "thought") return

      setThoughtStates(prev => {
        const state = prev.get(idx)
        const next = new Map(prev)

        if (!state && entry.streaming) {
          // New streaming thought → expand, start timer
          next.set(idx, { expanded: true, startTime: Date.now(), duration: null })
        } else if (state?.startTime && !entry.streaming && state.duration === null) {
          // Streaming ended → calculate duration, collapse
          next.set(idx, {
            expanded: false,
            startTime: state.startTime,
            duration: Math.round((Date.now() - state.startTime) / 1000),
          })
        }

        return next
      })
    })
  }, [entry.chunks.length, entry.streaming])

  return (
    <div className="assistant-message">
      {entry.chunks.map((chunk, idx) => {
        if (chunk.type === "message") {
          return <Markdown key={idx} content={chunk.content} />
        }

        const state = thoughtStates.get(idx)
        return (
          <ThoughtBlock
            key={idx}
            content={chunk.content}
            expanded={state?.expanded ?? false}
            duration={state?.duration}
            streaming={entry.streaming && idx === entry.chunks.length - 1}
            onToggle={() => {
              setThoughtStates(prev => {
                const next = new Map(prev)
                const current = prev.get(idx)
                next.set(idx, { ...current, expanded: !current?.expanded })
                return next
              })
            }}
          />
        )
      })}
    </div>
  )
}
```

### Thought Block

```typescript
// components/ThoughtBlock.tsx

function ThoughtBlock({
  content,
  expanded,
  duration,
  streaming,
  onToggle,
}: {
  content: string
  expanded: boolean
  duration: number | null
  streaming: boolean
  onToggle: () => void
}) {
  const label = streaming
    ? "Thinking..."
    : duration !== null
      ? `Thought for ${duration}s`
      : "Thought"

  return (
    <details open={expanded} onToggle={onToggle}>
      <summary className="thought-header">
        {streaming && <Spinner />}
        {label}
      </summary>
      <div className="thought-content">
        <Markdown content={content} />
      </div>
    </details>
  )
}
```

## Persistence

### What to Persist

- Complete `AssistantEntry` (after `assistant.done`)
- Complete `ToolCallEntry` (after status is `done` or `error`)
- `UserEntry` (immediately on send)
- `PlanEntry` (when received)

### Persistence Format

```typescript
// Store entries as JSON in session_logs table
interface PersistedEntry {
  id: string
  session_id: string
  entry_type: "user" | "assistant" | "tool_call" | "plan"
  data: string  // JSON serialized ThreadEntry
  timestamp: string
}
```

### Session Load

On reconnect or page load:
1. Fetch persisted entries for session
2. Deserialize to `ThreadEntry[]`
3. If last entry is `assistant` with `streaming: true`, it was interrupted — mark as done

## WebSocket Protocol

```typescript
// Client → Server
type ClientMessage =
  | { type: "prompt"; content: string; images?: MessageImage[] }
  | { type: "abort" }
  | { type: "permission.respond"; requestId: string; optionId: string }

// Server → Client
type ServerMessage =
  | { type: "event"; data: StreamEvent }
  | { type: "connected"; sessionId: string }
  | { type: "error"; message: string }
```

## File Structure

```
web/
  src/
    types/
      thread.ts       # ThreadEntry, MessageChunk types
      events.ts       # StreamEvent types
    lib/
      acp-handler.ts  # ACP → StreamEvent mapping
      thread-reducer.ts # Event application logic
    hooks/
      useThread.ts    # State management with RAF batching
      useWebSocket.ts # WS connection
    components/
      ThreadView.tsx
      AssistantMessage.tsx
      ThoughtBlock.tsx
      ToolCallDisplay.tsx
      UserMessage.tsx
      PlanDisplay.tsx

packages/server/
  src/
    acp/
      handler.ts      # ACP event handling
      converter.ts    # ACP types → domain types
    ws/
      session.ts      # WS session management
    db/
      entries.ts      # Entry persistence
```
