import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { loadConfig } from "../config"
import { getDb, resetDb, resolveDbPath } from "../db"

describe("config and db runtime overrides", () => {
  let tempDir: string
  let originalConfigEnv: string | undefined
  let originalDbEnv: string | undefined
  let originalTestModeEnv: string | undefined

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "tangerine-runtime-"))
    originalConfigEnv = process.env.TANGERINE_CONFIG
    originalDbEnv = process.env.TANGERINE_DB
    originalTestModeEnv = process.env.TEST_MODE
    resetDb()
    delete process.env.TANGERINE_CONFIG
    delete process.env.TANGERINE_DB
    delete process.env.TEST_MODE
  })

  afterEach(() => {
    resetDb()
    if (originalConfigEnv === undefined) delete process.env.TANGERINE_CONFIG
    else process.env.TANGERINE_CONFIG = originalConfigEnv
    if (originalDbEnv === undefined) delete process.env.TANGERINE_DB
    else process.env.TANGERINE_DB = originalDbEnv
    if (originalTestModeEnv === undefined) delete process.env.TEST_MODE
    else process.env.TEST_MODE = originalTestModeEnv
    rmSync(tempDir, { recursive: true, force: true })
  })

  test("loadConfig uses explicit config path override", async () => {
    const configPath = join(tempDir, "config.json")
    await Bun.write(configPath, JSON.stringify({
      projects: [
        { name: "dashboard-e2e", repo: "https://github.com/acme/dashboard-e2e", setup: "echo ok", defaultProvider: "opencode" },
      ],
    }))

    const config = loadConfig({ configPath, testMode: true })

    expect(config.runtime.configPath).toBe(configPath)
    expect(config.runtime.testMode).toBe(true)
    expect(config.config.projects[0]!.name).toBe("dashboard-e2e")
  })

  test("loadConfig falls back to TANGERINE_CONFIG env var", async () => {
    const configPath = join(tempDir, "env-config.json")
    await Bun.write(configPath, JSON.stringify({
      projects: [
        { name: "env-project", repo: "https://github.com/acme/env-project", setup: "echo ok", defaultProvider: "claude-code" },
      ],
    }))
    process.env.TANGERINE_CONFIG = configPath
    process.env.TEST_MODE = "1"

    const config = loadConfig()

    expect(config.runtime.configPath).toBe(configPath)
    expect(config.runtime.testMode).toBe(true)
    expect(config.config.projects[0]!.name).toBe("env-project")
  })

  test("getDb resolves explicit and env-provided database paths", () => {
    const explicitDbPath = join(tempDir, "explicit.sqlite")
    const envDbPath = join(tempDir, "env.sqlite")

    expect(resolveDbPath(explicitDbPath)).toBe(explicitDbPath)
    process.env.TANGERINE_DB = envDbPath
    expect(resolveDbPath()).toBe(envDbPath)

    const db = getDb(explicitDbPath)
    db.prepare("SELECT 1").get()

    expect(existsSync(explicitDbPath)).toBe(true)
  })
})
