import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { generateShimScript, type PrMode } from "../agent/gh-shim"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

let tempDir: string

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "gh-shim-test-"))
})

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

/** Write shim to temp dir and execute with given args */
async function runShim(prMode: PrMode, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // Use a fake gh that echoes its args
  const fakeGhPath = join(tempDir, "fake-gh")
  await Bun.write(fakeGhPath, '#!/usr/bin/env bash\necho "CALLED: $@"\n')
  await Bun.spawn(["chmod", "+x", fakeGhPath]).exited

  const script = generateShimScript(fakeGhPath, prMode)
  const shimPath = join(tempDir, "gh")
  await Bun.write(shimPath, script)
  await Bun.spawn(["chmod", "+x", shimPath]).exited

  const proc = Bun.spawn(["bash", shimPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode }
}

describe("gh shim", () => {
  describe("generateShimScript", () => {
    it("produces a valid bash script", () => {
      const script = generateShimScript("/usr/bin/gh", "draft")
      expect(script).toStartWith("#!/usr/bin/env bash")
      expect(script).toContain('prMode="draft"')
    })

    it("embeds the real gh path", () => {
      const script = generateShimScript("/custom/path/gh", "ready")
      expect(script).toContain('REAL_GH="/custom/path/gh"')
    })
  })

  describe("non-pr-create commands pass through", () => {
    it("passes through `gh issue list`", async () => {
      const result = await runShim("none", ["issue", "list"])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("CALLED: issue list")
    })

    it("passes through `gh pr view`", async () => {
      const result = await runShim("none", ["pr", "view", "123"])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("CALLED: pr view 123")
    })

    it("passes through `gh pr list`", async () => {
      const result = await runShim("draft", ["pr", "list"])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("CALLED: pr list")
    })
  })

  describe("prMode=none blocks pr create", () => {
    it("blocks `gh pr create`", async () => {
      const result = await runShim("none", ["pr", "create", "--title", "test"])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain("prMode=none")
    })
  })

  describe("prMode=draft appends --draft", () => {
    it("appends --draft when not present", async () => {
      const result = await runShim("draft", ["pr", "create", "--title", "test"])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("CALLED: pr create --title test --draft")
    })

    it("does not duplicate --draft when already present", async () => {
      const result = await runShim("draft", ["pr", "create", "--draft", "--title", "test"])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("CALLED: pr create --draft --title test")
    })
  })

  describe("prMode=ready passes through unchanged", () => {
    it("passes through `gh pr create` unchanged", async () => {
      const result = await runShim("ready", ["pr", "create", "--title", "test"])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("CALLED: pr create --title test")
    })
  })
})
