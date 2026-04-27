import { DEFAULT_AGENT_ID } from "@tangerine/shared"
import type { AppDeps } from "./app"

export function configuredProviderIds(deps: AppDeps): string[] {
  const configured = deps.config.config.agents.map((agent) => agent.id)
  return configured.length > 0 ? configured : [DEFAULT_AGENT_ID]
}

export function isConfiguredProvider(deps: AppDeps, provider: string): boolean {
  return new Set<string>(configuredProviderIds(deps)).has(provider)
}

export function configuredProviderList(deps: AppDeps): string {
  return configuredProviderIds(deps).join(", ")
}
