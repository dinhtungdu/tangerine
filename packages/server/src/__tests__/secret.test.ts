import { describe, expect, it, afterAll, beforeEach } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, existsSync, unlinkSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

// Set TANGERINE_CREDENTIALS before any module imports so readCredentialsFile /
// writeCredentialsFile resolve to a temp path throughout the test run.
const tempDir = mkdtempSync(join(tmpdir(), "tangerine-secret-test-"))
const credentialsPath = join(tempDir, ".credentials")
mkdirSync(tempDir, { recursive: true })
process.env["TANGERINE_CREDENTIALS"] = credentialsPath

// Imported after the env var is set (modules are cached with the patched env).
const { runSecret } = await import("../cli/secret.ts")
const { readCredentialsFile, writeCredentialsFile } = await import("../config.ts")

afterAll(() => {
  delete process.env["TANGERINE_CREDENTIALS"]
  rmSync(tempDir, { recursive: true, force: true })
})

// Wipe the credentials file before each test for isolation.
beforeEach(() => {
  if (existsSync(credentialsPath)) {
    unlinkSync(credentialsPath)
  }
})

// Helper: capture stdout/stderr and intercept process.exit
async function captureOutput(
  fn: () => Promise<void>
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const stdoutLines: string[] = []
  const stderrLines: string[] = []
  let exitCode: number | null = null

  const origLog = console.log.bind(console)
  const origError = console.error.bind(console)
  const origExit = process.exit.bind(process)

  console.log = (...args: unknown[]) => stdoutLines.push(args.map(String).join(" "))
  console.error = (...args: unknown[]) => stderrLines.push(args.map(String).join(" "))
  process.exit = ((code?: number) => {
    exitCode = code ?? 0
    throw new Error(`process.exit(${code})`)
  }) as typeof process.exit

  try {
    await fn()
  } catch (e) {
    if (!(e instanceof Error && e.message.startsWith("process.exit("))) throw e
  } finally {
    console.log = origLog
    console.error = origError
    process.exit = origExit
  }

  return {
    stdout: stdoutLines.join("\n"),
    stderr: stderrLines.join("\n"),
    exitCode,
  }
}

describe("tangerine secret set", () => {
  it("writes key to .credentials", async () => {
    const { stdout } = await captureOutput(() => runSecret(["set", "TANGERINE_AUTH_TOKEN=token-test123"]))
    expect(stdout).toContain("Set TANGERINE_AUTH_TOKEN=")
    expect(readCredentialsFile().TANGERINE_AUTH_TOKEN).toBe("token-test123")
  })

  it("masks value in output", async () => {
    const { stdout } = await captureOutput(() => runSecret(["set", "TANGERINE_AUTH_TOKEN=token-abcdef"]))
    expect(stdout).not.toContain("token-abcdef")
    expect(stdout).toContain("toke")
  })

  it("rejects unknown keys", async () => {
    const { stderr, exitCode } = await captureOutput(() => runSecret(["set", "UNKNOWN_KEY=foo"]))
    expect(stderr).toContain("Unknown key")
    expect(exitCode).toBe(1)
  })

  it("rejects empty value", async () => {
    const { stderr, exitCode } = await captureOutput(() => runSecret(["set", "TANGERINE_AUTH_TOKEN="]))
    expect(stderr).toContain("cannot be empty")
    expect(exitCode).toBe(1)
  })

  it("rejects missing KEY=VALUE pair", async () => {
    const { exitCode } = await captureOutput(() => runSecret(["set"]))
    expect(exitCode).toBe(1)
  })
})

describe("tangerine secret get", () => {
  it("returns the stored value", async () => {
    writeCredentialsFile({ TANGERINE_AUTH_TOKEN: "mytoken" })
    const { stdout } = await captureOutput(() => runSecret(["get", "TANGERINE_AUTH_TOKEN"]))
    expect(stdout).toBe("mytoken")
  })

  it("returns (not set) for missing key", async () => {
    const { stdout } = await captureOutput(() => runSecret(["get", "EXTERNAL_HOST"]))
    expect(stdout).toBe("(not set)")
  })

  it("rejects unknown keys", async () => {
    const { stderr, exitCode } = await captureOutput(() => runSecret(["get", "UNKNOWN_KEY"]))
    expect(stderr).toContain("Unknown key")
    expect(exitCode).toBe(1)
  })
})

describe("tangerine secret list", () => {
  it("lists all keys, masks set values", async () => {
    writeCredentialsFile({ TANGERINE_AUTH_TOKEN: "token-abcdef" })
    const { stdout } = await captureOutput(() => runSecret(["list"]))
    expect(stdout).toContain("TANGERINE_AUTH_TOKEN")
    expect(stdout).toContain("toke")
    expect(stdout).not.toContain("token-abcdef")
  })

  it("shows (not set) for unset keys", async () => {
    const { stdout } = await captureOutput(() => runSecret(["list"]))
    expect(stdout).toContain("(not set)")
  })
})

describe("tangerine secret delete", () => {
  it("removes a key from .credentials", async () => {
    writeCredentialsFile({ TANGERINE_AUTH_TOKEN: "token-xyz" })
    const { stdout } = await captureOutput(() => runSecret(["delete", "TANGERINE_AUTH_TOKEN"]))
    expect(stdout).toContain("Deleted TANGERINE_AUTH_TOKEN")
    expect(readCredentialsFile().TANGERINE_AUTH_TOKEN).toBeUndefined()
  })

  it("reports key was not set", async () => {
    const { stdout } = await captureOutput(() => runSecret(["delete", "TANGERINE_AUTH_TOKEN"]))
    expect(stdout).toContain("was not set")
  })

  it("rejects unknown keys", async () => {
    const { stderr, exitCode } = await captureOutput(() => runSecret(["delete", "UNKNOWN_KEY"]))
    expect(stderr).toContain("Unknown key")
    expect(exitCode).toBe(1)
  })
})

describe("tangerine secret help", () => {
  it("shows help for no subcommand", async () => {
    const { stdout } = await captureOutput(() => runSecret([]))
    expect(stdout).toContain("tangerine secret")
  })

  it("shows help for unknown subcommand and exits 1", async () => {
    const { exitCode } = await captureOutput(() => runSecret(["badcmd"]))
    expect(exitCode).toBe(1)
  })
})
