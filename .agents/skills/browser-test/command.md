---
description: Visually verify web UI changes — start dev server, take screenshots with playwright-cli, check for console errors
---
Read .agents/skills/browser-test/SKILL.md for full instructions.

**Browser testing workflow for web dashboard changes.**

1. Derive a unique port from your worktree slot number
2. Start the vite dev server in the `web/` directory on that port
3. Use `playwright-cli` to navigate to affected pages and take screenshots
4. Check `playwright-cli console error` for runtime errors
5. Clean up: close browser session and kill dev server

Before screenshotting, read [references/pages.md](.agents/skills/browser-test/references/pages.md) to know which routes to check based on the files you changed.

$ARGUMENTS
