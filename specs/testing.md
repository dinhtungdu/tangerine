# Testing Inside VMs

Agents should verify their work. The golden image includes test tooling; the project config defines how to run tests.

## Approach

The agent runs tests as part of its workflow — not a separate system. Both OpenCode and Claude Code have shell access inside the VM, so the agent can run whatever test commands the project defines.

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

## Playwright in VMs

Golden images with Playwright should pre-install browsers:

```bash
# In image build script
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

When the agent runs tests via shell, the output appears in the chat stream (via tool call display). Users see pass/fail in real time. Works identically for both OpenCode and Claude Code providers.

## Dashboard E2E Harness

The web dashboard can be tested against a deterministic local server instead of the user's live Tangerine instance.

### Server overrides

- `tangerine start --config <path>` or `TANGERINE_CONFIG=<path>` loads an alternate JSON config
- `tangerine start --db <path>` or `TANGERINE_DB=<path>` uses an alternate SQLite file
- `TEST_MODE=1` or `tangerine start --test-mode` enables gated `/api/test/*` routes

### Seeded state

- `POST /api/test/seed` wipes existing task/session/activity rows and inserts a fixture payload directly into SQLite
- `POST /api/test/reset` clears the seeded rows after screenshots or integration assertions
- Default fixtures live under `packages/server/src/test-fixtures/`

### Webhook simulation

- `POST /api/test/simulate-webhook` routes a GitHub issue payload through the same processing code as `/webhooks/github`
- Signature verification is skipped in test mode so local browser tests can create tasks from fixture payloads deterministically

## Future

- Require tests to pass before PR creation (gate)
- Visual regression testing (screenshot comparison)
- Test result summary in PR description
- Coverage reporting
