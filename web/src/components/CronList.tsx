import { useState, useCallback, useEffect, useRef } from "react"
import { isProviderAvailable, SUPPORTED_PROVIDERS, type Cron, type ProjectConfig, type ProviderType } from "@tangerine/shared"
import { createCron, updateCron } from "../lib/api"
import { formatCronExpression, formatRelativeTime } from "../lib/format"
import { useProject } from "../context/ProjectContext"
import { HarnessSelector } from "./HarnessSelector"
import { ModelSelector } from "./ModelSelector"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { ProjectSelector } from "./ProjectSelector"
import { BranchInput } from "./BranchInput"

interface CronFieldsProps {
  title: string
  setTitle: (v: string) => void
  description: string
  setDescription: (v: string) => void
  cron: string
  setCron: (v: string) => void
  provider: ProviderType
  setProvider: (v: ProviderType) => void
  providerModels: string[]
  activeModel: string
  setModel: (v: string) => void
  branch: string
  setBranch: (v: string) => void
}

function CronFields({
  title, setTitle,
  description, setDescription,
  cron, setCron,
  provider, setProvider,
  providerModels, activeModel, setModel,
  branch, setBranch,
}: CronFieldsProps) {
  const { systemCapabilities } = useProject()
  return (
    <>
      <Input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title (e.g. Nightly test suite)"
        className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder-muted-foreground outline-none"
      />
      <Textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Task description / prompt (optional)"
        rows={2}
        className="resize-none rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder-muted-foreground outline-none"
      />
      <div className="flex flex-col gap-2 md:flex-row md:items-center">
        <div className="flex flex-1 items-center gap-2">
          <label className="shrink-0 text-xs text-muted-foreground">Cron:</label>
          <Input
            type="text"
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            placeholder="0 9 * * 1-5"
            className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 font-mono text-sm text-foreground placeholder-muted-foreground outline-none"
          />
        </div>
        {cron.trim() && cron.trim().split(/\s+/).length === 5 && (
          <span className="text-xxs text-muted-foreground">{formatCronExpression(cron.trim())}</span>
        )}
      </div>
      <div className="flex flex-col gap-2 md:flex-row md:items-center">
        <HarnessSelector value={provider} onChange={setProvider} systemCapabilities={systemCapabilities} />
        <ModelSelector
          models={providerModels}
          model={activeModel}
          onModelChange={setModel}
          menuPlacement="bottom"
        />
        <BranchInput
          value={branch}
          onChange={setBranch}
          className="rounded-md border border-border bg-background text-sm md:w-[180px]"
        />
      </div>
    </>
  )
}

export function CronForm({ projects, onCreated, onClose, modelsByProvider }: {
  projects: ProjectConfig[]
  onCreated: () => void
  onClose: () => void
  modelsByProvider: Record<string, string[]>
}) {
  const { systemCapabilities } = useProject()
  const [projectId, setProjectId] = useState(projects[0]?.name ?? "")
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [cron, setCron] = useState("")
  const [provider, setProvider] = useState<ProviderType>(() => {
    if (isProviderAvailable(systemCapabilities, "claude-code")) return "claude-code"
    return (SUPPORTED_PROVIDERS.find((p) => isProviderAvailable(systemCapabilities, p)) ?? "claude-code") as ProviderType
  })
  const [model, setModel] = useState("")
  const [branch, setBranch] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Resync if capabilities load after mount
  useEffect(() => {
    if (!systemCapabilities || isProviderAvailable(systemCapabilities, provider)) return
    const available = SUPPORTED_PROVIDERS.find((p) => isProviderAvailable(systemCapabilities, p))
    if (available) setProvider(available as ProviderType)
  }, [systemCapabilities, provider])

  const providerModels = modelsByProvider[provider] ?? []
  const activeModel = model && providerModels.includes(model) ? model : providerModels[0] ?? ""

  const canSubmit = title.trim() && cron.trim() && !submitting && isProviderAvailable(systemCapabilities, provider)

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      await createCron({
        projectId,
        title: title.trim(),
        description: description.trim() || undefined,
        cron: cron.trim(),
        taskDefaults: {
          provider,
          model: activeModel || undefined,
          branch: branch.trim() || undefined,
        },
      })
      setTitle("")
      setDescription("")
      setCron("")
      setBranch("")
      onClose()
      onCreated()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }, [canSubmit, projectId, title, description, cron, provider, activeModel, branch, onCreated])

  return (
    <div className="rounded-lg border border-border bg-background p-4">
      <h3 className="mb-3 text-sm font-semibold text-foreground">New Cron</h3>
      <div className="flex flex-col gap-3">
        <ProjectSelector
          projects={projects}
          value={projectId}
          onChange={(v) => v && setProjectId(v)}
          hideArchived={false}
          className="w-full"
          aria-label="Project"
        />
        <CronFields
          title={title} setTitle={setTitle}
          description={description} setDescription={setDescription}
          cron={cron} setCron={setCron}
          provider={provider} setProvider={setProvider}
          providerModels={providerModels} activeModel={activeModel} setModel={setModel}
          branch={branch} setBranch={setBranch}
        />
        {error && <p className="text-xs text-status-error">{error}</p>}
        <div className="flex gap-2">
          <Button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="flex h-9 flex-1 items-center justify-center rounded-md px-4 text-sm font-medium"
          >
            {submitting ? "Creating..." : "Create Cron"}
          </Button>
          <Button
            variant="outline"
            onClick={onClose}
            className="flex h-9 items-center justify-center rounded-md px-4 text-sm text-muted-foreground"
          >
            Cancel
          </Button>
        </div>
      </div>
    </div>
  )
}

export function CronRow({ cron, onToggle, onDelete, onRefresh, modelsByProvider }: {
  cron: Cron
  onToggle: (id: string, enabled: boolean) => void
  onDelete: (id: string) => void
  onRefresh: () => void
  modelsByProvider: Record<string, string[]>
}) {
  const { systemCapabilities } = useProject()
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(cron.title)
  const [description, setDescription] = useState(cron.description ?? "")
  const [cronExpr, setCronExpr] = useState(cron.cron)
  // taskDefaultsEnabled: false when cron.taskDefaults is null so we don't silently
  // override project-level defaults when editing only title/description/schedule.
  const [taskDefaultsEnabled, setTaskDefaultsEnabled] = useState(cron.taskDefaults !== null)
  const [provider, setProvider] = useState<ProviderType>(() => {
    const saved = (cron.taskDefaults?.provider as ProviderType) ?? "claude-code"
    if (isProviderAvailable(systemCapabilities, saved)) return saved
    return (SUPPORTED_PROVIDERS.find((p) => isProviderAvailable(systemCapabilities, p)) ?? saved) as ProviderType
  })
  const capsLoadedRef = useRef(false)
  useEffect(() => {
    if (!systemCapabilities || capsLoadedRef.current) return
    capsLoadedRef.current = true
    if (!isProviderAvailable(systemCapabilities, provider)) {
      const available = SUPPORTED_PROVIDERS.find((p) => isProviderAvailable(systemCapabilities, p))
      if (available) setProvider(available as ProviderType)
    }
  }, [systemCapabilities, provider])
  const [model, setModel] = useState(cron.taskDefaults?.model ?? "")
  const [branch, setBranch] = useState(cron.taskDefaults?.branch ?? "")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const providerModels = modelsByProvider[provider] ?? []
  // activeModel is only for display; saving uses raw `model` to avoid silent fallback
  const activeModel = model && providerModels.includes(model) ? model : providerModels[0] ?? ""

  const canSubmit = title.trim() && cronExpr.trim() && !submitting && isProviderAvailable(systemCapabilities, provider)

  const handleCancel = useCallback(() => {
    // Reset to saved values
    setTitle(cron.title)
    setDescription(cron.description ?? "")
    setCronExpr(cron.cron)
    setProvider((cron.taskDefaults?.provider as ProviderType) ?? "claude-code")
    setModel(cron.taskDefaults?.model ?? "")
    setBranch(cron.taskDefaults?.branch ?? "")
    setError(null)
    setTaskDefaultsEnabled(cron.taskDefaults !== null)
    setEditing(false)
  }, [cron])

  const handleSave = useCallback(async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      await updateCron(cron.id, {
        title: title.trim(),
        description: description.trim() || null,
        cron: cronExpr.trim(),
        taskDefaults: taskDefaultsEnabled ? {
          // Preserve reasoningEffort since this form doesn't expose it
          ...(cron.taskDefaults?.reasoningEffort ? { reasoningEffort: cron.taskDefaults.reasoningEffort } : {}),
          provider,
          model: model || undefined,
          branch: branch.trim() || undefined,
        } : null,
      })
      onRefresh()
      setEditing(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }, [canSubmit, cron.id, cron.taskDefaults, title, description, cronExpr, taskDefaultsEnabled, provider, model, branch, onRefresh])

  if (editing) {
    return (
      <div className="border-t border-border px-4 py-3 first:border-t-0">
        <div className="flex flex-col gap-3">
          <Input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title (e.g. Nightly test suite)"
            className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder-muted-foreground outline-none"
          />
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Task description / prompt (optional)"
            rows={2}
            className="resize-none rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder-muted-foreground outline-none"
          />
          <div className="flex flex-col gap-2 md:flex-row md:items-center">
            <div className="flex flex-1 items-center gap-2">
              <label className="shrink-0 text-xs text-muted-foreground">Cron:</label>
              <Input
                type="text"
                value={cronExpr}
                onChange={(e) => setCronExpr(e.target.value)}
                placeholder="0 9 * * 1-5"
                className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 font-mono text-sm text-foreground placeholder-muted-foreground outline-none"
              />
            </div>
            {cronExpr.trim() && cronExpr.trim().split(/\s+/).length === 5 && (
              <span className="text-xxs text-muted-foreground">{formatCronExpression(cronExpr.trim())}</span>
            )}
          </div>
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={taskDefaultsEnabled}
              onChange={(e) => setTaskDefaultsEnabled(e.target.checked)}
              className="rounded"
            />
            <span className="text-xs text-muted-foreground">Override task defaults</span>
          </label>
          {taskDefaultsEnabled && (
            <div className="flex flex-col gap-2 md:flex-row md:items-center">
              <HarnessSelector value={provider} onChange={setProvider} systemCapabilities={systemCapabilities} />
              <ModelSelector
                models={providerModels}
                model={activeModel}
                onModelChange={setModel}
                menuPlacement="bottom"
              />
              <Input
                type="text"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="Branch (optional)"
                className="rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground placeholder-muted-foreground outline-none md:w-[180px]"
              />
            </div>
          )}
          {error && <p className="text-xs text-status-error">{error}</p>}
          <div className="flex gap-2">
            <Button
              onClick={handleSave}
              disabled={!canSubmit}
              className="flex h-9 flex-1 items-center justify-center rounded-md px-4 text-sm font-medium"
            >
              {submitting ? "Saving..." : "Save Changes"}
            </Button>
            <Button
              variant="outline"
              onClick={handleCancel}
              className="flex h-9 items-center justify-center rounded-md px-4 text-sm text-muted-foreground"
            >
              Cancel
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-3 border-t border-border px-4 py-3 first:border-t-0">
      {/* Enable/disable toggle */}
      <button
        onClick={() => onToggle(cron.id, !cron.enabled)}
        className="shrink-0 rounded p-1 outline-none hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring/50"
        title={cron.enabled ? "Disable" : "Enable"}
      >
        <div className={`h-2.5 w-2.5 rounded-full ${cron.enabled ? "bg-green-500" : "bg-muted-foreground"}`} />
      </button>

      {/* Title + cron expression */}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium text-foreground">{cron.title}</span>
          <span className="rounded bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">{cron.projectId}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded bg-blue-500/10 px-1.5 py-0.5 font-mono text-2xs font-medium text-blue-700">
            {cron.cron}
          </span>
          <span className="text-xxs text-muted-foreground">{formatCronExpression(cron.cron)}</span>
        </div>
      </div>

      {/* Next run */}
      <div className="hidden flex-col items-end gap-0.5 md:flex">
        <span className="text-xxs text-muted-foreground">Next run</span>
        <span className="text-xs text-foreground">
          {cron.enabled && cron.nextRunAt ? formatRelativeTime(cron.nextRunAt) : "\u2014"}
        </span>
      </div>

      {/* Task defaults badges */}
      <div className="hidden items-center gap-1.5 md:flex">
        {cron.taskDefaults?.provider && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
            {cron.taskDefaults.provider}
          </span>
        )}
        {cron.taskDefaults?.model && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
            {cron.taskDefaults.model.split("/").pop()}
          </span>
        )}
      </div>

      {/* Edit */}
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => setEditing(true)}
        className="shrink-0 text-muted-foreground hover:text-foreground"
        title="Edit"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125" />
        </svg>
      </Button>

      {/* Delete */}
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => onDelete(cron.id)}
        className="shrink-0 text-muted-foreground hover:text-status-error"
        title="Delete"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
        </svg>
      </Button>
    </div>
  )
}
