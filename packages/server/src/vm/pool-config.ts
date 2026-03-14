import type { AppConfig } from "../config.ts"
import type { PoolConfig } from "./pool-types.ts"
import type { Provider } from "./providers/types.ts"
import { goldenVmName } from "../image/build.ts"
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_MIN_READY,
  DEFAULT_MAX_POOL_SIZE,
} from "@tangerine/shared"

/**
 * Creates a pool config from the app config and a provider instance.
 * Uses clone:<golden-vm> as snapshotId so Lima clones from the golden VM
 * using APFS copy-on-write (instant, space-efficient).
 */
export function createPoolConfig(config: AppConfig, provider: Provider, providerName: string): PoolConfig {
  const imageName = config.config.project.image

  return {
    slots: [
      {
        name: providerName,
        provider,
        snapshotId: `clone:${goldenVmName(imageName)}`,
        region: "local",
        plan: "4cpu-8gb-20gb",
        maxPoolSize: DEFAULT_MAX_POOL_SIZE,
        priority: 1,
        idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
        minReady: DEFAULT_MIN_READY,
      },
    ],
    labelPrefix: "tangerine",
  }
}
