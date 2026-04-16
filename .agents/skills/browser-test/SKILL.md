---
name: browser-test
description: Visually verify web UI changes using playwright-cli with Chromium. Start a dev server on a unique port per worktree, navigate to affected pages, take screenshots, and check for console errors. Use after completing any web dashboard feature, bug fix, or UI change.
compatibility: Requires playwright-cli (npm install -g @playwright/cli) and Chromium (npx playwright install chromium)
allowed-tools: Bash(playwright-cli:*) Bash(bunx vite:*) Bash(curl:*) Bash(kill:*)
metadata:
  author: tangerine
  version: "1.0"
---

# Browser Test

Visually verify web UI changes by running the app in a real browser and taking screenshots.

Always launch `playwright-cli` with Chromium explicitly. Do not rely on the default browser selection, because Chrome may be unavailable on Tangerine VMs.

## When to use

After completing work on any feature, bug fix, or change that affects the **web dashboard** (`web/src/`). Do NOT use for server-only or shared-only changes.

## Prerequisites

- `playwright-cli` installed globally (`npm install -g @playwright/cli`)
- Chromium installed (`npx playwright install chromium`)
- Both are pre-installed on Tangerine VMs

## Quick workflow

```
1. Derive port from worktree slot number
2. Start vite dev server on that port (background)
3. Wait for server ready
4. Open Chromium with playwright-cli
5. If auth is enabled, inject the auth token into localStorage
6. Navigate to affected pages, take screenshots
7. Check console for errors
8. Clean up (close browser, kill dev server)
```

## Detailed steps

### Step 1 — Derive a unique port

Extract the slot number from your worktree path and compute a port:

```bash
# Worktree path looks like: /workspace/<project>/worktrees/<projectId>-slot-<N>
SLOT_NUM=$(basename "$PWD" | grep -oP 'slot-\K\d+')
VITE_PORT=$((5170 + SLOT_NUM))
echo "Using port $VITE_PORT"
```

If you cannot determine the slot number, use port **5199** as a fallback.

### Step 2 — Start the dev server

```bash
cd web && bunx vite --port $VITE_PORT > /tmp/vite-$VITE_PORT.log 2>&1 &
VITE_PID=$!
echo "Vite PID: $VITE_PID"
```

### Step 3 — Wait for the server

```bash
# Wait up to 30 seconds for vite to be ready
for i in $(seq 1 30); do
  curl -s -o /dev/null http://localhost:$VITE_PORT && break
  sleep 1
done
```

### Step 4 — Open browser and take screenshots

Use a named session tied to the task to avoid conflicts with other tasks:

```bash
TASK_SHORT=$(echo $TANGERINE_TASK_ID | cut -c1-8)
SESSION="task-$TASK_SHORT"

# Open Chromium explicitly (headless by default)
playwright-cli --browser chromium -s=$SESSION open http://localhost:$VITE_PORT

# Always set viewport explicitly — some environments open Chromium with a
# non-standard default size, causing screenshots at 1/4 resolution or smaller.
# Use 1920x1080 for crisp, full-HD screenshots (headless Chromium has dpr=1).
playwright-cli -s=$SESSION resize 1920 1080
```

All later `playwright-cli` commands in the session reuse that Chromium instance.

### Step 5 — Authenticate if needed

If the Tangerine server has auth enabled (`TANGERINE_AUTH_TOKEN` is set), you must inject the token into localStorage before the app loads:

```bash
# Check if auth is enabled
AUTH_STATUS=$(curl -s http://localhost:$VITE_PORT/api/auth/session | jq -r '.enabled')

if [ "$AUTH_STATUS" = "true" ]; then
  # Inject the auth token into localStorage (must be done before navigating)
  playwright-cli -s=$SESSION eval "localStorage.setItem('tangerine-auth-token', '$TANGERINE_AUTH_TOKEN')"
  # Reload to pick up the token
  playwright-cli -s=$SESSION goto http://localhost:$VITE_PORT/
fi
```

If you don't have `TANGERINE_AUTH_TOKEN` in your environment and auth is enabled, the dashboard will show a login screen. Either:
1. Set `TANGERINE_AUTH_TOKEN` before running the test
2. Or use Test Server Mode (below) which disables auth

### Step 6 — Navigate and screenshot affected pages

Determine which pages are affected by your changes and screenshot them.
See [references/pages.md](references/pages.md) for the full route map.

```bash
# Example: screenshot the main runs page
playwright-cli -s=$SESSION goto http://localhost:$VITE_PORT/
playwright-cli -s=$SESSION screenshot --filename=runs-page.png

# Example: screenshot a specific task detail
playwright-cli -s=$SESSION goto http://localhost:$VITE_PORT/tasks/example-id
playwright-cli -s=$SESSION screenshot --filename=task-detail.png
```

Save screenshots with descriptive filenames. The default output directory is `.playwright-cli/`.

### Step 7 — Check for console errors

```bash
playwright-cli -s=$SESSION console error
```

If there are errors, investigate and fix them before finishing.

### Step 8 — Clean up

Always clean up, even if earlier steps failed:

```bash
playwright-cli -s=$SESSION close
kill $VITE_PID 2>/dev/null
```

## Guidelines

- **Screenshot what you changed**: If you modified a component on the Runs page, screenshot that page. If you changed a dialog, open it and screenshot it.
- **Multiple viewports**: If the change is responsive, resize before screenshotting:
  ```bash
  playwright-cli -s=$SESSION resize 375 812   # mobile
  playwright-cli -s=$SESSION screenshot --filename=runs-mobile.png
  playwright-cli -s=$SESSION resize 1920 1080  # desktop
  playwright-cli -s=$SESSION screenshot --filename=runs-desktop.png
  ```
- **Interactive states**: Use `click`, `hover`, `fill` to trigger UI states (open menus, fill forms, hover tooltips) before screenshotting.
- **Console errors are bugs**: If `console error` returns results after your changes, fix them.
- **Don't forget cleanup**: Always kill the vite process. Leaked dev servers block ports for other tasks.

## Test Server Mode (Deterministic Screenshots)

For deterministic, seeded data instead of live state, start an isolated test server. Test servers run with `TANGERINE_INSECURE_NO_AUTH=1` to disable authentication, so you don't need to inject tokens.

### Start a test server

```bash
# Pick a unique port for the test API server
TEST_API_PORT=$((3456 + SLOT_NUM + 100))
TEST_DB="/tmp/tangerine-test-${TASK_SHORT}.db"
TEST_CONFIG="$(pwd)/packages/server/src/test-fixtures/test-config.json"

# Start the test server with isolated config, DB, test mode, and auth disabled
TEST_MODE=1 TANGERINE_INSECURE_NO_AUTH=1 TANGERINE_CONFIG="$TEST_CONFIG" TANGERINE_DB="$TEST_DB" TANGERINE_PORT=$TEST_API_PORT \
  bun run packages/server/src/cli/index.ts start > /tmp/tangerine-test-server.log 2>&1 &
TEST_SERVER_PID=$!

# Wait for the test server to be ready
for i in $(seq 1 30); do
  curl -s http://localhost:$TEST_API_PORT/api/health && break
  sleep 1
done
```

### Seed data

```bash
# Seed with the default fixture data
curl -s -X POST http://localhost:$TEST_API_PORT/api/test/seed \
  -H "Content-Type: application/json" \
  -d @packages/server/src/test-fixtures/seed-data.json
```

### Point Vite at the test server

```bash
# Start vite with the API proxy pointing to the test server
cd web && VITE_API_URL=http://localhost:$TEST_API_PORT \
  bunx vite --port $VITE_PORT > /tmp/vite-$VITE_PORT.log 2>&1 &
VITE_PID=$!
```

### Simulate a GitHub webhook

```bash
# Simulate an issue.opened webhook
curl -s -X POST http://localhost:$TEST_API_PORT/api/test/simulate-webhook \
  -H "Content-Type: application/json" \
  -H "x-github-event: issues" \
  -d @packages/server/src/test-fixtures/webhooks/issue-opened-label.json
```

### Reset and cleanup

```bash
# Reset all seeded data
curl -s -X POST http://localhost:$TEST_API_PORT/api/test/reset

# Cleanup test server
kill $TEST_SERVER_PID 2>/dev/null
rm -f "$TEST_DB"
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Port already in use | Check `lsof -i :$VITE_PORT` and kill the stale process, or use a different port |
| Vite won't start | Check `cat /tmp/vite-$VITE_PORT.log` for errors. Run `bun install` first if deps are missing |
| Screenshots are blank | Wait longer for the page to render: `playwright-cli -s=$SESSION eval "await new Promise(r => setTimeout(r, 2000))"` then screenshot |
| Screenshots are at 1/4 resolution (e.g. 320x180 instead of 1920x1080) | The browser opened with a non-standard default viewport. Always run `playwright-cli -s=$SESSION resize 1920 1080` immediately after `open` (already in Step 4). |
| Browser launch fails because Chrome is unavailable | Re-run the command with `--browser chromium`; this skill requires Chromium explicitly |
| Chromium not found | Run `npx playwright install chromium` |
| Dashboard shows login screen | Auth is enabled. Either inject token via Step 5, use Test Server Mode, or set `TANGERINE_INSECURE_NO_AUTH=1` on the API server |
