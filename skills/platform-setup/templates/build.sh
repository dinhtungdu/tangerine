#!/usr/bin/env bash
set -euo pipefail

# <IMAGE_NAME> golden image build script.
# Runs inside the VM after the base tangerine.yaml provisioning.
#
# Base image already provides:
#   git, curl, wget, jq, build-essential, openssh-server,
#   Node.js 22 (nvm), npm, Bun, OpenCode, Claude Code,
#   gh CLI, ripgrep, fd-find, Docker, Docker Compose

export DEBIAN_FRONTEND=noninteractive

# --- Runtime / Language ---

# --- System Packages ---

# --- Global Tools ---

# --- Cleanup ---
sudo apt-get clean
sudo rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# --- Verify ---
echo "==> Verifying installations"

echo ""
echo "<IMAGE_NAME> image build complete."
