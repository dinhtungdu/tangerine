import { printHelp } from "./helpers.ts"

const args = process.argv.slice(2)
const command = args[0]

async function main(): Promise<void> {
  if (!command || command === "--help" || command === "-h") {
    printHelp()
    process.exit(0)
  }

  switch (command) {
    case "start": {
      const { start } = await import("./start.ts")
      await start()
      break
    }
    case "task": {
      const { runTask } = await import("./task.ts")
      await runTask(args.slice(1))
      break
    }
    case "project": {
      const { runProject } = await import("./project.ts")
      await runProject(args.slice(1))
      break
    }
    case "config": {
      const { runConfig } = await import("./config.ts")
      await runConfig(args.slice(1))
      break
    }
    case "install": {
      const { install } = await import("./install.ts")
      await install()
      break
    }
    default:
      console.error(`Unknown command: ${command}`)
      printHelp()
      process.exit(1)
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
