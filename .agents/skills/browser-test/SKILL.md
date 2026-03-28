---
name: browser-test
description: Visually verify web UI changes using playwright-cli with Chromium. Start isolated Tangerine API and Vite servers, seed deterministic test data, navigate to affected pages, and check screenshots plus console errors. Use after completing any web dashboard feature, bug fix, or UI change.
compatibility: Requires playwright-cli (npm install -g @playwright/cli) and Chromium (npx playwright install chromium)
allowed-tools: Bash(playwright-cli:*) Bash(bunx vite:*) Bash(curl:*) Bash(kill:*)
metadata:
  author: tangerine
  version: "1.0"
---

# Browser Test

Visually verify web UI changes by running the app in a real browser with a deterministic Tangerine test server and seeded fixture data.

Always launch `playwright-cli` with Chromium explicitly. Do not rely on the default browser selection, because Chrome may be unavailable on Tangerine VMs.

## When to use

After completing work on any feature, bug fix, or change that affects the **web dashboard** (`web/src/`). Do NOT use for server-only or shared-only changes.

## Prerequisites

- `playwright-cli` installed globally (`npm install -g @playwright/cli`)
- Chromium installed (`npx playwright install chromium`)
- Both are pre-installed on Tangerine VMs

## Quick workflow

```
1. Derive unique API and Vite ports from the worktree slot
2. Create an isolated test config and SQLite DB
3. Start Tangerine in test mode on the API port
4. Seed deterministic fixture data (and optionally simulate a webhook)
5. Start Vite pointed at the test API
6. Open Chromium with playwright-cli
7. Navigate to affected pages, take screenshots, check console errors
8. Reset seeded data and clean up
```

## Detailed steps

### Step 1 — Derive unique ports

Extract the slot number from your worktree path and compute API + Vite ports:

```bash
SLOT_NUM=$(basename "$PWD" | grep -oP 'slot-\K\d+')
API_PORT=$((3456 + SLOT_NUM))
VITE_PORT=$((5170 + SLOT_NUM))
echo "Using API port $API_PORT and Vite port $VITE_PORT"
```

If you cannot determine the slot number, use API port **3499** and Vite port **5199**.

### Step 2 — Create isolated config and DB

Use a temp directory per task. Point the test project at a local path whose suffix matches the GitHub repo slug so webhook matching still works.

```bash
TASK_SHORT=$(echo $TANGERINE_TASK_ID | cut -c1-8)
TEST_ROOT="/tmp/tangerine-browser-test-$TASK_SHORT"
TEST_CONFIG="$TEST_ROOT/config.json"
TEST_DB="$TEST_ROOT/tangerine.test.db"
TEST_REPO="$TEST_ROOT/repos/acme/dashboard-e2e"
mkdir -p "$TEST_ROOT/repos/acme"
rm -f "$TEST_REPO"
ln -s "$PWD" "$TEST_REPO"

cat > "$TEST_CONFIG" <<EOF
{
  "workspace": "$TEST_ROOT/workspace",
  "projects": [
    {
      "name": "dashboard-e2e",
      "repo": "$TEST_REPO",
      "defaultBranch": "main",
      "setup": "bun install",
      "test": "bun run check",
      "defaultProvider": "opencode"
    }
  ],
  "integrations": {
    "github": {
      "trigger": { "type": "label", "value": "tangerine" },
      "pollIntervalMinutes": 60
    }
  }
}
EOF
```

### Step 3 — Start the Tangerine test server

```bash
TEST_MODE=1 PORT=$API_PORT bun run packages/server/src/cli/index.ts start --config "$TEST_CONFIG" --db "$TEST_DB" --test-mode > "/tmp/tangerine-api-$API_PORT.log" 2>&1 &
API_PID=$!
echo "API PID: $API_PID"
```

### Step 4 — Wait for the API and seed data

```bash
for i in $(seq 1 30); do
  curl -sf "http://localhost:$API_PORT/api/health" >/dev/null && break
  sleep 1
done

curl -sf -X POST "http://localhost:$API_PORT/api/test/seed"
```

Optional webhook simulation:

```bash
curl -sf -X POST \
  -H "Content-Type: application/json" \
  -H "x-github-event: issues" \
  --data-binary @packages/server/src/test-fixtures/webhooks/issue-opened-label.json \
  "http://localhost:$API_PORT/api/test/simulate-webhook"
```

### Step 5 — Start the Vite dev server

Run this command from `web/`:

```bash
TANGERINE_API_URL="http://localhost:$API_PORT" bunx vite --port $VITE_PORT > /tmp/vite-$VITE_PORT.log 2>&1 &
VITE_PID=$!
echo "Vite PID: $VITE_PID"
```

### Step 6 — Wait for the web server

```bash
for i in $(seq 1 30); do
  curl -sf -o /dev/null http://localhost:$VITE_PORT && break
  sleep 1
done
```

### Step 7 — Open browser and take screenshots

Use a named session tied to the task to avoid conflicts with other tasks:

```bash
TASK_SHORT=$(echo $TANGERINE_TASK_ID | cut -c1-8)
SESSION="task-$TASK_SHORT"

# Open Chromium explicitly (headless by default)
playwright-cli --browser chromium -s=$SESSION open http://localhost:$VITE_PORT
```

All later `playwright-cli` commands in the session reuse that Chromium instance.

### Step 8 — Navigate and screenshot affected pages

Determine which pages are affected by your changes and screenshot them.
See [references/pages.md](references/pages.md) for the full route map.

```bash
# Example: seeded dashboard state
playwright-cli -s=$SESSION goto http://localhost:$VITE_PORT/
playwright-cli -s=$SESSION screenshot --filename=dashboard-seeded.png

# Example: screenshot a seeded task detail
playwright-cli -s=$SESSION goto http://localhost:$VITE_PORT/tasks/task-running-001
playwright-cli -s=$SESSION screenshot --filename=task-detail.png

# Example: simulate a webhook-created task, then capture the dashboard again
curl -sf -X POST \
  -H "Content-Type: application/json" \
  -H "x-github-event: issues" \
  --data-binary @packages/server/src/test-fixtures/webhooks/issue-labeled.json \
  "http://localhost:$API_PORT/api/test/simulate-webhook"
playwright-cli -s=$SESSION goto http://localhost:$VITE_PORT/
playwright-cli -s=$SESSION screenshot --filename=dashboard-webhook.png
```

Save screenshots with descriptive filenames. The default output directory is `.playwright-cli/`.

### Step 9 — Check for console errors

```bash
playwright-cli -s=$SESSION console error
```

If there are errors, investigate and fix them before finishing.

### Step 10 — Reset and clean up

Always clean up, even if earlier steps failed:

```bash
playwright-cli -s=$SESSION close
kill $VITE_PID 2>/dev/null
curl -sf -X POST "http://localhost:$API_PORT/api/test/reset" >/dev/null
kill $API_PID 2>/dev/null
rm -rf "$TEST_ROOT"
```

## Guidelines

- **Always use the isolated test API**: Start Tangerine with `--config`, `--db`, and `--test-mode`, then launch Vite with `TANGERINE_API_URL` so screenshots never depend on the user's live data.
- **Seed before screenshots, reset after**: Use `/api/test/seed` before navigation and `/api/test/reset` during cleanup so repeated runs stay deterministic.
- **Screenshot what you changed**: If you modified a component on the dashboard page, screenshot that page. If you changed a dialog, open it and screenshot it.
- **Multiple viewports**: If the change is responsive, resize before screenshotting:
  ```bash
  playwright-cli -s=$SESSION resize 375 812   # mobile
  playwright-cli -s=$SESSION screenshot --filename=runs-mobile.png
  playwright-cli -s=$SESSION resize 1280 720  # desktop
  playwright-cli -s=$SESSION screenshot --filename=runs-desktop.png
  ```
- **Interactive states**: Use `click`, `hover`, `fill` to trigger UI states (open menus, fill forms, hover tooltips) before screenshotting.
- **Console errors are bugs**: If `console error` returns results after your changes, fix them.
- **Webhook flows are testable**: Use `/api/test/simulate-webhook` with the sample fixtures under `packages/server/src/test-fixtures/webhooks/` when you need to verify issue-to-task creation visually.
- **Don't forget cleanup**: Always reset seeded data and kill both the Vite and API processes. Leaked test servers block ports for other tasks.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Port already in use | Check `lsof -i :$API_PORT` or `lsof -i :$VITE_PORT` and kill the stale process, or use a different port |
| Test API won't start | Check `cat /tmp/tangerine-api-$API_PORT.log`. Most failures come from malformed temp config JSON or missing Bun dependencies |
| Vite won't start | Check `cat /tmp/vite-$VITE_PORT.log` for errors. Run `bun install` first if deps are missing |
| Screenshots are blank | Wait longer for the page to render: `playwright-cli -s=$SESSION eval "await new Promise(r => setTimeout(r, 2000))"` then screenshot |
| Browser launch fails because Chrome is unavailable | Re-run the command with `--browser chromium`; this skill requires Chromium explicitly |
| Chromium not found | Run `npx playwright install chromium` |
