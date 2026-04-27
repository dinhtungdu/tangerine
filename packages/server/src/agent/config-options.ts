import type { AgentConfigOption } from "@tangerine/shared"

export function taskConfigUpdatesFromOptions(options: AgentConfigOption[]): { model?: string; reasoning_effort?: string } {
  const updates: { model?: string; reasoning_effort?: string } = {}
  const model = options.find((option) => option.category === "model")
  const reasoning = options.find((option) => option.category === "thought_level")
  if (model?.currentValue) updates.model = model.currentValue
  if (reasoning?.currentValue) updates.reasoning_effort = reasoning.currentValue
  return updates
}
