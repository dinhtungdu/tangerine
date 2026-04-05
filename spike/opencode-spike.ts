/**
 * OpenCode SDK Spike — Phase 0 validation
 *
 * Validates all SDK capabilities Tangerine needs:
 * - Health check
 * - Session lifecycle (create, get, delete)
 * - Prompt (async) + SSE event streaming
 * - Completion detection (session goes idle)
 * - Message history retrieval
 * - Abort mid-execution
 * - Diff retrieval
 *
 * Usage:
 *   bun run spike/opencode-spike.ts
 *   bun run spike/opencode-spike.ts --url http://localhost:9000
 */

import { createOpencodeClient } from "@opencode-ai/sdk"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_URL = "http://localhost:4096"

function parseArgs(): { url: string } {
  const args = process.argv.slice(2)
  const urlIndex = args.indexOf("--url")
  const url = urlIndex !== -1 && args[urlIndex + 1]
    ? args[urlIndex + 1]
    : DEFAULT_URL
  return { url }
}

const { url } = parseArgs()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(label: string, ...rest: unknown[]) {
  console.log(`[spike] ${label}`, ...rest)
}

function heading(title: string) {
  console.log(`\n${"=".repeat(60)}`)
  console.log(`  ${title}`)
  console.log("=".repeat(60))
}

function fail(step: string, err: unknown): never {
  console.error(`\n[spike] FAILED at "${step}":`, err)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log("Connecting to OpenCode server at", url)

  const client = createOpencodeClient({ baseUrl: url })

  // ── 1. Health check ────────────────────────────────────────────────────
  heading("1. Health Check")

  try {
    const health = await client.global.health()
    log("Health response:", JSON.stringify(health, null, 2))
  } catch (err) {
    fail("health check — is `opencode serve` running?", err)
  }

  // ── 2. Create session ──────────────────────────────────────────────────
  heading("2. Create Session")

  let sessionId: string

  try {
    const session = await client.session.create({
      body: { title: "tangerine-spike-test" },
    })
    sessionId = session.data.id
    log("Created session:", sessionId)
    log("Session data:", JSON.stringify(session.data, null, 2))
  } catch (err) {
    fail("session.create", err)
  }

  // ── 3. Subscribe to SSE events ─────────────────────────────────────────
  heading("3. Subscribe to SSE Events")

  // We track every event type we see so we can document the taxonomy.
  const eventTypesSeen = new Set<string>()
  let sessionIdle = false
  let idleResolve: (() => void) | null = null
  const idlePromise = new Promise<void>((resolve) => {
    idleResolve = resolve
  })

  // Start consuming events in the background.
  const eventController = new AbortController()

  async function consumeEvents() {
    try {
      const events = await client.event.subscribe()

      for await (const event of events.stream) {
        const eventData = event as Record<string, unknown>
        const eventType = (eventData.type as string) ?? "unknown"
        eventTypesSeen.add(eventType)
        log(`SSE event [${eventType}]:`, JSON.stringify(eventData).slice(0, 200))

        // Detect idle — the session is done processing.
        // OpenCode emits a session.updated event with status "idle" when work
        // completes, or a message.completed / generation.complete event.
        // We check broadly so we discover whatever the SDK actually sends.
        const isIdle =
          (eventType === "session.updated" &&
            (eventData as Record<string, unknown>).status === "idle") ||
          eventType === "message.completed" ||
          eventType === "generation.complete" ||
          // Fallback: any event whose properties hint at completion
          (eventType.includes("complete") || eventType.includes("idle"))

        if (isIdle && !sessionIdle) {
          sessionIdle = true
          idleResolve?.()
        }

        if (eventController.signal.aborted) break
      }
    } catch (err) {
      // Event stream closed — expected during cleanup or abort.
      if (!eventController.signal.aborted) {
        log("Event stream error:", err)
      }
    }
  }

  // Fire and forget — runs in background.
  const eventLoop = consumeEvents()

  // Give the event subscription a moment to establish.
  await Bun.sleep(500)

  // ── 4. Send async prompt ───────────────────────────────────────────────
  heading("4. Send Async Prompt")

  try {
    await client.session.prompt_async({
      path: { id: sessionId },
      body: {
        parts: [{ type: "text", text: "Say hello and tell me what directory you are in." }],
      },
    })
    log("prompt_async sent (should return ~immediately)")
  } catch (err) {
    fail("session.prompt_async", err)
  }

  // ── 5. Wait for completion ─────────────────────────────────────────────
  heading("5. Waiting for Session to Become Idle")

  // Race against a timeout so we don't hang forever.
  const IDLE_TIMEOUT_MS = 60_000
  const timeout = Bun.sleep(IDLE_TIMEOUT_MS).then(() => "timeout" as const)
  const idle = idlePromise.then(() => "idle" as const)

  const result = await Promise.race([idle, timeout])

  if (result === "timeout") {
    log("WARNING: Timed out waiting for idle. Session may still be running.")
    log("Continuing with remaining tests anyway...")
  } else {
    log("Session is idle — prompt completed.")
  }

  // Small buffer to let any trailing events arrive.
  await Bun.sleep(1000)

  // ── 6. Retrieve message history ────────────────────────────────────────
  heading("6. Message History")

  try {
    const messages = await client.session.messages({
      path: { id: sessionId },
    })
    const msgList = Array.isArray(messages.data) ? messages.data : []
    log(`Retrieved ${msgList.length} message(s)`)
    for (const msg of msgList) {
      const m = msg as Record<string, unknown>
      log(`  [${m.role}] ${String(m.content ?? "").slice(0, 120)}...`)
    }
  } catch (err) {
    fail("session.messages", err)
  }

  // ── 7. Get session status ──────────────────────────────────────────────
  heading("7. Session Status")

  try {
    const session = await client.session.get({
      path: { id: sessionId },
    })
    log("Session status:", JSON.stringify(session.data, null, 2))
  } catch (err) {
    fail("session.get", err)
  }

  // ── 8. Test abort ──────────────────────────────────────────────────────
  heading("8. Abort Test")

  // Reset idle tracking for this round.
  sessionIdle = false
  const abortIdlePromise = new Promise<void>((resolve) => {
    idleResolve = resolve
  })

  try {
    // Send a long-running prompt that we intend to abort.
    await client.session.prompt_async({
      path: { id: sessionId },
      body: {
        parts: [{
          type: "text",
          text: "Write a very long detailed essay about the history of computing. Make it at least 2000 words.",
        }],
      },
    })
    log("Long prompt sent")

    // Give it a moment to start generating.
    await Bun.sleep(2000)

    // Abort.
    await client.session.abort({ path: { id: sessionId } })
    log("Abort sent")

    // Wait briefly for the session to settle.
    const abortTimeout = Bun.sleep(10_000).then(() => "timeout" as const)
    const abortIdle = abortIdlePromise.then(() => "idle" as const)
    const abortResult = await Promise.race([abortIdle, abortTimeout])

    if (abortResult === "idle") {
      log("Session returned to idle after abort")
    } else {
      log("WARNING: Session did not return to idle after abort within 10s")
    }
  } catch (err) {
    fail("abort test", err)
  }

  // ── 9. Diff retrieval ──────────────────────────────────────────────────
  heading("9. Diff Retrieval")

  try {
    const diff = await client.session.diff({
      path: { id: sessionId },
    })
    log("Diff response:", JSON.stringify(diff.data, null, 2).slice(0, 500))
  } catch (err) {
    // Diff may be empty if the agent didn't write files — that's OK.
    log("Diff retrieval returned error (may be expected if no files changed):", err)
  }

  // ── 10. Cleanup ────────────────────────────────────────────────────────
  heading("10. Cleanup — Delete Session")

  try {
    await client.session.delete({ path: { id: sessionId } })
    log("Session deleted:", sessionId)
  } catch (err) {
    log("Session delete error (non-fatal):", err)
  }

  // Stop the event stream.
  eventController.abort()
  await eventLoop.catch(() => {})

  // ── Summary ────────────────────────────────────────────────────────────
  heading("Summary")

  log("SSE event types observed:", [...eventTypesSeen].sort().join(", "))
  log("")
  log("All steps completed. Review the output above to validate each SDK method.")
}

main().catch((err) => {
  console.error("[spike] Unhandled error:", err)
  process.exit(1)
})
