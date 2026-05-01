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
      const foreground = args.includes("--foreground")
      if (foreground) {
        const { start } = await import("./start.ts")
        await start()
      } else {
        const { daemonStart } = await import("./daemon.ts")
        await daemonStart()
      }
      break
    }
    case "stop": {
      const { daemonStop } = await import("./daemon.ts")
      await daemonStop()
      break
    }
    case "status": {
      const { daemonStatus } = await import("./daemon.ts")
      await daemonStatus()
      break
    }
    case "_daemon-loop": {
      const { daemonLoop } = await import("./daemon.ts")
      await daemonLoop()
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
    case "secret": {
      const { runSecret } = await import("./secret.ts")
      await runSecret(args.slice(1))
      break
    }
    case "install": {
      const { install } = await import("./install.ts")
      await install()
      break
    }
    case "migrate": {
      const { runMigrate } = await import("./migrate.ts")
      await runMigrate(args.slice(1))
      break
    }
    case "acp": {
      const { runAcp } = await import("./acp.ts")
      await runAcp(args.slice(1))
      break
    }
    case "logs": {
      const { runLogs } = await import("./logs.ts")
      await runLogs(args.slice(1))
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
