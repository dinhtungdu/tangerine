# Tangerine Deployment

Scripts to provision a Tangerine server on a Lima VM (local) or a VPS.

## Files

- `tangerine.yaml` — Lima VM template (Debian 13, VZ framework, no provisioning)
- `base-setup.sh` — Installs Node.js, Bun, pnpm, gh, PHP, OpenCode, Claude Code, etc.

## Local (Lima)

```bash
# 1. Create the VM
limactl start --name=tangerine deploy/tangerine.yaml

# 2. Copy and run base-setup.sh
limactl copy deploy/base-setup.sh tangerine:/tmp/base-setup.sh
limactl shell tangerine sudo bash /tmp/base-setup.sh

# 3. Clone and install Tangerine
limactl shell tangerine bash -c "
  cd /workspace
  git clone https://github.com/user/tangerine.git
  cd tangerine
  bun install
"

# 4. Initialize and start
limactl shell tangerine bash -c "
  cd /workspace/tangerine
  bun run tangerine init
  bun run tangerine start
"
```

## VPS (Debian/Ubuntu)

```bash
# 1. Copy and run base-setup.sh
scp deploy/base-setup.sh user@server:/tmp/
ssh user@server 'sudo bash /tmp/base-setup.sh'

# 2. Clone and install Tangerine
ssh user@server bash -c "
  cd /workspace
  git clone https://github.com/user/tangerine.git
  cd tangerine
  bun install
"

# 3. Initialize and start
ssh user@server bash -c "
  cd /workspace/tangerine
  bun run tangerine init
  bun run tangerine start
"
```

## What base-setup.sh installs

| Tool | Version/Source |
|------|---------------|
| Node.js | 22 LTS (nodesource) |
| pnpm | latest (via npm) |
| Bun | latest (bun.sh) |
| GitHub CLI | latest (gh apt repo) |
| PHP + Composer | php-cli from apt, composer from getcomposer.org |
| OpenCode | latest (npm global) |
| Claude Code | latest (npm global) |
| tmux, git, curl, jq, unzip | apt |

It also configures SSH (key-only auth, GatewayPorts clientspecified), disables IPv6 (Lima VZ workaround), creates `/workspace`, and sets `git safe.directory '*'`.
