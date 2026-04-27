import { describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, lstatSync, rmSync } from "fs"
import { join } from "path"
import { homedir, tmpdir } from "os"
import { ACP_SKILLS_DIR, symlinkSkill } from "../cli/install"

describe("ACP skill install target", () => {
  it("uses a provider-neutral ACP skills directory", () => {
    expect(ACP_SKILLS_DIR).toBe(join(homedir(), ".config", "acp", "skills"))
  })
})

describe("symlinkSkill", () => {
  it("creates a symlink and becomes idempotent on rerun", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tangerine-install-"))
    const sourceDir = join(tempDir, "source-skill")
    const targetDir = join(tempDir, "target-skills")

    mkdirSync(sourceDir, { recursive: true })

    const first = symlinkSkill(sourceDir, targetDir)
    const target = join(targetDir, "source-skill")

    expect(first).toEqual({ created: true, skipped: null })
    expect(lstatSync(target).isSymbolicLink()).toBe(true)

    const second = symlinkSkill(sourceDir, targetDir)
    expect(second).toEqual({ created: false, skipped: "already linked" })

    rmSync(tempDir, { recursive: true, force: true })
  })
})
