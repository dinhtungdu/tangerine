import { loadConfig } from "../config.ts"
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
  build         Build a golden image from .tangerine/build.sh
  list          List available images
`)
    process.exit(0)
  }

  switch (subcommand) {
    case "build":
      await buildImageCmd()
      break
    case "list":
      await listAvailableImages()
      break
    default:
      console.error(`Unknown image subcommand: ${subcommand}`)
      process.exit(1)
  }
}

async function buildImageCmd(): Promise<void> {
  const config = loadConfig()
  const name = config.config.project.image

  log.info("Building image", { name, project: config.config.project.name })

  try {
    const { buildImage: build } = await import("../image/build.ts")
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
