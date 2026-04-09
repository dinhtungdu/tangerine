#!/usr/bin/env bash
# Tangerine base setup — installs all common tools for Tangerine server VMs.
# Works on: Lima VMs (local), VPS (Debian/Ubuntu), any Debian-based system.
# Must be run as root (sudo).
set -eux -o pipefail
export DEBIAN_FRONTEND=noninteractive
export HOME="${HOME:-/root}"

# --- IPv6 workaround (Lima VZ shared networking has broken IPv6) ---
sysctl -w net.ipv6.conf.all.disable_ipv6=1
sysctl -w net.ipv6.conf.default.disable_ipv6=1
echo 'net.ipv6.conf.all.disable_ipv6 = 1' >> /etc/sysctl.d/99-disable-ipv6.conf
echo 'net.ipv6.conf.default.disable_ipv6 = 1' >> /etc/sysctl.d/99-disable-ipv6.conf

# --- System packages ---
apt-get update -qq
apt-get upgrade -y -qq

apt-get install -y -qq \
  git \
  curl \
  jq \
  openssh-server \
  dtach \
  unzip \
  ca-certificates \
  gnupg

# --- Node.js 22 LTS via nodesource ---
mkdir -p /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
  | gpg --batch --dearmor -o /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
  > /etc/apt/sources.list.d/nodesource.list
apt-get update -qq
apt-get install -y -qq nodejs

# --- GitHub CLI (gh) ---
mkdir -p -m 755 /etc/apt/keyrings
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null
chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  > /etc/apt/sources.list.d/github-cli.list
apt-get update -qq
apt-get install -y -qq gh

# --- pnpm ---
npm install -g pnpm

# --- PHP + Composer ---
apt-get install -y -qq php-cli php-xml php-mbstring php-curl
curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer

# --- OpenCode ---
npm install -g opencode-ai

# --- Claude Code CLI ---
npm install -g @anthropic-ai/claude-code

# --- Bun runtime ---
curl -fsSL https://bun.sh/install | bash
# Make bun available system-wide (copy, not symlink — /root is 700)
cp /root/.bun/bin/bun /usr/local/bin/bun
cp /root/.bun/bin/bunx /usr/local/bin/bunx

# --- Workspace directory ---
REAL_USER="${SUDO_USER:-$(logname 2>/dev/null || echo root)}"
mkdir -p /workspace
chown "$REAL_USER":"$REAL_USER" /workspace

# --- Git config ---
git config --system safe.directory '*'

# --- SSH hardening ---
sed -i 's/^#\?GatewayPorts.*/GatewayPorts clientspecified/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config

# --- Cleanup ---
apt-get clean
rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# --- Verify ---
echo "==> Verifying base setup"
echo "node:     $(node --version)"
echo "npm:      $(npm --version)"
echo "pnpm:     $(pnpm --version)"
echo "bun:      $(bun --version)"
echo "gh:       $(gh --version 2>/dev/null | head -1)"
echo "php:      $(php --version 2>/dev/null | head -1)"
echo "composer: $(composer --version 2>/dev/null | head -1)"
echo "dtach:    $(dtach --help 2>&1 | head -1 || echo 'not found')"
echo "opencode: $(which opencode 2>/dev/null || echo 'not found')"
echo "claude:   $(which claude 2>/dev/null || echo 'not found')"
echo "==> Base setup complete"
