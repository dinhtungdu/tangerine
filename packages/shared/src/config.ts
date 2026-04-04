import { z } from "zod"
import { SUPPORTED_PROVIDERS } from "./constants"

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

export const projectConfigSchema = z.object({
  name: z.string(),
  repo: z.string(),
  defaultBranch: z.string().default("main"),
  setup: z.string(),
  test: z.string().optional(),
  env: z.record(z.string()).optional(),
  model: z.string().optional(),
  defaultProvider: z.enum(SUPPORTED_PROVIDERS).default("claude-code"),
  prMode: z.enum(["ready", "draft", "none"]).default("none"),
  archived: z.boolean().optional().default(false),
  postUpdateCommand: z.string().optional(),
  predefinedPrompts: z.array(predefinedPromptSchema).optional().default([
    { label: "Are you proud of your code?", text: "Are you proud of your code?" },
    { label: "Yes", text: "Yes" },
    { label: "Merge", text: "Merge" },
  ]),
  orchestratorPrompt: z.string().optional(),
  orchestratorPrompts: z.array(predefinedPromptSchema).optional().default([
    { label: "Check active tasks", text: "Check active tasks" },
    { label: "Status update", text: "Status update" },
  ]),
  reviewerPrompts: z.array(predefinedPromptSchema).optional().default([
    { label: "Summarize findings", text: "Summarize findings" },
    { label: "Approve", text: "Approve" },
  ]),
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
  sshHost: z.string().optional(),
  sshUser: z.string().optional(),
  editor: z.enum(["vscode", "cursor", "zed"]).optional(),
  actionCombos: z.array(actionComboSchema).optional().default([]),
  shortcuts: z.record(shortcutSchema).optional(),
})

export type PredefinedPrompt = z.infer<typeof predefinedPromptSchema>
export type ShortcutConfig = z.infer<typeof shortcutSchema>
export type ActionCombo = z.infer<typeof actionComboSchema>
export type ProjectConfig = z.infer<typeof projectConfigSchema>
export type TangerineConfig = z.infer<typeof tangerineConfigSchema>
