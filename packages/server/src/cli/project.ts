import { readRawConfig, writeRawConfig, resolveConfigPath } from "../config.ts"
import { printTable } from "./helpers.ts"
import { createLogger } from "../logger.ts"

const log = createLogger("cli:project")

export async function runProject(argv: string[]): Promise<void> {
  const subcommand = argv[0]

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    console.log(`
Usage: tangerine project <subcommand>

Subcommands:
  add           Register a project
  list          List registered projects
  remove        Remove a project by name
  show <name>   Show project config details

Options for add:
  --name <name>           Project name (required)
  --repo <url>            Git repo URL (required)
  --setup <cmd>           Setup command run each session (required)
  --branch <branch>       Default branch (default: main)
  --test <cmd>            Test command (optional)

Examples:
  tangerine project add --name my-app --repo https://github.com/me/my-app --setup "npm install && npm run dev"
  tangerine project add --name wp --repo https://github.com/me/wp --setup "npm run env:start" --branch trunk
  tangerine project list
  tangerine project show my-app
  tangerine project remove my-app
`)
    process.exit(0)
  }

  switch (subcommand) {
    case "add":
      await addProject(argv.slice(1))
      break
    case "list":
      listProjects()
      break
    case "show":
      showProject(argv[1])
      break
    case "remove":
      removeProject(argv[1])
      break
    default:
      console.error(`Unknown project subcommand: ${subcommand}`)
      process.exit(1)
  }
}

async function addProject(argv: string[]): Promise<void> {
  const { parseArgs } = await import("./helpers.ts")
  const parsed = parseArgs(argv, {
    name: { alias: "n", required: true },
    repo: { alias: "r", required: true },
    setup: { alias: "s", required: true },
    branch: { alias: "b" },
    test: { alias: "t" },
  })

  const name = parsed.flags["name"]!
  const repo = parsed.flags["repo"]!
  const setup = parsed.flags["setup"]!
  const defaultBranch = parsed.flags["branch"] ?? "main"
  const test = parsed.flags["test"]

  const config = readRawConfig()
  const configPath = resolveConfigPath()

  if (!config.projects) {
    config.projects = []
  }

  // Check for duplicate
  if (config.projects.some((p) => p.name === name)) {
    console.error(`Project "${name}" already exists. Remove it first to re-add.`)
    process.exit(1)
  }

  const project: Record<string, unknown> = {
    name,
    repo,
    defaultBranch,
    setup,
  }

  if (test) {
    project.test = test
  }

  config.projects.push(project)
  writeRawConfig(config)

  console.log(`Project "${name}" added to ${configPath}`)
  log.info("Project registered", { name, repo })
}

function listProjects(): void {
  const config = readRawConfig()
  const projects = config.projects ?? []

  if (projects.length === 0) {
    console.log("No projects registered. Add one with: tangerine project add")
    return
  }

  printTable(
    ["NAME", "REPO", "BRANCH"],
    projects.map((p) => [
      String(p.name ?? ""),
      String(p.repo ?? ""),
      String(p.defaultBranch ?? "main"),
    ])
  )
}

function showProject(name: string | undefined): void {
  if (!name) {
    console.error("Usage: tangerine project show <name>")
    process.exit(1)
  }

  const config = readRawConfig()
  const projects = config.projects ?? []
  const project = projects.find((p) => p.name === name)

  if (!project) {
    console.error(`Project "${name}" not found.`)
    const names = projects.map((p) => String(p.name)).join(", ")
    if (names) console.error(`Available: ${names}`)
    process.exit(1)
  }

  console.log(JSON.stringify(project, null, 2))
}

function removeProject(name: string | undefined): void {
  if (!name) {
    console.error("Usage: tangerine project remove <name>")
    process.exit(1)
  }

  const config = readRawConfig()
  const projects = config.projects ?? []
  const index = projects.findIndex((p) => p.name === name)

  if (index === -1) {
    console.error(`Project "${name}" not found.`)
    process.exit(1)
  }

  projects.splice(index, 1)
  config.projects = projects
  writeRawConfig(config)

  console.log(`Project "${name}" removed.`)
  log.info("Project removed", { name })
}
