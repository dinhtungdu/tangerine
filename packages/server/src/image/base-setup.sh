#!/usr/bin/env bash
# Tangerine base setup — installs common tools needed by all project VMs.
# Runs via SSH on first VM provisioning (before project-specific build.sh).
# Must be run as root (sudo).
set -eux -o pipefail
export DEBIAN_FRONTEND=noninteractive

# Disable IPv6 — Lima VZ shared networking has broken IPv6 causing ~150x slower downloads
sysctl -w net.ipv6.conf.all.disable_ipv6=1
sysctl -w net.ipv6.conf.default.disable_ipv6=1
echo 'net.ipv6.conf.all.disable_ipv6 = 1' >> /etc/sysctl.d/99-disable-ipv6.conf
echo 'net.ipv6.conf.default.disable_ipv6 = 1' >> /etc/sysctl.d/99-disable-ipv6.conf

apt-get update -qq
apt-get upgrade -y -qq

apt-get install -y -qq \
  git \
  curl \
  jq \
  openssh-server \
  tmux \
  unzip \
  ca-certificates \
  gnupg

# Node.js 22 LTS via nodesource
mkdir -p /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
  | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
  > /etc/apt/sources.list.d/nodesource.list
apt-get update -qq
apt-get install -y -qq nodejs

# GitHub CLI (gh)
mkdir -p -m 755 /etc/apt/keyrings
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null
chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  > /etc/apt/sources.list.d/github-cli.list
apt-get update -qq
apt-get install -y -qq gh

# SSH — key-only auth, allow reverse tunnels to bind specific addresses
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?GatewayPorts.*/GatewayPorts clientspecified/' /etc/ssh/sshd_config

# PHP + Composer
apt-get install -y -qq php-cli php-xml php-mbstring php-curl
curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer

# pnpm
npm install -g pnpm

# Install OpenCode globally
npm install -g opencode-ai

# Install Claude Code CLI
npm install -g @anthropic-ai/claude-code

# Workspace directory
mkdir -p /workspace

# Cleanup
apt-get clean
rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# Install tangerine-task CLI
cat > /usr/local/bin/tangerine-task << 'SCRIPT'
#!/bin/bash
# tangerine-task — CLI for cross-project task creation from inside a Tangerine VM.
set -euo pipefail

PORT="${TANGERINE_SERVER_PORT:-3456}"
BASE="http://127.0.0.2:${PORT}"
TASK_ID="${TANGERINE_TASK_ID:-}"

usage() {
  echo "Usage: tangerine-task <command> [options]"
  echo ""
  echo "Commands:"
  echo "  projects              List available projects"
  echo "  create [options]      Create a task in another project"
  echo ""
  echo "Create options:"
  echo "  --project <name>      Target project (required)"
  echo "  --title <text>        Task title (required)"
  echo "  --description <text>  Task description"
  echo "  --provider <name>     Agent provider (opencode|claude-code)"
  echo "  --model <id>          Model override"
  exit 1
}

cmd_projects() {
  response=$(curl -sf "${BASE}/api/projects" 2>&1) || {
    echo "✗ Server unreachable (is the tunnel up?)" >&2
    exit 1
  }
  echo "$response" | jq -r '.projects[].name'
}

cmd_create() {
  local project="" title="" description="" provider="" model=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --project)    project="$2"; shift 2 ;;
      --title)      title="$2"; shift 2 ;;
      --description) description="$2"; shift 2 ;;
      --provider)   provider="$2"; shift 2 ;;
      --model)      model="$2"; shift 2 ;;
      *) echo "✗ Unknown option: $1" >&2; exit 1 ;;
    esac
  done

  if [[ -z "$project" || -z "$title" ]]; then
    echo "✗ --project and --title are required" >&2
    exit 1
  fi

  if [[ -n "$TASK_ID" && -n "$description" ]]; then
    description="${description}

---
Created from task ${TASK_ID}"
  elif [[ -n "$TASK_ID" && -z "$description" ]]; then
    description="Created from task ${TASK_ID}"
  fi

  payload=$(jq -n \
    --arg projectId "$project" \
    --arg title "$title" \
    --arg description "$description" \
    --arg provider "$provider" \
    --arg model "$model" \
    --arg source "cross-project" \
    --arg sourceId "$TASK_ID" \
    '{
      projectId: $projectId,
      title: $title,
      source: $source,
      sourceId: (if $sourceId != "" then $sourceId else null end),
      description: (if $description != "" then $description else null end),
      provider: (if $provider != "" then $provider else null end),
      model: (if $model != "" then $model else null end)
    } | with_entries(select(.value != null))')

  response=$(curl -sf -X POST "${BASE}/api/tasks" \
    -H "Content-Type: application/json" \
    -d "$payload" 2>&1) || {
    error=$(echo "$response" | jq -r '.error // empty' 2>/dev/null || true)
    if [[ -n "$error" ]]; then
      echo "✗ $error" >&2
    else
      echo "✗ Server unreachable or request failed" >&2
    fi
    exit 1
  }

  task_id=$(echo "$response" | jq -r '.id')
  echo "✓ Task created: ${task_id} in project ${project}"
}

[[ $# -lt 1 ]] && usage

case "$1" in
  projects) cmd_projects ;;
  create)   shift; cmd_create "$@" ;;
  -h|--help) usage ;;
  *) echo "✗ Unknown command: $1" >&2; usage ;;
esac
SCRIPT
chmod +x /usr/local/bin/tangerine-task

# Verify
echo "==> Verifying base setup"
echo "node: $(node --version)"
echo "npm: $(npm --version)"
echo "gh: $(gh --version 2>/dev/null | head -1 || echo 'not found')"
echo "tmux: $(tmux -V 2>/dev/null || echo 'not found')"
echo "opencode: $(which opencode 2>/dev/null || echo 'not found')"
echo "claude: $(which claude 2>/dev/null || echo 'not found')"
echo "==> Base setup complete"
