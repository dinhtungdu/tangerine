# v0 Scope

This file reflects the shipped baseline in the current codebase, not the original VM-era plan.

## In Scope

### Core Runtime

- [x] Single-machine local server architecture
- [x] Git worktrees for task isolation
- [x] Shared SQLite persistence for tasks, logs, and worktree slots
- [x] Worktree pool management and stale-slot reconciliation
- [x] Health monitoring, idle suspension, reconnect, and orphan cleanup

### Agents

- [x] ACP-only agent runtime with configured ACP-compatible commands
- [x] ACP event stream mapped to normalized task events
- [x] Prompt queueing while tasks are busy
- [x] Session resume across restart / reconnect flows
- [x] Runtime model and reasoning-effort updates

### Tasks

- [x] Manual task creation
- [x] GitHub-sourced task creation via webhook and polling
- [x] Cross-project prompting between tasks
- [x] Task types: `worker`, `reviewer`, `runner`
- [x] Crons: separate entity that spawns worker tasks on a schedule
- [x] Capabilities derived from type
- [x] Retry, cancel, resolve, complete, delete, and mark-seen actions
- [x] Parent/child task linkage

### API Server

- [x] REST routes for tasks, sessions, projects, system state, and test helpers
- [x] WebSocket task event stream
- [x] Terminal WebSocket support
- [x] Shared bearer-token auth for remote dashboard/API/WebSocket access
- [x] Static serving for the built dashboard
- [x] GitHub webhook signature verification

### Web Dashboard

- [x] Runs page with project switcher and grouped task list
- [x] Task detail page with chat, diff, tool calls, and terminal pane
- [x] Status page with system logs and predefined prompt editors
- [x] Provider, model, and reasoning-effort controls
- [x] Project update status and pull-latest flow

### CLI

- [x] `tangerine start`
- [x] `tangerine install`
- [x] `tangerine project add|list|show|remove`
- [x] `tangerine task create`
- [x] `tangerine secret set|get|list|delete`

## Out of Scope

- Managed VM lifecycle inside Tangerine
- SSH tunnels and remote agent spawning
- Golden image build flow as part of the active runtime
- Linear integration
- Hosted multi-user productization

## Notes

- The older VM/image architecture is preserved historically in older docs and the transition spec at [v1-local-server.md](./v1-local-server.md), but it is not the active source-of-truth runtime.
