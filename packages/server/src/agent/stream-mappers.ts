// Per-task stream mapper management for chat v2

import { createAcpStreamMapper, mapAgentEventToStream, type StreamEvent } from "./acp-stream-mapper"
import type { AgentEvent } from "./provider"

type StreamMapper = ReturnType<typeof createAcpStreamMapper>

const mappers = new Map<string, StreamMapper>()

export function getStreamMapper(taskId: string): StreamMapper {
  let mapper = mappers.get(taskId)
  if (!mapper) {
    mapper = createAcpStreamMapper()
    mappers.set(taskId, mapper)
  }
  return mapper
}

export function clearStreamMapper(taskId: string): void {
  mappers.delete(taskId)
}

export function resetStreamMapper(taskId: string): void {
  const mapper = mappers.get(taskId)
  if (mapper) mapper.reset()
}

export function mapEventToV2(taskId: string, event: AgentEvent): StreamEvent[] {
  const mapper = getStreamMapper(taskId)
  return mapAgentEventToStream(event, mapper)
}

export type { StreamEvent }
