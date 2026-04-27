import { DEFAULT_AGENT_ID } from "@tangerine/shared"
import type { AgentFactory } from "./provider"
import { createAcpProvider, type AcpProviderConfig } from "./acp-provider"

export type AgentFactories = Record<string, AgentFactory>

export interface AgentFactoryConfig {
  agents?: AcpProviderConfig[]
}

export function createAgentFactories(config?: AgentFactoryConfig): AgentFactories {
  if (config?.agents && config.agents.length > 0) {
    return Object.fromEntries(
      config.agents.map((agent) => [agent.id, createAcpProvider(agent)]),
    )
  }

  return {
    [DEFAULT_AGENT_ID]: createAcpProvider(),
  }
}
