import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { writeFileSync, readFileSync, mkdirSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { DAEMON_RESTART_EXIT_CODE, DAEMON_FATAL_EXIT_CODE, shouldRestartDaemon } from "../daemon-exit"

// We test the pure logic by importing daemon internals indirectly.
// For unit testing, we test the PID file read/write and process-alive logic.

describe("daemon", () => {
  const testDir = join(tmpdir(), `tangerine-daemon-test-${Date.now()}`)
  const pidFile = join(testDir, "tangerine.pid")

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  test("PID file round-trip", () => {
    const pid = process.pid
    writeFileSync(pidFile, String(pid))
    const raw = readFileSync(pidFile, "utf-8").trim()
    expect(parseInt(raw, 10)).toBe(pid)
  })

  test("process.kill(pid, 0) detects alive process", () => {
    // Current process is alive
    expect(() => process.kill(process.pid, 0)).not.toThrow()
  })

  test("process.kill(pid, 0) throws for non-existent PID", () => {
    // PID 99999999 almost certainly doesn't exist
    expect(() => process.kill(99999999, 0)).toThrow()
  })

  test("stale PID file detection", () => {
    writeFileSync(pidFile, "99999999")
    const raw = readFileSync(pidFile, "utf-8").trim()
    const pid = parseInt(raw, 10)
    expect(() => process.kill(pid, 0)).toThrow()
  })

  test("clean exit does not restart", () => {
    expect(shouldRestartDaemon(0)).toBe(false)
  })

  test("restart exit code triggers respawn", () => {
    expect(shouldRestartDaemon(DAEMON_RESTART_EXIT_CODE)).toBe(true)
  })

  test("signal exits also restart", () => {
    expect(shouldRestartDaemon(null)).toBe(true)
  })

  test("fatal exit code does not restart", () => {
    expect(shouldRestartDaemon(DAEMON_FATAL_EXIT_CODE)).toBe(false)
  })
})
