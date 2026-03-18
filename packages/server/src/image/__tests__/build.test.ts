import { beforeEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "fs"
import type { Database } from "bun:sqlite"
import { createTestDb, createMockProvider } from "../../__tests__/helpers"
import { createVm, getVm } from "../../db/queries"
import { Effect } from "effect"
import { cleanupUnassignedVmsForImage } from "../build"
import type { Logger } from "../../logger"

function createTestLogger(): Logger {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() { return this },
    startOp() {
      return {
        end() {},
        fail() {},
      }
    },
  }
}

describe("image cleanup", () => {
  let db: Database
  const provider = createMockProvider()
  const logger = createTestLogger()
  const logFile = "/tmp/tangerine-image-cleanup-test.log"

  beforeEach(() => {
    db = createTestDb()
    provider.instances.clear()
    writeFileSync(logFile, "")
  })

  test("rebuild cleanup destroys only ready VMs for the rebuilt image", async () => {
    provider.instances.set("ready-old", {
      id: "ready-old",
      label: "ready-old",
      ip: "10.0.0.1",
      status: "active",
      region: "local",
      plan: "4cpu-8gb",
      createdAt: new Date().toISOString(),
      sshPort: 22,
    })
    provider.instances.set("assigned-old", {
      id: "assigned-old",
      label: "assigned-old",
      ip: "10.0.0.2",
      status: "active",
      region: "local",
      plan: "4cpu-8gb",
      createdAt: new Date().toISOString(),
      sshPort: 22,
    })
    provider.instances.set("ready-other", {
      id: "ready-other",
      label: "ready-other",
      ip: "10.0.0.3",
      status: "active",
      region: "local",
      plan: "4cpu-8gb",
      createdAt: new Date().toISOString(),
      sshPort: 22,
    })

    Effect.runSync(createVm(db, {
      id: "ready-old",
      label: "ready-old",
      provider: "lima-woocommerce",
      status: "ready",
      snapshot_id: "clone:tangerine-golden-woocommerce",
      region: "local",
      plan: "4cpu-8gb",
    }))
    Effect.runSync(createVm(db, {
      id: "assigned-old",
      label: "assigned-old",
      provider: "lima-woocommerce",
      status: "assigned",
      snapshot_id: "clone:tangerine-golden-woocommerce",
      region: "local",
      plan: "4cpu-8gb",
    }))
    Effect.runSync(createVm(db, {
      id: "ready-other",
      label: "ready-other",
      provider: "lima-other",
      status: "ready",
      snapshot_id: "clone:tangerine-golden-other",
      region: "local",
      plan: "4cpu-8gb",
    }))

    const destroyed = await cleanupUnassignedVmsForImage(
      db,
      provider,
      "clone:tangerine-golden-woocommerce",
      logFile,
      logger,
    )

    expect(destroyed).toBe(1)
    expect(provider.instances.has("ready-old")).toBe(false)
    expect(provider.instances.has("assigned-old")).toBe(true)
    expect(provider.instances.has("ready-other")).toBe(true)
    expect(Effect.runSync(getVm(db, "ready-old"))?.status).toBe("destroyed")
    expect(Effect.runSync(getVm(db, "assigned-old"))?.status).toBe("assigned")
    expect(Effect.runSync(getVm(db, "ready-other"))?.status).toBe("ready")
  })
})
