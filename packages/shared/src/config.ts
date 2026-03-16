import { z } from "zod"

export const previewConfigSchema = z.object({
  port: z.number().default(3000),
  path: z.string().default("/"),
})

export const projectConfigSchema = z.object({
  name: z.string(),
  repo: z.string(),
  defaultBranch: z.string().default("main"),
  image: z.string(),
  setup: z.string(),
  preview: previewConfigSchema.optional(),
  test: z.string().optional(),
  extraPorts: z.array(z.number()).optional(),
  env: z.record(z.string()).optional(),
  model: z.string().optional(),
})

export const githubTriggerSchema = z.object({
  type: z.enum(["label", "assignee"]),
  value: z.string(),
})

export const githubIntegrationSchema = z.object({
  webhookSecret: z.string().optional(),
  pollIntervalMinutes: z.number().default(60),
  trigger: githubTriggerSchema.optional(),
})

export const integrationsSchema = z.object({
  github: githubIntegrationSchema.optional(),
})

const defaultModels = [
  "anthropic/claude-sonnet-4-20250514",
  "anthropic/claude-opus-4-20250514",
  "anthropic/claude-haiku-4-20250414",
]

export const tangerineConfigSchema = z.object({
  projects: z.array(projectConfigSchema).min(1),
  model: z.string().default("anthropic/claude-sonnet-4-20250514"),
  models: z.array(z.string()).default(defaultModels),
  integrations: integrationsSchema.optional(),
})

export type PreviewConfig = z.infer<typeof previewConfigSchema>
export type ProjectConfig = z.infer<typeof projectConfigSchema>
export type TangerineConfig = z.infer<typeof tangerineConfigSchema>
