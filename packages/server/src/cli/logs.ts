import { existsSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { spawn } from "child_process"

const LOG_FILE = join(homedir(), "tangerine", "tangerine.log")

export async function runLogs(args: string[]): Promise<void> {
  let lines = 50

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--lines" || args[i] === "-n") {
      const val = parseInt(args[i + 1] ?? "", 10)
      if (isNaN(val) || val < 1) {
        console.error("--lines requires a positive integer")
        process.exit(1)
      }
      lines = val
      i++
    }
  }

  if (!existsSync(LOG_FILE)) {
    console.error(`Log file not found: ${LOG_FILE}`)
    console.error("Has the server been started? Run: tangerine start")
    process.exit(1)
  }

  const tail = spawn("tail", ["-n", String(lines), "-f", LOG_FILE], {
    stdio: "inherit",
  })

  // Forward signals so Ctrl-C terminates cleanly
  process.on("SIGINT", () => {
    tail.kill("SIGINT")
  })
  process.on("SIGTERM", () => {
    tail.kill("SIGTERM")
  })

  await new Promise<void>((resolve, reject) => {
    tail.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(new Error("'tail' command not found — cannot follow log file"))
      } else {
        reject(err)
      }
    })
    tail.on("exit", () => resolve())
  })
}
