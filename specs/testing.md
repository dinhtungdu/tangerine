# Testing

Agents verify their work. Project config defines how to run tests; agents execute them locally in their worktree.

## Approach

Agent runs tests as part of its workflow — not a separate system. All agent providers (OpenCode, Claude Code, Codex) have shell access in the local worktree, so they can run whatever test commands the project defines.

## Project Test Config

```json
{
  "test": "npm test && npx playwright test"
}
```

The test command is included in the agent's context so it knows how to verify changes.

## Test Types by Project

### WordPress (wp-env)

```bash
npx wp-env run tests-wordpress -- phpunit --filter=TestClassName
npx playwright test
npx wp-env run cli -- wp eval 'echo "PHP OK";'
```

### Node.js / React

```bash
npm test
npx playwright test
npm run lint
npm run typecheck
```

### Generic

Whatever the project's `test` command is. The agent can also discover test commands from `package.json`, `Makefile`, etc.

## Playwright Setup

Projects using Playwright should pre-install browsers:

```bash
npx playwright install --with-deps chromium
```

## Agent Prompting

The project test command is included in the system context:

```
To verify your changes, run: {project.test}
Always run tests before marking work as complete.
```

The agent decides when to run tests (after changes, before creating PR).

## Test Results in Chat

When the agent runs tests via shell, ACP tool-call output appears in the chat stream. Users see pass/fail in real time for any configured ACP agent that streams tool updates.

## Worktree Isolation

Each task runs in its own git worktree. Test side effects (generated files, caches) stay isolated per task. Cleanup happens when worktree is removed after task completion.

## Future

- Require tests to pass before PR creation (gate)
- Visual regression testing (screenshot comparison)
- Test result summary in PR description
- Coverage reporting
