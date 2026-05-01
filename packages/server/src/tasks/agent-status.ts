import type { Task } from "@tangerine/shared"
import type { AgentHandle } from "../agent/provider"
import { getEffectiveAgentStatus, hasAgentWorkingState } from "./events"
import { getTaskState } from "./task-state"

export type ResolvedAgentStatus = NonNullable<Task["agentStatus"]>

export interface AgentStatusTaskSnapshot {
  id: string
  status: string
  suspended?: boolean | number | null
}

export function resolveAgentStatus(
  task: AgentStatusTaskSnapshot,
  getAgentHandle: (taskId: string) => AgentHandle | null | undefined,
): ResolvedAgentStatus | undefined {
  if (task.status !== "running") return undefined
  if (task.suspended) return "idle"

  // TUI mode intentionally disconnects the ACP agent — don't report "disconnected"
  if (getTaskState(task.id).tuiMode) return undefined

  const handle = getAgentHandle(task.id)
  const isAlive = handle && (!handle.isAlive || handle.isAlive())
  if (!isAlive) return "disconnected"

  return hasAgentWorkingState(task.id) ? getEffectiveAgentStatus(task.id) : "idle"
}
