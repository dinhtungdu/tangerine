import { DEFAULT_AGENT_ID, isProviderAvailable, type AgentConfig, type ProjectConfig, type ProviderType, type SystemCapabilities } from "@tangerine/shared"

export function getConfiguredAgentIds(agents: AgentConfig[]): string[] {
  return agents.map((agent) => agent.id)
}

export function resolveAvailableAgent({
  agents,
  systemCapabilities,
  project,
  globalDefaultAgent,
  preferred,
}: {
  agents: AgentConfig[]
  systemCapabilities: SystemCapabilities | null
  project?: Pick<ProjectConfig, "defaultAgent" | "defaultProvider"> | null
  globalDefaultAgent?: string
  preferred?: string | null
}): ProviderType {
  const configuredAgentIds = getConfiguredAgentIds(agents)
  const fallback = project?.defaultAgent ?? globalDefaultAgent ?? project?.defaultProvider ?? configuredAgentIds[0] ?? DEFAULT_AGENT_ID
  const candidate = preferred ?? fallback
  const known = configuredAgentIds.length === 0 || configuredAgentIds.includes(candidate) ? candidate : fallback
  if (isProviderAvailable(systemCapabilities, known)) return known as ProviderType
  const available = configuredAgentIds.find((id) => isProviderAvailable(systemCapabilities, id))
  return (available ?? known) as ProviderType
}
