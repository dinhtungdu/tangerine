import { describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { isPiSkillInstalled, readPiInstalledPackages } from "../cli/install"

describe("readPiInstalledPackages", () => {
  it("returns packages from Pi settings", () => {
    const dir = mkdtempSync(join(tmpdir(), "tangerine-install-test-"))
    const settingsPath = join(dir, "settings.json")

    writeFileSync(settingsPath, JSON.stringify({ packages: ["../../skills/tangerine-tasks", 123] }))

    expect(readPiInstalledPackages(settingsPath)).toEqual(["../../skills/tangerine-tasks"])

    rmSync(dir, { recursive: true, force: true })
  })

  it("returns empty array for missing or invalid settings", () => {
    const dir = mkdtempSync(join(tmpdir(), "tangerine-install-test-"))
    const settingsPath = join(dir, "settings.json")

    expect(readPiInstalledPackages(settingsPath)).toEqual([])

    writeFileSync(settingsPath, "{not-json")
    expect(readPiInstalledPackages(settingsPath)).toEqual([])

    rmSync(dir, { recursive: true, force: true })
  })
})

describe("isPiSkillInstalled", () => {
  it("matches relative package paths against absolute skill sources", () => {
    const dir = mkdtempSync(join(tmpdir(), "tangerine-install-test-"))
    const settingsPath = join(dir, ".pi", "agent", "settings.json")
    const skillSource = join(dir, "skills", "tangerine-tasks")

    mkdirSync(join(dir, ".pi", "agent"), { recursive: true })
    mkdirSync(skillSource, { recursive: true })
    writeFileSync(
      settingsPath,
      JSON.stringify({
        packages: ["../../skills/tangerine-tasks"],
      }),
    )

    expect(isPiSkillInstalled(skillSource, settingsPath)).toBe(true)
    expect(isPiSkillInstalled(join(dir, "skills", "browser-test"), settingsPath)).toBe(false)

    rmSync(dir, { recursive: true, force: true })
  })
})
