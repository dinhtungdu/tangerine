import { existsSync } from "fs"
import { loadConfig } from "../config.ts"
import { getDb } from "../db/index.ts"
import { listImages } from "../db/queries.ts"
import { Effect } from "effect"
import { createLogger } from "../logger.ts"
import { parseArgs, printTable } from "./helpers.ts"

const log = createLogger("cli:image")

export async function runImage(argv: string[]): Promise<void> {
  const subcommand = argv[0]

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    console.log(`
Usage: tangerine image <subcommand>

Subcommands:
  build [--project <name>]   Build a golden image (from ~/tangerine/images/<image>/build.sh)
  list                       List available images
  init <image-name>          Create a build.sh template for an image

Build script location: ~/tangerine/images/<image-name>/build.sh
`)
    process.exit(0)
  }

  switch (subcommand) {
    case "build":
      await buildImageCmd(argv.slice(1))
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

async function buildImageCmd(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv, {
    project: { alias: "p" },
  })

  const config = loadConfig()
  const projectId = parsed.flags["project"] || parsed.command
  const project = projectId
    ? config.config.projects.find((p) => p.name === projectId)
    : config.config.projects[0]!

  if (!project) {
    console.error(`Unknown project: ${projectId}`)
    console.error(`Available: ${config.config.projects.map((p) => p.name).join(", ")}`)
    process.exit(1)
  }

  const name = project.image
  log.info("Building image", { name, project: project.name })

  try {
    const { buildImage: build, imageDir } = await import("../image/build.ts")
    const buildScript = `${imageDir(name)}/build.sh`
    if (!existsSync(buildScript)) {
      console.log(`No build script at ${buildScript}`)
      console.log(`Create one with: tangerine image init ${name}`)
    }
    await build(name)
    log.info("Image built successfully", { name })
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

# ${imageName} golden image build script.
# Runs inside the VM after the base tangerine.yaml provisioning.
#
# Base image already provides:
#   git, curl, wget, jq, build-essential, openssh-server,
#   Node.js (nvm), npm, OpenCode, gh CLI, ripgrep, fd-find,
#   Docker, Docker Compose

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
echo "${imageName} image build complete."
`
  writeFileSync(buildScript, template, { mode: 0o755 })
  console.log(`Created: ${buildScript}`)
  console.log(`Edit it, then run: tangerine image build`)
}

async function listAvailableImages(): Promise<void> {
  const db = getDb()
  const images = Effect.runSync(listImages(db))

  if (images.length === 0) {
    console.log("No images found. Build one with: tangerine image build <name>")
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
