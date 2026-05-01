// Daemon management: start/stop/status for background Tangerine server.
// The daemon is a launcher process that holds a restart loop — on crash it
// respawns the server child, on clean exit (code 0) it stops.

import { spawn, execSync } from "child_process"
import { existsSync, readFileSync, writeFileSync, writeSync, unlinkSync, mkdirSync, openSync, constants as fsConstants } from "fs"
import { join } from "path"
import { homedir } from "os"
import { DAEMON_RESTART_EXIT_CODE, DAEMON_FATAL_EXIT_CODE, shouldRestartDaemon } from "../daemon-exit"
import { applyLoginShellPath, checkSystemTools } from "./system-check"
import { isGithubRepo } from "@tangerine/shared"
import { createAgentFactories } from "../agent/factories"
import { getStartupAuthError, getStartupAuthWarning } from "../auth"
import { preflightPorts } from "./port-check"

const TANGERINE_DIR = join(homedir(), "tangerine")
const PID_FILE = join(TANGERINE_DIR, "tangerine.pid")
const LOG_FILE = join(TANGERINE_DIR, "tangerine.log")

/** Check whether a process with the given PID is alive. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Verify that a PID belongs to a Tangerine process (not a reused PID). */
function isTangerineProcess(pid: number): boolean {
  if (!isProcessAlive(pid)) return false
  try {
    const cmdline = execSync(`ps -p ${pid} -o args=`, { encoding: "utf-8" }).trim()
    return cmdline.includes("tangerine")
  } catch {
    // ps failed — can't verify, treat as not ours
    return false
  }
}

/** Read PID from file. Returns null if missing or stale. */
function readPid(): number | null {
  if (!existsSync(PID_FILE)) return null
  const raw = readFileSync(PID_FILE, "utf-8").trim()
  const pid = parseInt(raw, 10)
  if (isNaN(pid)) return null
  return pid
}

/** Resolve the path to the `tangerine` bin entry point.
 *  Uses process.argv[1] which is the script that was invoked (e.g. bin/tangerine),
 *  so it works whether running from source or via npm global install. */
function getBinPath(): string {
  return process.argv[1]!
}

// ── Commands ────────────────────────────────────────────────────────

export async function daemonStart(): Promise<void> {
  // Validate config before spawning so errors surface immediately instead of
  // silently failing inside the detached daemon process.
  const { loadConfig } = await import("../config.ts")
  const config = loadConfig()
  const port = config.credentials.serverPort
  const ssl = config.credentials.ssl
  const hostname = process.env.HOST ?? "0.0.0.0"

  const existingPid = readPid()
  if (existingPid !== null && isTangerineProcess(existingPid)) {
    console.log(`Tangerine is already running (PID ${existingPid}).`)
    process.exit(0)
  }

  const startupAuthError = getStartupAuthError(config, hostname)
  if (startupAuthError) {
    console.error(`ERROR ${startupAuthError}`)
    process.exit(1)
  }

  const startupAuthWarning = getStartupAuthWarning(config, hostname)
  if (startupAuthWarning) {
    console.warn(`WARN ${startupAuthWarning}`)
  }

  // Port preflight: detect occupied ports before spawning the daemon.
  const portResult = await preflightPorts(port, ssl?.port ?? null, hostname)
  if (!portResult.ok) {
    if (portResult.alreadyRunning) {
      console.log(portResult.message)
      process.exit(0)
    }
    console.error(`ERROR ${portResult.message}`)
    process.exit(1)
  }

  // Run system checks before spawning so errors and warnings appear in the
  // user's terminal — the detached server process writes to the log file.
  applyLoginShellPath()
  const factories = createAgentFactories({ agents: config.config.agents })
  const { errors, warnings } = checkSystemTools({
    hasGithubProject: config.config.projects.some((p) => isGithubRepo(p.repo)),
    providers: Object.entries(factories).map(([id, factory]) => ({ id, cliCommand: factory.metadata.cliCommand })),
  })

  if (errors.length > 0) {
    for (const msg of errors) console.error(`ERROR ${msg}`)
    console.error("Fix the above issues and restart the server.")
    process.exit(1)
  }

  // Clean up stale PID file
  if (existingPid !== null) {
    unlinkSync(PID_FILE)
  }

  mkdirSync(TANGERINE_DIR, { recursive: true })

  // Spawn the launcher as a detached process
  const binPath = getBinPath()
  const child = spawn(process.execPath, [binPath, "_daemon-loop"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  })

  child.unref()

  const pid = child.pid
  if (pid === undefined) {
    console.error("Failed to start daemon.")
    process.exit(1)
  }

  writeFileSync(PID_FILE, String(pid))

  const warningLines = warnings.length > 0
    ? `\n  Warnings:\n${warnings.map((w) => `    WARN ${w}`).join("\n")}\n`
    : ""

  const httpsLine = ssl
    ? `  HTTPS:      https://localhost:${ssl.port}\n  HTTP:       http://localhost:${port} (plaintext fallback)`
    : `  Dashboard:  http://localhost:${port}`

  console.log(`
Tangerine is running!
${warningLines}
${httpsLine}

  Commands:
    tangerine stop       Stop the server
    tangerine status     Check server status
    tangerine logs       View server logs
`)
}

export async function daemonStop(): Promise<void> {
  const pid = readPid()
  if (pid === null || !isTangerineProcess(pid)) {
    console.log("Tangerine is not running.")
    // Clean up stale PID file if present
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE)
    process.exit(0)
  }

  // Send SIGTERM to the process group (negative PID kills the group)
  try {
    process.kill(-pid, "SIGTERM")
  } catch {
    // Fallback: kill just the launcher
    try {
      process.kill(pid, "SIGTERM")
    } catch {
      // Already dead
    }
  }

  // Wait briefly for shutdown
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await new Promise((r) => setTimeout(r, 200))
  }

  if (isProcessAlive(pid)) {
    // Force kill
    try {
      process.kill(-pid, "SIGKILL")
    } catch {
      try { process.kill(pid, "SIGKILL") } catch { /* */ }
    }
  }

  if (existsSync(PID_FILE)) unlinkSync(PID_FILE)
  console.log("Tangerine stopped.")
}

export async function daemonStatus(): Promise<void> {
  const pid = readPid()
  if (pid === null) {
    console.log("Tangerine is not running.")
    process.exit(1)
  }

  if (isTangerineProcess(pid)) {
    console.log(`Tangerine is running (PID ${pid}).`)
  } else {
    console.log("Tangerine is not running (stale PID file).")
    unlinkSync(PID_FILE)
    process.exit(1)
  }
}

// ── Launcher loop (internal — run by `_daemon-loop`) ────────────────

export async function daemonLoop(): Promise<void> {
  mkdirSync(TANGERINE_DIR, { recursive: true })

  // Redirect own stdout/stderr to log file so any uncaught errors are captured
  const logFd = openSync(LOG_FILE, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND)

  const binPath = getBinPath()

  const spawnServer = (): ReturnType<typeof spawn> => {
    const child = spawn(process.execPath, [binPath, "start", "--foreground"], {
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env },
    })
    return child
  }

  // Handle SIGTERM — clean exit without restart
  let stopping = false
  const onSignal = () => {
    stopping = true
  }
  process.on("SIGTERM", onSignal)
  process.on("SIGINT", onSignal)

  // Circuit breaker: if the server crashes too many times in a short window,
  // stop restarting to avoid a tight crash loop.
  const MAX_CRASHES = 5
  const CRASH_WINDOW_MS = 60_000
  const crashTimestamps: number[] = []
  let backoffMs = 1000

  // Restart loop
  while (!stopping) {
    const child = spawnServer()

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code))
      const killChild = () => {
        stopping = true
        child.kill("SIGTERM")
      }
      process.on("SIGTERM", killChild)
      process.on("SIGINT", killChild)
      child.on("exit", () => {
        process.removeListener("SIGTERM", killChild)
        process.removeListener("SIGINT", killChild)
      })
    })

    if (stopping) break

    if (!shouldRestartDaemon(exitCode)) {
      if (exitCode === DAEMON_FATAL_EXIT_CODE) {
        const msg = `[${new Date().toISOString()}] Server exited with fatal error (code ${exitCode}), not restarting. Check logs: tangerine logs\n`
        writeSync(logFd, msg)
      }
      break
    }

    // Track crash timestamps for circuit breaker
    const now = Date.now()
    crashTimestamps.push(now)
    // Evict old entries outside the window
    while (crashTimestamps.length > 0 && crashTimestamps[0]! < now - CRASH_WINDOW_MS) {
      crashTimestamps.shift()
    }

    const timestamp = new Date().toISOString()
    const reason = exitCode === DAEMON_RESTART_EXIT_CODE ? "requested restart" : `code ${exitCode}`

    if (exitCode !== DAEMON_RESTART_EXIT_CODE && crashTimestamps.length >= MAX_CRASHES) {
      const msg = `[${timestamp}] Server crashed ${MAX_CRASHES} times in ${CRASH_WINDOW_MS / 1000}s — stopping to prevent crash loop. Check logs: tangerine logs\n`
      writeSync(logFd, msg)
      break
    }

    // Explicit restart request — no backoff needed
    if (exitCode === DAEMON_RESTART_EXIT_CODE) {
      const msg = `[${timestamp}] Server exited with ${reason}, restarting...\n`
      writeSync(logFd, msg)
      continue
    }

    // Crash — apply exponential backoff
    const msg = `[${timestamp}] Server exited with ${reason}, restarting in ${backoffMs}ms...\n`
    writeSync(logFd, msg)
    await new Promise((r) => setTimeout(r, backoffMs))
    backoffMs = Math.min(backoffMs * 2, 30_000)
  }

  // Cleanup PID file on exit
  if (existsSync(PID_FILE)) unlinkSync(PID_FILE)
  process.exit(0)
}
