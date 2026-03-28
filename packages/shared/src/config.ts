import { z } from "zod"

export const predefinedPromptSchema = z.object({
  label: z.string(),
  text: z.string(),
})

export const projectConfigSchema = z.object({
  name: z.string(),
  repo: z.string(),
  defaultBranch: z.string().default("main"),
  setup: z.string(),
  test: z.string().optional(),
  env: z.record(z.string()).optional(),
  model: z.string().optional(),
  defaultProvider: z.enum(["opencode", "claude-code", "codex"]).default("claude-code"),
  postUpdateCommand: z.string().optional(),
  predefinedPrompts: z.array(predefinedPromptSchema).optional().default([
    { label: "Are you proud of your code?", text: "Are you proud of your code?" },
    { label: "Yes", text: "Yes" },
    { label: "Merge", text: "Merge" },
  ]),
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

const defaultModels = [
  "anthropic/claude-sonnet-4-6",
  "anthropic/claude-opus-4-20250514",
  "anthropic/claude-haiku-4-20250414",
  "openai/gpt-5.4",
]

export const tangerineConfigSchema = z.object({
  projects: z.array(projectConfigSchema).min(1),
  workspace: z.string().default("~/tangerine-workspace"),
  model: z.string().default("anthropic/claude-sonnet-4-6"),
  models: z.array(z.string()).default(defaultModels),
  integrations: integrationsSchema.optional(),
})

export type PredefinedPrompt = z.infer<typeof predefinedPromptSchema>
export type ProjectConfig = z.infer<typeof projectConfigSchema>
export type TangerineConfig = z.infer<typeof tangerineConfigSchema>
