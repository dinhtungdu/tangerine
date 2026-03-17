import type { AppConfig } from "../config.ts"
import type { PoolConfig } from "./pool-types.ts"
import type { Provider } from "./providers/types.ts"
import { goldenVmName } from "../image/build.ts"

/**
 * Creates pool config from app config and a provider instance.
 * Generates one pool slot per project, each using its own golden image.
 * Per-project `pool` overrides the global `pool` settings.
 */
export function createPoolConfig(config: AppConfig, provider: Provider, providerName: string): PoolConfig {
  const globalPool = config.config.pool
  const slots = config.config.projects.map((project) => ({
    name: `${providerName}-${project.name}`,
    provider,
    snapshotId: `clone:${goldenVmName(project.image)}`,
    region: "local",
    plan: "4cpu-8gb-10gb",
    maxPoolSize: project.pool?.maxPoolSize ?? globalPool.maxPoolSize,
    priority: 1,
    idleTimeoutMs: project.pool?.idleTimeoutMs ?? globalPool.idleTimeoutMs,
    minReady: project.pool?.minReady ?? globalPool.minReady,
  }))

  return {
    slots,
    labelPrefix: "tangerine",
  }
}
