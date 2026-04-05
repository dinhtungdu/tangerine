// Structured logger with correlation IDs, operation spans, and child loggers
// so AI agents can grep by taskId/vmId and reconstruct full timelines.

import { INFRA_LOGGERS, writeSystemLog } from "./system-log"

type LogLevel = "debug" | "info" | "warn" | "error"

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

// ANSI colors for dev-mode pretty printing
const COLORS: Record<LogLevel, string> = {
  debug: "\x1b[90m",  // gray
  info: "\x1b[36m",   // cyan
  warn: "\x1b[33m",   // yellow
  error: "\x1b[31m",  // red
}
const RESET = "\x1b[0m"
const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"

function getLogLevel(): LogLevel {
  const env = process.env.LOG_LEVEL?.toLowerCase()
  if (env && env in LOG_LEVELS) return env as LogLevel
  return "info"
}

function isPrettyMode(): boolean {
  return process.env.NODE_ENV !== "production"
}

function formatPrettyLine(level: LogLevel, loggerName: string, msg: string, context: Record<string, unknown>): string {
  const color = COLORS[level]
  const ts = new Date().toISOString().slice(11, 23) // HH:MM:SS.mmm
  const levelTag = level.toUpperCase().padEnd(5)

  // Pull out common correlation fields for the prefix
  const { taskId, vmId, op, durationMs, ...rest } = context
  const parts: string[] = []

  if (taskId) parts.push(`task=${taskId}`)
  if (vmId) parts.push(`vm=${vmId}`)
  if (op) parts.push(`op=${op}`)
  if (durationMs !== undefined) parts.push(`${durationMs}ms`)

  const prefix = parts.length > 0 ? ` ${DIM}[${parts.join(" ")}]${RESET}` : ""
  const extra = Object.keys(rest).length > 0 ? ` ${DIM}${JSON.stringify(rest)}${RESET}` : ""

  return `${DIM}${ts}${RESET} ${color}${levelTag}${RESET} ${BOLD}${loggerName}${RESET}${prefix} ${msg}${extra}`
}

export interface OpSpan {
  end(extraContext?: Record<string, unknown>): void
  fail(error: unknown, extraContext?: Record<string, unknown>): void
}

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void
  info(message: string, context?: Record<string, unknown>): void
  warn(message: string, context?: Record<string, unknown>): void
  error(message: string, context?: Record<string, unknown>): void
  child(context: Record<string, unknown>): Logger
  startOp(name: string, context?: Record<string, unknown>): OpSpan
}

function makeLogger(loggerName: string, baseContext: Record<string, unknown>): Logger {
  const minLevel = LOG_LEVELS[getLogLevel()]
  const pretty = isPrettyMode()

  function emit(level: LogLevel, msg: string, context?: Record<string, unknown>): void {
    if (LOG_LEVELS[level] < minLevel) return

    const merged = { ...baseContext, ...context }
    const entry = {
      ts: new Date().toISOString(),
      level,
      logger: loggerName,
      msg,
      ...merged,
    }

    // Persist infra logs to SQLite for the Status page
    if (INFRA_LOGGERS.has(loggerName)) {
      writeSystemLog(level, loggerName, msg, merged)
    }

    const json = JSON.stringify(entry)

    if (pretty) {
      const prettyLine = formatPrettyLine(level, loggerName, msg, merged)
      if (level === "error") {
        console.error(prettyLine)
        console.error(json)
      } else if (level === "warn") {
        console.warn(prettyLine)
        console.warn(json)
      } else {
        console.log(prettyLine)
        console.log(json)
      }
    } else {
      // Production: JSON-only output for machine parsing
      if (level === "error") {
        console.error(json)
      } else if (level === "warn") {
        console.warn(json)
      } else {
        console.log(json)
      }
    }
  }

  function startOp(name: string, context?: Record<string, unknown>): OpSpan {
    const startTime = performance.now()
    const opContext = { ...context, op: name }

    emit("info", `${name} started`, opContext)

    return {
      end(extraContext?: Record<string, unknown>) {
        const durationMs = Math.round(performance.now() - startTime)
        emit("info", `${name} completed`, { ...opContext, ...extraContext, durationMs })
      },
      fail(error: unknown, extraContext?: Record<string, unknown>) {
        const durationMs = Math.round(performance.now() - startTime)
        const errorMessage = error instanceof Error ? error.message : String(error)
        emit("error", `${name} failed`, {
          ...opContext,
          ...extraContext,
          durationMs,
          error: errorMessage,
        })
      },
    }
  }

  return {
    debug: (msg, ctx) => emit("debug", msg, ctx),
    info: (msg, ctx) => emit("info", msg, ctx),
    warn: (msg, ctx) => emit("warn", msg, ctx),
    error: (msg, ctx) => emit("error", msg, ctx),
    child(context: Record<string, unknown>): Logger {
      return makeLogger(loggerName, { ...baseContext, ...context })
    },
    startOp,
  }
}

export function createLogger(name: string, context?: Record<string, unknown>): Logger {
  return makeLogger(name, context ?? {})
}

// Truncate large strings for log readability without losing grep-ability
export function truncate(value: string, maxLen: number = 100): string {
  if (value.length <= maxLen) return value
  return value.slice(0, maxLen) + "..."
}
