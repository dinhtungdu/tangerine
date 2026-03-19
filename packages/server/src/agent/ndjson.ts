// NDJSON streaming line parser for Claude Code's stdout.
// Buffers partial lines, parses complete JSON objects, maps to AgentEvent.

import type { AgentEvent } from "./provider"

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
 * Maps a raw Claude Code stream-json event to a normalized AgentEvent.
 * Returns null for events we don't care about.
 *
 * Claude Code event types (from protocol spike):
 * - system (init): session metadata — ignored
 * - assistant: complete assistant message (text + tool_use content blocks)
 * - user: tool results — signals "working"
 * - rate_limit_event: ignored
 * - stream_event: token-level streaming (only with --include-partial-messages)
 * - result: final event with aggregated stats
 */
export function mapClaudeCodeEvent(raw: Record<string, unknown>): AgentEvent | null {
  const type = raw.type as string | undefined
  if (!type) return null

  switch (type) {
    case "assistant": {
      // Complete assistant message. Content may include text and/or tool_use blocks.
      const message = raw.message as Record<string, unknown> | undefined
      if (!message) return null

      const content = extractContent(message.content)
      const hasToolUse = hasToolUseBlock(message.content)

      if (hasToolUse) {
        // Assistant is about to use tools — signal working status
        return { kind: "status", status: "working" }
      }

      if (content) {
        return {
          kind: "message.streaming",
          content,
          messageId: optStr(message.id),
        }
      }
      return null
    }

    case "user": {
      // Tool result being fed back — agent is actively working
      return { kind: "status", status: "working" }
    }

    case "result": {
      // Final event. Contains aggregated result text and stop_reason.
      const subtype = raw.subtype as string | undefined
      const content = typeof raw.result === "string" ? raw.result : ""

      if (subtype === "error" || raw.is_error === true) {
        return { kind: "error", message: content || "Agent error" }
      }

      return {
        kind: "message.complete",
        role: "assistant",
        content,
        messageId: optStr(raw.session_id),
      }
    }

    case "stream_event": {
      // Token-level streaming (only with --include-partial-messages).
      // Extract text deltas for real-time display.
      const event = raw.event as Record<string, unknown> | undefined
      if (!event) return null

      if (event.type === "content_block_delta") {
        const delta = event.delta as Record<string, unknown> | undefined
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          return { kind: "message.streaming", content: delta.text }
        }
      }
      return null
    }

    case "system": {
      // Init event — session started, agent is working
      const subtype = raw.subtype as string | undefined
      if (subtype === "init") {
        return { kind: "status", status: "working" }
      }
      return null
    }

    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if content blocks contain a tool_use block */
function hasToolUseBlock(content: unknown): boolean {
  if (!Array.isArray(content)) return false
  return content.some(
    (block) =>
      typeof block === "object" &&
      block !== null &&
      (block as Record<string, unknown>).type === "tool_use",
  )
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
