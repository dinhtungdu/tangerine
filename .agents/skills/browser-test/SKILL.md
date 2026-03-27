---
name: browser-test
description: Visually verify web UI changes using playwright-cli. Start a dev server on a unique port per worktree, navigate to affected pages, take screenshots, and check for console errors. Use after completing any web dashboard feature, bug fix, or UI change.
compatibility: Requires playwright-cli (npm install -g @playwright/cli) and Chromium (npx playwright install chromium)
allowed-tools: Bash(playwright-cli:*) Bash(bunx vite:*) Bash(curl:*) Bash(kill:*)
metadata:
  author: tangerine
  version: "1.0"
---

# Browser Test

Visually verify web UI changes by running the app in a real browser and taking screenshots.

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
4. Open browser with playwright-cli
5. Navigate to affected pages, take screenshots
6. Check console for errors
7. Clean up (close browser, kill dev server)
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

# Open browser (headless by default)
playwright-cli -s=$SESSION open http://localhost:$VITE_PORT
```

### Step 5 — Navigate and screenshot affected pages

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

### Step 6 — Check for console errors

```bash
playwright-cli -s=$SESSION console error
```

If there are errors, investigate and fix them before finishing.

### Step 7 — Clean up

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
  playwright-cli -s=$SESSION resize 1280 720  # desktop
  playwright-cli -s=$SESSION screenshot --filename=runs-desktop.png
  ```
- **Interactive states**: Use `click`, `hover`, `fill` to trigger UI states (open menus, fill forms, hover tooltips) before screenshotting.
- **Console errors are bugs**: If `console error` returns results after your changes, fix them.
- **Don't forget cleanup**: Always kill the vite process. Leaked dev servers block ports for other tasks.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Port already in use | Check `lsof -i :$VITE_PORT` and kill the stale process, or use a different port |
| Vite won't start | Check `cat /tmp/vite-$VITE_PORT.log` for errors. Run `bun install` first if deps are missing |
| Screenshots are blank | Wait longer for the page to render: `playwright-cli -s=$SESSION eval "await new Promise(r => setTimeout(r, 2000))"` then screenshot |
| Chromium not found | Run `npx playwright install chromium` |
