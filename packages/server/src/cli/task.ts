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
  --project <name>         Project name (defaults to first project)
  --title <title>          Task title (required)
  --description <desc>     Task description (optional)
  --branch <branch>        Existing branch name, PR URL, or #number (optional)
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
    project: { alias: "p" },
    title: { alias: "t", required: true },
    description: { alias: "d" },
    branch: { alias: "b" },
  })

  const title = parsed.flags["title"]!
  const description = parsed.flags["description"]
  const branch = parsed.flags["branch"]

  const config = loadConfig()
  const projectId = parsed.flags["project"] || config.config.projects[0]!.name
  const project = config.config.projects.find((p) => p.name === projectId)
  if (!project) {
    console.error(`Unknown project: ${projectId}`)
    console.error(`Available projects: ${config.config.projects.map((p) => p.name).join(", ")}`)
    process.exit(1)
  }

  const db = getDb()

  const { createTask: dbCreateTask } = await import("../db/queries.ts")
  const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  const { Effect } = await import("effect")
  const task = Effect.runSync(dbCreateTask(db, {
    id,
    project_id: projectId,
    source: "manual",
    title,
    description,
    branch,
  }))

  console.log(`Task created: ${task.id} (project: ${projectId})`)
  log.info("Task created via CLI", { taskId: task.id, projectId, title })
}
