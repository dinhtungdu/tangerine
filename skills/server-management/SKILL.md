---
name: server-management
description: "Manage the Tangerine server: start, stop, or restart it in a tmux session. Use when the user says 'start tangerine', 'stop tangerine', 'restart tangerine', or '/server-management start|stop|restart'."
allowed-tools: Bash(tmux *)
---

# Tangerine Server Management

Manage the Tangerine dev server running in a tmux session named `tangerine`.

## Usage

The user will invoke this skill with an action argument: `start`, `stop`, or `restart`.

## Actions

### start

Start the server in a new tmux session (using `tangerine-watch` for auto-update support):

```bash
tmux new-session -d -s tangerine "bash /workspace/tangerine/repo/bin/tangerine-watch"
```

If the session already exists, inform the user it's already running. Check first with:

```bash
tmux has-session -t tangerine 2>/dev/null && echo "running" || echo "stopped"
```

### stop

Kill the tmux session:

```bash
tmux kill-session -t tangerine
```

If the session doesn't exist, inform the user it's not running.

### restart

Stop then start:

```bash
tmux kill-session -t tangerine 2>/dev/null; sleep 1; tmux new-session -d -s tangerine "bash /workspace/tangerine/repo/bin/tangerine-watch"
```

## After any action

Confirm the result to the user. On `start` or `restart`, verify the session exists:

```bash
tmux has-session -t tangerine 2>/dev/null && echo "running" || echo "stopped"
```
