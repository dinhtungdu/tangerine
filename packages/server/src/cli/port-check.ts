import { createConnection } from "net"
import { execSync } from "child_process"

export type PortStatus =
  | { status: "free" }
  | { status: "tangerine"; pid: number }
  | { status: "occupied"; pid: number | null; process: string | null }

/**
 * Probe whether a TCP port is in use, and if so, identify the owner.
 * Safe: never kills anything — only reads.
 */
export async function checkPort(port: number, hostname: string): Promise<PortStatus> {
  const inUse = await isPortInUse(port, hostname)
  if (!inUse) return { status: "free" }

  const owner = getPortOwner(port)
  if (!owner) return { status: "occupied", pid: null, process: null }

  if (isTangerineCommand(owner.command)) {
    return { status: "tangerine", pid: owner.pid }
  }

  return { status: "occupied", pid: owner.pid, process: owner.command }
}

function isPortInUse(port: number, hostname: string): Promise<boolean> {
  return new Promise((resolve) => {
    const conn = createConnection({ port, host: hostname === "0.0.0.0" ? "127.0.0.1" : hostname })
    conn.once("connect", () => {
      conn.destroy()
      resolve(true)
    })
    conn.once("error", () => {
      resolve(false)
    })
    conn.setTimeout(1000, () => {
      conn.destroy()
      resolve(false)
    })
  })
}

function getPortOwner(port: number): { pid: number; command: string } | null {
  try {
    const out = execSync(`lsof -ti :${port} -sTCP:LISTEN 2>/dev/null || true`, {
      encoding: "utf-8",
      timeout: 3000,
    }).trim()
    if (!out) return null

    const pid = parseInt(out.split("\n")[0]!, 10)
    if (isNaN(pid)) return null

    const command = execSync(`ps -p ${pid} -o args= 2>/dev/null || true`, {
      encoding: "utf-8",
      timeout: 3000,
    }).trim()

    return { pid, command }
  } catch {
    return null
  }
}

function isTangerineCommand(command: string): boolean {
  return command.includes("tangerine")
}

export type PortPreflightResult =
  | { ok: true }
  | { ok: false; message: string; alreadyRunning: boolean }

/**
 * Run preflight checks for all ports Tangerine needs.
 * Returns a result with a user-facing message if any port is blocked.
 */
export async function preflightPorts(
  httpPort: number,
  sslPort: number | null,
  hostname: string,
): Promise<PortPreflightResult> {
  const ports = [{ port: httpPort, label: "HTTP" }]
  if (sslPort !== null) {
    ports.push({ port: sslPort, label: "HTTPS" })
  }

  for (const { port, label } of ports) {
    const result = await checkPort(port, hostname)

    if (result.status === "tangerine") {
      return {
        ok: false,
        alreadyRunning: true,
        message: `Tangerine is already running on ${label} port ${port} (PID ${result.pid}).`,
      }
    }

    if (result.status === "occupied") {
      const who = result.process
        ? `${result.process} (PID ${result.pid})`
        : result.pid
          ? `PID ${result.pid}`
          : "unknown process"
      return {
        ok: false,
        alreadyRunning: false,
        message:
          `${label} port ${port} is already in use by ${who}. ` +
          `Free the port or set a different ${label === "HTTPS" ? "ssl.port" : "port"} in config.json.`,
      }
    }
  }

  return { ok: true }
}
