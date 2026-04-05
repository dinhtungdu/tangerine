import { describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, lstatSync, rmSync } from "fs"
import { join } from "path"
import { homedir, tmpdir } from "os"
import { PROVIDER_DISPLAY_NAMES, SUPPORTED_PROVIDERS } from "@tangerine/shared"
import { AGENT_PROVIDER_METADATA } from "../agent/metadata"
import { symlinkSkill } from "../cli/install"

describe("agent provider skill metadata", () => {
  it("exposes display names and skill directories for all providers", () => {
    expect(SUPPORTED_PROVIDERS).toEqual(["opencode", "claude-code", "codex", "pi"])
    expect(AGENT_PROVIDER_METADATA.opencode.displayName).toBe(PROVIDER_DISPLAY_NAMES.opencode)
    expect(AGENT_PROVIDER_METADATA["claude-code"].displayName).toBe(PROVIDER_DISPLAY_NAMES["claude-code"])
    expect(AGENT_PROVIDER_METADATA.codex.displayName).toBe(PROVIDER_DISPLAY_NAMES.codex)
    expect(AGENT_PROVIDER_METADATA.pi.displayName).toBe(PROVIDER_DISPLAY_NAMES.pi)
    expect(AGENT_PROVIDER_METADATA.opencode.skills.directory).toBe(join(homedir(), ".claude", "skills"))
    expect(AGENT_PROVIDER_METADATA["claude-code"].skills.directory).toBe(join(homedir(), ".claude", "skills"))
    expect(AGENT_PROVIDER_METADATA.codex.skills.directory).toBe(join(homedir(), ".codex", "skills"))
    expect(AGENT_PROVIDER_METADATA.pi.skills.directory).toBe(join(homedir(), ".pi", "agent", "skills"))
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
