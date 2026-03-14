import { loadConfig } from "../config.ts"
import { getDb } from "../db/index.ts"
import { createLogger } from "../logger.ts"
import { parseArgs } from "./helpers.ts"

const log = createLogger("cli:task")

export async function runTask(argv: string[]): Promise<void> {
  const subcommand = argv[0]

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    console.log(`
Usage: tangerine task <subcommand>

Subcommands:
  create  Create a task manually

Options for create:
  --title <title>          Task title (required)
  --description <desc>     Task description (optional)
`)
    process.exit(0)
  }

  switch (subcommand) {
    case "create":
      await createTask(argv.slice(1))
      break
    default:
      console.error(`Unknown task subcommand: ${subcommand}`)
      process.exit(1)
  }
}

async function createTask(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv, {
    title: { alias: "t", required: true },
    description: { alias: "d" },
  })

  const title = parsed.flags["title"]!
  const description = parsed.flags["description"]

  const config = loadConfig()
  const db = getDb()

  const { createTask: dbCreateTask } = await import("../db/queries.ts")
  const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  const { Effect } = await import("effect")
  const task = Effect.runSync(dbCreateTask(db, {
    id,
    source: "manual",
    repo_url: config.config.project.repo,
    title,
    description,
  }))

  console.log(`Task created: ${task.id}`)
  log.info("Task created via CLI", { taskId: task.id, title })
}
