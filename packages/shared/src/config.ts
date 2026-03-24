import { z } from "zod"

const previewConfigSchema = z.object({
  port: z.number().default(3000),
  path: z.string().default("/"),
  command: z.string().optional(),
})

const poolConfigSchema = z.object({
  maxPoolSize: z.number().default(2),
  minReady: z.number().default(1),
  idleTimeoutMs: z.number().default(600_000),
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
  defaultProvider: z.enum(["opencode", "claude-code"]).default("opencode"),
  pool: poolConfigSchema.partial().optional(), // deprecated, kept for config compat
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
  "openai/gpt-5.4",
  "anthropic/claude-sonnet-4-20250514",
  "anthropic/claude-opus-4-20250514",
  "anthropic/claude-haiku-4-20250414",
]

export const tangerineConfigSchema = z.object({
  projects: z.array(projectConfigSchema).min(1),
  model: z.string().default("openai/gpt-5.4"),
  models: z.array(z.string()).default(defaultModels),
  integrations: integrationsSchema.optional(),
  pool: poolConfigSchema.default({}),
})

export type ProjectConfig = z.infer<typeof projectConfigSchema>
export type TangerineConfig = z.infer<typeof tangerineConfigSchema>
