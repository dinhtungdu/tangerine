import { useState, useCallback } from "react"
import type { Cron, ProviderType } from "@tangerine/shared"
import { createCron } from "../lib/api"
import { formatCronExpression, formatRelativeTime } from "../lib/format"
import { HarnessSelector } from "./HarnessSelector"
import { ModelSelector } from "./ModelSelector"

export function CronForm({ projectId, onCreated, modelsByProvider }: {
  projectId: string
  onCreated: () => void
  modelsByProvider: Record<string, string[]>
}) {
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [cron, setCron] = useState("")
  const [provider, setProvider] = useState<ProviderType>("claude-code")
  const [model, setModel] = useState("")
  const [branch, setBranch] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const providerModels = modelsByProvider[provider] ?? []
  const activeModel = model && providerModels.includes(model) ? model : providerModels[0] ?? ""

  const canSubmit = title.trim() && cron.trim() && !submitting

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
      onCreated()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }, [canSubmit, projectId, title, description, cron, provider, activeModel, branch, onCreated])

  return (
    <div className="rounded-lg border border-edge bg-surface p-4">
      <h3 className="mb-3 text-[14px] font-semibold text-fg">New Cron</h3>
      <div className="flex flex-col gap-3">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title (e.g. Nightly test suite)"
          className="rounded-md border border-edge bg-surface px-3 py-2 text-[13px] text-fg placeholder-fg-muted outline-none"
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Task description / prompt (optional)"
          rows={2}
          className="resize-none rounded-md border border-edge bg-surface px-3 py-2 text-[13px] text-fg placeholder-fg-muted outline-none"
        />
        <div className="flex flex-col gap-2 md:flex-row md:items-center">
          <div className="flex flex-1 items-center gap-2">
            <label className="shrink-0 text-[12px] text-fg-muted">Cron:</label>
            <input
              type="text"
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              placeholder="0 9 * * 1-5"
              className="flex-1 rounded-md border border-edge bg-surface px-3 py-1.5 font-mono text-[13px] text-fg placeholder-fg-muted outline-none"
            />
          </div>
          {cron.trim() && cron.trim().split(/\s+/).length === 5 && (
            <span className="text-[11px] text-fg-muted">{formatCronExpression(cron.trim())}</span>
          )}
        </div>
        <div className="flex flex-col gap-2 md:flex-row md:items-center">
          <HarnessSelector
            value={provider}
            onChange={setProvider}
          />
          <ModelSelector
            models={providerModels}
            model={activeModel}
            onModelChange={setModel}
            menuPlacement="bottom"
          />
          <input
            type="text"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder="Branch (optional)"
            className="rounded-md border border-edge bg-surface px-3 py-1.5 text-[13px] text-fg placeholder-fg-muted outline-none md:w-[180px]"
          />
        </div>
        {error && <p className="text-[12px] text-status-error">{error}</p>}
        <button
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="flex h-9 items-center justify-center rounded-md bg-surface-dark px-4 text-[13px] font-medium text-white transition hover:opacity-80 disabled:opacity-30"
        >
          {submitting ? "Creating..." : "Create Cron"}
        </button>
      </div>
    </div>
  )
}

export function CronRow({ cron, onToggle, onDelete }: {
  cron: Cron
  onToggle: (id: string, enabled: boolean) => void
  onDelete: (id: string) => void
}) {
  return (
    <div className="flex items-center gap-3 border-t border-edge px-4 py-3 first:border-t-0">
      {/* Enable/disable toggle */}
      <button
        onClick={() => onToggle(cron.id, !cron.enabled)}
        className="shrink-0 rounded p-1 hover:bg-surface-secondary"
        title={cron.enabled ? "Disable" : "Enable"}
      >
        <div className={`h-2.5 w-2.5 rounded-full ${cron.enabled ? "bg-green-500" : "bg-fg-muted"}`} />
      </button>

      {/* Title + cron expression */}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[13px] font-medium text-fg">{cron.title}</span>
        <div className="flex items-center gap-2">
          <span className="rounded bg-blue-500/10 px-1.5 py-0.5 font-mono text-[10px] font-medium text-blue-700">
            {cron.cron}
          </span>
          <span className="text-[11px] text-fg-muted">{formatCronExpression(cron.cron)}</span>
        </div>
      </div>

      {/* Next run */}
      <div className="hidden flex-col items-end gap-0.5 md:flex">
        <span className="text-[11px] text-fg-muted">Next run</span>
        <span className="text-[12px] text-fg">
          {cron.enabled && cron.nextRunAt ? formatRelativeTime(cron.nextRunAt) : "\u2014"}
        </span>
      </div>

      {/* Task defaults badges */}
      <div className="hidden items-center gap-1.5 md:flex">
        {cron.taskDefaults?.provider && (
          <span className="rounded bg-surface-secondary px-1.5 py-0.5 text-[10px] text-fg-muted">
            {cron.taskDefaults.provider}
          </span>
        )}
        {cron.taskDefaults?.model && (
          <span className="rounded bg-surface-secondary px-1.5 py-0.5 text-[10px] text-fg-muted">
            {cron.taskDefaults.model.split("/").pop()}
          </span>
        )}
      </div>

      {/* Delete */}
      <button
        onClick={() => onDelete(cron.id)}
        className="shrink-0 rounded p-1.5 text-fg-muted hover:bg-surface-secondary hover:text-status-error"
        title="Delete"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
        </svg>
      </button>
    </div>
  )
}
