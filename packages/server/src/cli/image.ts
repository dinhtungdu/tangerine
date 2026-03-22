import { existsSync } from "fs"
import { getDb } from "../db/index.ts"
import { listImages } from "../db/queries.ts"
import { Effect } from "effect"
import { createLogger } from "../logger.ts"
import { printTable } from "./helpers.ts"

const log = createLogger("cli:image")

export async function runImage(argv: string[]): Promise<void> {
  const subcommand = argv[0]

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    console.log(`
Usage: tangerine image <subcommand>

Subcommands:
  build-base                 Build the base VM from tangerine.yaml (~10 min)
  list                       List available images
  init <image-name>          Create a build.sh template for project setup

Build script location: ~/tangerine/images/<image-name>/build.sh
Project setup runs automatically on first VM provisioning.
`)
    process.exit(0)
  }

  switch (subcommand) {
    case "build-base":
      await buildBaseCmd()
      break
    case "list":
      await listAvailableImages()
      break
    case "init":
      await initImage(argv[1])
      break
    default:
      console.error(`Unknown image subcommand: ${subcommand}`)
      process.exit(1)
  }
}

async function buildBaseCmd(): Promise<void> {
  log.info("Building base VM from template")
  try {
    const { buildBase } = await import("../image/build.ts")
    await buildBase(log)
    log.info("Base VM built successfully")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND" ||
        (err as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") {
      console.error("Image build module not available (Phase 2 not yet built)")
      process.exit(1)
    }
    throw err
  }
}

async function initImage(imageName: string | undefined): Promise<void> {
  if (!imageName) {
    console.error("Usage: tangerine image init <image-name>")
    process.exit(1)
  }

  const { imageDir } = await import("../image/build.ts")
  const dir = imageDir(imageName)
  const buildScript = `${dir}/build.sh`

  if (existsSync(buildScript)) {
    console.log(`Build script already exists: ${buildScript}`)
    return
  }

  const { mkdirSync, writeFileSync } = await import("fs")
  mkdirSync(dir, { recursive: true })

  const template = `#!/usr/bin/env bash
set -euo pipefail

# ${imageName} project setup script.
# Runs inside the project VM on first provisioning (after cloning from base).
#
# Base image already provides:
#   git, curl, jq, openssh-server, tmux,
#   Node.js 22, npm, OpenCode, Claude Code, gh CLI

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
echo "${imageName} setup complete."
`
  writeFileSync(buildScript, template, { mode: 0o755 })
  console.log(`Created: ${buildScript}`)
  console.log(`This script runs automatically when a project VM is first provisioned.`)
}

async function listAvailableImages(): Promise<void> {
  const db = getDb()
  const images = Effect.runSync(listImages(db))

  if (images.length === 0) {
    console.log("No images found. Build base with: tangerine image build-base")
    return
  }

  printTable(
    ["NAME", "PROVIDER", "SNAPSHOT", "CREATED"],
    images.map((img) => [
      img.name,
      img.provider,
      img.snapshot_id.slice(0, 12),
      img.created_at,
    ])
  )
}
