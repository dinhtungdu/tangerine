import { z } from "zod"
import { DEFAULT_AGENT_ID } from "./constants"

export const predefinedPromptSchema = z.object({
  label: z.string(),
  text: z.string(),
})

const shortcutSchema = z.object({
  key: z.string(),
  meta: z.boolean().optional(),
  shift: z.boolean().optional(),
  alt: z.boolean().optional(),
})

const defaultWorkerPrompts: z.infer<typeof predefinedPromptSchema>[] = [
  { label: "Are you proud of your code?", text: "Are you proud of your code?" },
  { label: "Yes", text: "Yes" },
  { label: "Merge", text: "Merge" },
]

const defaultOrchestratorPrompts: z.infer<typeof predefinedPromptSchema>[] = [
  { label: "Check active tasks", text: "Check active tasks" },
  { label: "Status update", text: "Status update" },
]

const defaultReviewerPrompts: z.infer<typeof predefinedPromptSchema>[] = [
  { label: "Summarize findings", text: "Summarize findings" },
  { label: "Approve", text: "Approve" },
]

export const taskTypeConfigSchema = z.object({
  systemPrompt: z.string().optional(),
  predefinedPrompts: z.array(predefinedPromptSchema).optional(),
  agent: z.string().optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
})

export const taskTypesSchema = z.object({
  worker: taskTypeConfigSchema.optional(),
  orchestrator: taskTypeConfigSchema.optional(),
  reviewer: taskTypeConfigSchema.optional(),
})

export const agentConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
})

export const projectConfigSchema = z.object({
  name: z.string(),
  repo: z.string(),
  defaultBranch: z.string().default("main"),
  setup: z.string(),
  test: z.string().optional(),
  env: z.record(z.string()).optional(),
  model: z.string().optional(),
  /** Deprecated migration field. Use defaultAgent with top-level agents[]. */
  defaultProvider: z.string().optional(),
  defaultAgent: z.string().optional(),
  prMode: z.enum(["ready", "draft", "none"]).default("none"),
  archived: z.boolean().optional().default(false),
  postUpdateCommand: z.string().optional(),
  taskTypes: taskTypesSchema.optional(),
})

export const actionComboSchema = z.object({
  id: z.string(),
  label: z.string(),
  shortcut: shortcutSchema.optional(),
  sequence: z.array(z.string()).min(1),
})

const githubTriggerSchema = z.object({
  type: z.enum(["label", "assignee"]),
  value: z.string(),
})

const githubIntegrationSchema = z.object({
  webhookSecret: z.string().optional(),
  pollIntervalMinutes: z.number().default(60),
  trigger: githubTriggerSchema.optional(),
})

const integrationsSchema = z.object({
  github: githubIntegrationSchema.optional(),
})

const defaultModels: string[] = []

const sslConfigSchema = z.object({
  cert: z.string(),
  key: z.string(),
  port: z.number().int().positive().optional(),
})

export const tangerineConfigSchema = z.object({
  projects: z.array(projectConfigSchema).min(1),
  agents: z.array(agentConfigSchema).optional().default([]),
  defaultAgent: z.string().optional(),
  workspace: z.string().default("~/tangerine-workspace"),
  model: z.string().optional(),
  models: z.array(z.string()).default(defaultModels),
  integrations: integrationsSchema.optional(),
  sshHost: z.string().optional(),
  sshUser: z.string().optional(),
  editor: z.enum(["vscode", "cursor", "zed"]).optional(),
  actionCombos: z.array(actionComboSchema).optional().default([]),
  shortcuts: z.record(shortcutSchema).optional(),
  port: z.number().int().positive().optional(),
  ssl: sslConfigSchema.optional(),
  /** Fraction of provider context window reserved for conversation prefix in branched tasks (0.1–1). */
  checkpointTokenBudgetFraction: z.number().min(0.1).max(1).default(0.5),
  /** Hours to keep checkpoints after a task reaches a terminal state before GC deletes them. */
  checkpointTtlHours: z.number().int().positive().default(24),
})

export type PredefinedPrompt = z.infer<typeof predefinedPromptSchema>
export type ShortcutConfig = z.infer<typeof shortcutSchema>
export type ActionCombo = z.infer<typeof actionComboSchema>
export type AgentConfig = z.infer<typeof agentConfigSchema>
export type TaskTypeConfig = z.infer<typeof taskTypeConfigSchema>
export type ProjectConfig = z.infer<typeof projectConfigSchema>
export type ResolvedTaskTypeConfig = Omit<TaskTypeConfig, "predefinedPrompts"> & { predefinedPrompts: PredefinedPrompt[] }
export type SslConfig = z.infer<typeof sslConfigSchema>
export type TangerineConfig = z.infer<typeof tangerineConfigSchema>

const DEFAULTS: Record<string, { predefinedPrompts: PredefinedPrompt[] }> = {
  worker: { predefinedPrompts: defaultWorkerPrompts },
  orchestrator: { predefinedPrompts: defaultOrchestratorPrompts },
  reviewer: { predefinedPrompts: defaultReviewerPrompts },
}

/** Resolve per-task-type config from the taskTypes section, with defaults. */
export function resolveTaskTypeConfig(
  project: ProjectConfig,
  taskType: "worker" | "orchestrator" | "reviewer",
): ResolvedTaskTypeConfig {
  const override = project.taskTypes?.[taskType]
  return {
    systemPrompt: override?.systemPrompt,
    predefinedPrompts: override?.predefinedPrompts ?? DEFAULTS[taskType]!.predefinedPrompts,
    agent: override?.agent,
    model: override?.model,
    reasoningEffort: override?.reasoningEffort,
  }
}

export function resolveDefaultAgentId(
  config: TangerineConfig,
  project?: Pick<ProjectConfig, "defaultAgent" | "defaultProvider" | "taskTypes">,
  taskType?: "worker" | "orchestrator" | "reviewer",
): string {
  const taskTypeAgent = taskType ? project?.taskTypes?.[taskType]?.agent : undefined
  return taskTypeAgent ?? project?.defaultAgent ?? config.defaultAgent ?? project?.defaultProvider ?? config.agents[0]?.id ?? DEFAULT_AGENT_ID
}
