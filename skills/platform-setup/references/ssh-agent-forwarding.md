# SSH Agent Forwarding for VMs

When Tangerine runs inside a VM with SSH agent forwarding (`ssh -A`), long-running processes (like `tangerine-watch`) lose access to the forwarded agent when the SSH connection drops and reconnects. The new connection creates a new socket, but the server still points to the old dead one — causing "permission denied" on git operations.

## Fix: Stable Symlink

### 1. Create `~/.ssh/rc` inside the VM

This runs on every SSH login and updates a stable symlink to the current agent socket:

```bash
#!/bin/bash
if [ -n "$SSH_AUTH_SOCK" ] && [ "$SSH_AUTH_SOCK" != "$HOME/.ssh/agent.sock" ]; then
    ln -sf "$SSH_AUTH_SOCK" "$HOME/.ssh/agent.sock"
fi
```

```bash
chmod +x ~/.ssh/rc
```

### 2. Update `bin/tangerine-watch`

Add this line at the top of the `while true` loop, before starting the server:

```bash
[ -S "$HOME/.ssh/agent.sock" ] && export SSH_AUTH_SOCK="$HOME/.ssh/agent.sock"
```

This ensures each server restart resolves to the latest agent socket.

### 3. Verify

After reconnecting to the VM:

```bash
ls -la ~/.ssh/agent.sock        # should show symlink to /tmp/ssh-*/agent.*
SSH_AUTH_SOCK=~/.ssh/agent.sock ssh -T git@github.com  # should authenticate
```

## Why This Happens

1. `ssh -A` forwards the macOS SSH agent into the VM via a socket (e.g. `/tmp/ssh-abc123/agent.456`)
2. `tangerine-watch` inherits `SSH_AUTH_SOCK` pointing to that socket
3. SSH connection drops/reconnects → new socket path (`/tmp/ssh-xyz789/agent.012`)
4. Server still holds the old path → git operations fail with "permission denied"

The symlink approach keeps a stable path (`~/.ssh/agent.sock`) that gets updated on each login.
