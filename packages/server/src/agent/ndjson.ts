// NDJSON streaming line parser for Claude Code's stdout.
// Buffers partial lines, parses complete JSON objects, maps to AgentEvent.

import type { AgentEvent, PromptImage } from "./provider"

export interface NdjsonParserOptions {
  onLine: (data: unknown) => void
  onError?: (err: Error) => void
  onEnd?: () => void
}

/**
 * Consumes an NDJSON ReadableStream, calling onLine for each parsed JSON object.
 * Returns a handle with stop() to abort early.
 */
export function parseNdjsonStream(
  stream: ReadableStream<Uint8Array>,
  options: NdjsonParserOptions,
): { stop(): void } {
  const decoder = new TextDecoder()
  let buffer = ""
  let stopped = false
  const reader = stream.getReader()

  async function pump() {
    try {
      while (!stopped) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        // Process all complete lines in the buffer
        let newlineIdx: number
        while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIdx).trim()
          buffer = buffer.slice(newlineIdx + 1)

          if (line.length === 0) continue

          try {
            const parsed = JSON.parse(line)
            options.onLine(parsed)
          } catch {
            // Malformed JSON — skip silently
          }
        }
      }
    } catch (err) {
      if (!stopped) {
        options.onError?.(err instanceof Error ? err : new Error(String(err)))
      }
    } finally {
      // Flush any remaining data in buffer (line without trailing newline)
      if (buffer.trim().length > 0) {
        try {
          const parsed = JSON.parse(buffer.trim())
          options.onLine(parsed)
        } catch {
          // Malformed trailing data — skip
        }
      }
      buffer = ""
      options.onEnd?.()
    }
  }

  pump()

  return {
    stop() {
      stopped = true
      reader.cancel().catch(() => {})
    },
  }
}

// ---------------------------------------------------------------------------
// Claude Code event → AgentEvent mapping
// ---------------------------------------------------------------------------

/**
 * Creates a stateful mapper that converts raw Claude Code stream-json events
 * to normalized AgentEvents. Stateful because images from tool results (user
 * events) need to be buffered and attached to the next assistant/narration message.
 *
 * Claude Code event types (from protocol spike):
 * - system (init): session metadata — ignored
 * - assistant: complete assistant message (text + tool_use + thinking content blocks)
 * - user: tool results — emits tool.end, buffers images for next narration
 * - rate_limit_event: ignored
 * - stream_event: token-level streaming (only with --include-partial-messages)
 * - result: final event with aggregated stats
 */
export function createClaudeCodeMapper(): (raw: Record<string, unknown>) => AgentEvent[] {
  // Images from tool results are buffered here until the result event
  let pendingToolImages: PromptImage[] = []
  // Track last narration content to deduplicate against the result event
  // (Claude Code repeats the last assistant turn text in the result)
  let lastNarrationContent = ""

  return function mapClaudeCodeEvent(raw: Record<string, unknown>): AgentEvent[] {
    const type = raw.type as string | undefined
    if (!type) return []

    switch (type) {
      case "assistant": {
        const message = raw.message as Record<string, unknown> | undefined
        if (!message) return []

        const events: AgentEvent[] = []
        const blocks = Array.isArray(message.content) ? message.content : []
        const textParts: string[] = []
        const imageParts: PromptImage[] = []

        for (const block of blocks) {
          if (typeof block !== "object" || block === null) continue
          const b = block as Record<string, unknown>

          if (b.type === "thinking" && typeof b.thinking === "string") {
            events.push({ kind: "thinking", content: truncate(b.thinking, 300) })
          } else if (b.type === "tool_use" && typeof b.name === "string") {
            events.push({
              kind: "tool.start",
              toolName: b.name,
              toolInput: b.input ? truncate(JSON.stringify(b.input), 500) : undefined,
            })
          } else if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) {
            textParts.push(b.text)
          } else if (b.type === "image") {
            const source = b.source as Record<string, unknown> | undefined
            if (source?.type === "base64" && typeof source.media_type === "string" && typeof source.data === "string") {
              imageParts.push({
                mediaType: source.media_type as PromptImage["mediaType"],
                data: source.data,
              })
            }
          }
        }

        // Images from assistant content blocks (rare) go to pending pool
        // along with tool result images — all will be attached to the final
        // assistant message from the "result" event, not to narration.
        if (imageParts.length > 0) {
          pendingToolImages.push(...imageParts)
        }

        // Per-turn text is narration (agent explaining what it's doing between tool
        // calls). The final answer comes from the "result" event as role "assistant".
        // Narration is persisted but collapsed in the UI alongside thinking.
        if (textParts.length > 0) {
          const narrationText = textParts.join("")
          lastNarrationContent = narrationText
          events.push({
            kind: "message.complete",
            role: "narration",
            content: narrationText,
            messageId: optStr(message.id),
          })
        }

        // Signal working if there are tool calls
        if (blocks.some((b: unknown) => typeof b === "object" && b !== null && (b as Record<string, unknown>).type === "tool_use")) {
          events.push({ kind: "status", status: "working" })
        }

        return events
      }

      case "user": {
        // Tool results being fed back — extract tool name, result content, and images
        const events: AgentEvent[] = []
        const message = raw.message as Record<string, unknown> | undefined
        const blocks = Array.isArray(message?.content) ? message!.content : []

        for (const block of blocks) {
          if (typeof block !== "object" || block === null) continue
          const b = block as Record<string, unknown>
          if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
            const resultText = typeof b.content === "string" ? b.content
              : Array.isArray(b.content) ? extractContent(b.content) ?? ""
              : ""
            events.push({
              kind: "tool.end",
              toolName: typeof b.name === "string" ? b.name : "unknown",
              toolResult: truncate(resultText, 500),
            })
            // Buffer images from tool results to attach to the next narration
            if (Array.isArray(b.content)) {
              for (const sub of b.content) {
                if (typeof sub !== "object" || sub === null) continue
                const s = sub as Record<string, unknown>
                if (s.type === "image") {
                  const source = s.source as Record<string, unknown> | undefined
                  if (source?.type === "base64" && typeof source.media_type === "string" && typeof source.data === "string") {
                    pendingToolImages.push({
                      mediaType: source.media_type as PromptImage["mediaType"],
                      data: source.data,
                    })
                  }
                }
              }
            }
          }
        }

        events.push({ kind: "status", status: "working" })
        return events
      }

      case "result": {
        const subtype = raw.subtype as string | undefined
        const content = typeof raw.result === "string" ? raw.result : ""

        if (subtype === "error" || raw.is_error === true) {
          pendingToolImages = []
          lastNarrationContent = ""
          return [{ kind: "error", message: content || "Agent error" }]
        }

        // Attach any remaining buffered images to the final assistant message
        const images = pendingToolImages.length > 0 ? pendingToolImages : undefined
        pendingToolImages = []

        // Claude Code repeats the last assistant turn text in the result event.
        // Skip the duplicate when narration already has the same content,
        // unless we have images that need to be delivered.
        const isDuplicate = content === lastNarrationContent && content.length > 0
        lastNarrationContent = ""

        if (!content && !images) return []
        if (isDuplicate && !images) return []

        return [{
          kind: "message.complete",
          role: "assistant",
          content: isDuplicate ? "" : content,
          messageId: optStr(raw.session_id),
          images,
        }]
      }

    case "stream_event": {
      const event = raw.event as Record<string, unknown> | undefined
      if (!event) return []

      if (event.type === "content_block_delta") {
        const delta = event.delta as Record<string, unknown> | undefined
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          return [{ kind: "message.streaming", content: delta.text }]
        }
      }
      return []
    }

    case "system": {
      const subtype = raw.subtype as string | undefined
      if (subtype === "init") {
        return [{ kind: "status", status: "working" }]
      }
      return []
    }

    default:
      return []
    }
  }
}

/** Stateless convenience wrapper — creates a fresh mapper per call (no image buffering across calls). */
export function mapClaudeCodeEvent(raw: Record<string, unknown>): AgentEvent[] {
  return createClaudeCodeMapper()(raw)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Truncate string to maxLen, appending "…" if truncated */
function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen) + "…"
}

/** Extract text content from Claude message content (string or content blocks) */
function extractContent(content: unknown): string | null {
  if (typeof content === "string") return content

  // Content blocks: [{ type: "text", text: "..." }, ...]
  if (Array.isArray(content)) {
    const texts: string[] = []
    for (const block of content) {
      if (
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        (block as Record<string, unknown>).type === "text" &&
        typeof (block as Record<string, unknown>).text === "string"
      ) {
        texts.push((block as Record<string, unknown>).text as string)
      }
    }
    return texts.length > 0 ? texts.join("") : null
  }

  return null
}

/** Safely extract an optional string */
function optStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}
