# OpenCode SDK Spike

Phase 0 validation — confirms `@opencode-ai/sdk` works for Tangerine's needs.

## Prerequisites

- Bun installed
- A test repo (any git repo with some code)
- OpenCode CLI installed (`go install github.com/opencode-ai/opencode@latest` or equivalent)
- `ANTHROPIC_API_KEY` set in your environment

## Setup

From the tangerine root:

```bash
bun install
```

## Start OpenCode Server

In a **separate terminal**, `cd` into a test repo and start the server:

```bash
cd /path/to/some/test-repo
ANTHROPIC_API_KEY=sk-... opencode serve --port 4096
```

The server should print that it's listening on port 4096.

## Run the Spike

```bash
bun run spike/opencode-spike.ts
```

To use a different server URL:

```bash
bun run spike/opencode-spike.ts --url http://localhost:9000
```

## What to Look For

1. **Health check** — should return successfully, confirming the server is reachable.
2. **Session create** — should return a session object with an `id`.
3. **SSE events** — the script logs every event type it receives. This documents the event taxonomy we need to handle in Tangerine's WebSocket relay.
4. **Idle detection** — the script should detect when the session finishes processing. Look for "Session is idle" in the output.
5. **Message history** — should list the messages exchanged (user prompt + assistant response).
6. **Abort** — sends a long prompt then aborts. Confirm the abort is acknowledged and the session returns to idle.
7. **Diff** — may be empty if the agent didn't modify files. A successful (even empty) response confirms the endpoint works.
8. **Cleanup** — session should be deleted without error.

The **Summary** section at the end lists all SSE event types observed. This is the key output — we need this taxonomy to build our event relay layer.
