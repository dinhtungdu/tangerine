# Chat V2 Architecture

Rewrite of chat/message handling based on study of open-agents, t3code, and zed.

## Current Problems

1. **3-layer state tracking** fragile: acp-provider buffer → task-state buffer → client state
2. **Thinking blocks merge** when messageId not properly propagated
3. **No clear boundary** between streaming and persisted state
4. **Mixing concerns**: timeline merges messages + activities with timestamp sorting

## Design Principles (from research)

| Pattern | Source | Adopt? |
|---------|--------|--------|
| Parts/blocks in message | open-agents, zed | Yes |
| Thinking as separate activity | t3code | No - keep in message |
| Adjacent same-type coalescing | zed | Yes |
| Streaming state on part | open-agents | Yes |
| Per-block expansion | zed | Yes |
| Persist after completion | open-agents | Yes |

## New Message Model

```typescript
// shared/types.ts

type MessagePart =
  | { type: "text"; content: string }
  | { type: "thinking"; content: string; signature?: string }
  | { type: "tool_use"; toolName: string; toolUseId: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean }

type PartState = "streaming" | "done"

interface ChatMessage {
  id: string
  role: "user" | "assistant" | "system"
  parts: MessagePart[]
  partStates: PartState[]  // parallel array, same length as parts
  timestamp: string
  images?: MessageImage[]
}
```

## Streaming Model

Single source of truth: **client accumulates parts, server persists on completion**.

### Server → Client Events

```typescript
// New event types (replace current thinking.streaming etc)

type StreamEvent =
  | { type: "part.delta"; messageId: string; partIndex: number; partType: MessagePart["type"]; delta: string }
  | { type: "part.done"; messageId: string; partIndex: number }
  | { type: "message.done"; messageId: string; parts: MessagePart[] }
```

### Coalescing Rule (from Zed)

When receiving `part.delta`:
1. If `partIndex` matches last part AND same `partType` → append to existing
2. Else → create new part at `partIndex`

This means server assigns `partIndex` and client trusts it. Server increments `partIndex` when:
- Part type changes (text → thinking → text)
- Tool boundary (tool_use, tool_result are always new parts)

### Server-Side (Simplified)

Remove `task-state.ts` active stream buffering. ACP provider emits events with `partIndex`:

```typescript
// acp-provider.ts - event mapper

interface StreamState {
  messageId: string
  partIndex: number
  lastPartType: MessagePart["type"] | null
}

function nextPartIndex(state: StreamState, partType: MessagePart["type"]): number {
  if (state.lastPartType === partType && partType !== "tool_use" && partType !== "tool_result") {
    return state.partIndex  // same part, append
  }
  state.partIndex++
  state.lastPartType = partType
  return state.partIndex
}
```

### Client-Side

```typescript
// hooks/useMessageParts.ts

function applyPartDelta(
  messages: ChatMessage[],
  event: { messageId: string; partIndex: number; partType: string; delta: string }
): ChatMessage[] {
  const msgIdx = messages.findIndex(m => m.id === event.messageId)
  if (msgIdx === -1) {
    // New message
    return [...messages, {
      id: event.messageId,
      role: "assistant",
      parts: [{ type: event.partType, content: event.delta }],
      partStates: ["streaming"],
      timestamp: new Date().toISOString(),
    }]
  }
  
  return messages.map((msg, i) => {
    if (i !== msgIdx) return msg
    const parts = [...msg.parts]
    const states = [...msg.partStates]
    
    if (event.partIndex < parts.length) {
      // Append to existing part
      parts[event.partIndex] = {
        ...parts[event.partIndex],
        content: parts[event.partIndex].content + event.delta,
      }
    } else {
      // New part
      parts.push({ type: event.partType, content: event.delta })
      states.push("streaming")
    }
    
    return { ...msg, parts, partStates: states }
  })
}
```

## UI Rendering

### Timeline Structure

Keep current `TimelineGroup` concept but simplify:

```typescript
type TimelineItem =
  | { kind: "message"; data: ChatMessage }
  | { kind: "activity"; data: ActivityEntry }  // tool calls stay as activities

// Group: user message OR assistant message + its activities
```

### Thinking Block Expansion

Per-part expansion state (like Zed):

```typescript
// In AssistantMessage component
const [expandedParts, setExpandedParts] = useState<Set<number>>(new Set())

// Auto-expand streaming thinking, collapse when done
useEffect(() => {
  const streamingThinkingIdx = message.parts.findIndex(
    (p, i) => p.type === "thinking" && message.partStates[i] === "streaming"
  )
  if (streamingThinkingIdx >= 0) {
    setExpandedParts(prev => new Set([...prev, streamingThinkingIdx]))
  }
}, [message.parts, message.partStates])
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
