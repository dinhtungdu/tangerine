import { useState, useCallback, useEffect, useRef, type ClipboardEvent } from "react"
import type { ProviderType, PromptImage } from "@tangerine/shared"
import { useProject } from "../context/ProjectContext"
import { useProjectNav } from "../hooks/useProjectNav"
import { ModelSelector } from "./ModelSelector"
import { HarnessSelector } from "./HarnessSelector"
import { ReasoningEffortSelector, getEfforts, type ReasoningEffort } from "./ReasoningEffortSelector"

interface NewAgentFormProps {
  onSubmit: (data: { projectId: string; title: string; description?: string; branch?: string; provider?: string; model?: string; reasoningEffort?: string; parentTaskId?: string; type?: string; images?: PromptImage[] }) => void
  refTaskId?: string
  refTaskTitle?: string
}

interface PendingImage extends PromptImage {
  dataUrl: string
}

const suggestedTasks = [
  { icon: "bug", label: "Fix failing tests" },
  { icon: "wrench", label: "Add API docs" },
  { icon: "code", label: "Refactor DB queries" },
  { icon: "sparkles", label: "Update deps" },
]

/* -- Suggested task icon -- */

function TaskIcon({ icon }: { icon: string }) {
  const cls = "h-3 w-3 text-fg-muted"
  switch (icon) {
    case "bug":
      return <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 12.75c1.148 0 2.278.08 3.383.237 1.037.146 1.866.966 1.866 2.013 0 3.728-2.35 6.75-5.25 6.75S6.75 18.728 6.75 15c0-1.046.83-1.867 1.866-2.013A24.204 24.204 0 0 1 12 12.75Zm0 0c2.883 0 5.647.508 8.207 1.44a23.91 23.91 0 0 1-1.152 6.06M12 12.75c-2.883 0-5.647.508-8.208 1.44.125 2.104.52 4.136 1.153 6.06M12 12.75a2.25 2.25 0 0 0 2.248-2.354M12 12.75a2.25 2.25 0 0 1-2.248-2.354M12 8.25c.995 0 1.971-.08 2.922-.236.403-.066.74-.358.795-.762a3.778 3.778 0 0 0-.399-2.25M12 8.25c-.995 0-1.97-.08-2.922-.236-.402-.066-.74-.358-.795-.762a3.734 3.734 0 0 1 .4-2.253M12 8.25a2.25 2.25 0 0 0-2.248 2.146M12 8.25a2.25 2.25 0 0 1 2.248 2.146M8.683 5a6.032 6.032 0 0 1 6.634 0M7 6.5h10" /></svg>
    case "wrench":
      return <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17 17.25 21A2.652 2.652 0 0 0 21 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 1 1-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 0 0 4.486-6.336l-3.276 3.277a3.004 3.004 0 0 1-2.25-2.25l3.276-3.276a4.5 4.5 0 0 0-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085m-1.745 1.437L5.909 7.5H4.5L2.25 3.75l1.5-1.5L7.5 4.5v1.409l4.26 4.26m-1.745 1.437 1.745-1.437m6.615 8.206L15.75 15.75M4.867 19.125h.008v.008h-.008v-.008Z" /></svg>
    case "code":
      return <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5" /></svg>
    default:
      return <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 0 0-2.455 2.456Z" /></svg>
  }
}

/* -- Main form -- */

export function NewAgentForm({ onSubmit, refTaskId, refTaskTitle }: NewAgentFormProps) {
  const { navigate } = useProjectNav()
  const { current, modelsByProvider } = useProject()
  const PREFS_KEY = "tangerine:agent-prefs"
  const draftKey = `tangerine:new-agent-draft:${current?.name ?? "unknown"}:${refTaskId ?? "new"}`

  const loadDraft = useCallback((): { description?: string; customBranch?: string; taskType?: "worker" | "reviewer"; pendingImages?: PendingImage[] } => {
    try {
      return JSON.parse(localStorage.getItem(draftKey) ?? "{}") as { description?: string; customBranch?: string; taskType?: "worker" | "reviewer"; pendingImages?: PendingImage[] }
    } catch {
      return {}
    }
  }, [draftKey])

  const savedDraft = loadDraft()
  const [description, setDescription] = useState(savedDraft.description ?? "")
  const [customBranch, setCustomBranch] = useState(savedDraft.customBranch ?? "")
  const [pendingImages, setPendingImages] = useState<PendingImage[]>(savedDraft.pendingImages ?? [])

  const loadPrefs = (): { provider?: string; models?: Record<string, string>; reasoningEffort?: string } => {
    try { return JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") } catch { return {} }
  }
  const saved = loadPrefs()

  const [provider, setProvider] = useState<ProviderType>((saved.provider as ProviderType) ?? current?.defaultProvider ?? "claude-code")
  const [modelByProvider, setModelByProvider] = useState<Record<string, string>>(saved.models ?? {})
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>((saved.reasoningEffort as ReasoningEffort) ?? "medium")
  const [taskType, setTaskType] = useState<"worker" | "reviewer">(savedDraft.taskType ?? "worker")
  const [submitting, setSubmitting] = useState(false)
  const hydratedDraftKeyRef = useRef<string | null>(null)
  const branch = current?.defaultBranch ?? "main"

  const providerModels = modelsByProvider[provider] ?? []
  const activeModel = modelByProvider[provider] && providerModels.includes(modelByProvider[provider]!)
    ? modelByProvider[provider]!
    : providerModels[0] ?? ""

  const savePrefs = useCallback((updates: Partial<{ provider: string; models: Record<string, string>; reasoningEffort: string }>) => {
    const current = loadPrefs()
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...current, ...updates }))
  }, [])

  const handleProviderChange = useCallback((p: ProviderType) => {
    setProvider(p)
    savePrefs({ provider: p })
  }, [savePrefs])

  const handleModelChange = useCallback((m: string) => {
    setModelByProvider((prev) => {
      const next = { ...prev, [provider]: m }
      savePrefs({ models: next })
      return next
    })
  }, [provider, savePrefs])

  const MAX_IMAGES = 5

  const handlePaste = useCallback((e: ClipboardEvent<HTMLTextAreaElement>) => {
    for (const item of e.clipboardData.items) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile()
        if (!file) continue
        const reader = new FileReader()
        reader.onload = () => {
          const dataUrl = reader.result as string
          const commaIdx = dataUrl.indexOf(",")
          const mediaType = dataUrl.slice(5, commaIdx).split(";")[0] as PromptImage["mediaType"]
          const data = dataUrl.slice(commaIdx + 1)
          setPendingImages((prev) => prev.length >= MAX_IMAGES ? prev : [...prev, { dataUrl, mediaType, data }])
        }
        reader.readAsDataURL(file)
      }
    }
  }, [])

  const removeImage = useCallback((index: number) => {
    setPendingImages((prev) => prev.filter((_, i) => i !== index))
  }, [])

  useEffect(() => {
    if (hydratedDraftKeyRef.current === draftKey) return
    hydratedDraftKeyRef.current = draftKey
    if (description || customBranch || pendingImages.length > 0) return
    const draft = loadDraft()
    setDescription(draft.description ?? "")
    setCustomBranch(draft.customBranch ?? "")
    setPendingImages(draft.pendingImages ?? [])
    if (draft.taskType) setTaskType(draft.taskType)
  }, [draftKey, loadDraft, description, customBranch, pendingImages.length])

  useEffect(() => {
    try {
      if (!description && !customBranch && pendingImages.length === 0 && taskType === "worker") {
        localStorage.removeItem(draftKey)
      } else {
        localStorage.setItem(draftKey, JSON.stringify({ description, customBranch, taskType, pendingImages }))
      }
    } catch {
      // ignore storage failures
    }
  }, [draftKey, description, customBranch, taskType, pendingImages])

  const canSubmit = (!!description.trim() || pendingImages.length > 0) && !!current && !submitting

  const submitAndReset = useCallback((data: Parameters<typeof onSubmit>[0]) => {
    setSubmitting(true)
    onSubmit(data)
    try { localStorage.removeItem(draftKey) } catch { /* ignore */ }
    setTimeout(() => setSubmitting(false), 3000)
  }, [onSubmit, draftKey])

  const handleCodeSubmit = useCallback(() => {
    if (!current || submitting) return
    const trimmed = description.trim()
    if (!trimmed && pendingImages.length === 0) return

    const images = pendingImages.length > 0
      ? pendingImages.map(({ dataUrl: _, ...img }) => img)
      : undefined

    let fullDescription = trimmed
    if (refTaskId) {
      const refContext = [
        `[Context: This task continues from a previous task (ID: ${refTaskId}${refTaskTitle ? `, "${refTaskTitle}"` : ""}).`,
        `Load the tangerine-tasks skill (/tangerine-tasks) to access the Tangerine API, then retrieve the previous task's conversation and context via GET /api/tasks/${refTaskId}/messages to understand what was done before.]`,
      ].join(" ")
      fullDescription = fullDescription ? `${refContext}\n\n${fullDescription}` : refContext
    }

    submitAndReset({
      projectId: current.name,
      title: trimmed.slice(0, 80) || (refTaskTitle ? `Continue: ${refTaskTitle}`.slice(0, 80) : "New task"),
      description: fullDescription || undefined,
      branch: customBranch.trim() || undefined,
      provider,
      model: activeModel || undefined,
      reasoningEffort: reasoningEffort !== "medium" ? reasoningEffort : undefined,
      parentTaskId: refTaskId,
      type: taskType,
      images,
    })
  }, [current, submitting, description, pendingImages, customBranch, provider, activeModel, reasoningEffort, taskType, refTaskId, refTaskTitle, submitAndReset])

  const handleSubmit = handleCodeSubmit

  return (
    <div className="flex h-full flex-1 flex-col bg-surface">
      {/* Mobile header -- hidden on desktop */}
      <div className="flex h-[52px] items-center gap-3 border-b border-edge px-4 md:hidden">
        <button onClick={() => navigate("/")} aria-label="Back" className="text-fg">
          <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
          </svg>
        </button>
        <span className="text-[18px] font-semibold text-fg">New Agent</span>
      </div>

      {/* Desktop: centered card layout / Mobile: full-width scrollable */}
      <div className="flex flex-1 flex-col items-center overflow-y-auto px-4 pt-6 md:justify-center md:p-12">
        <div className="flex w-full max-w-[640px] flex-col gap-6">
          {/* Heading */}
          <div className="flex flex-col gap-2">
            <h1 className="text-[20px] font-semibold text-fg md:text-center md:text-2xl md:font-bold">
              What should the agent work on?
            </h1>
            <p className="hidden text-center text-sm leading-[1.6] text-fg-muted md:block">
              Describe a task, bug, or feature. The agent will read your codebase and get to work.
            </p>
          </div>

          {/* Worker / Reviewer toggle */}
          <div className="flex justify-center">
            <div className="inline-flex rounded-lg border border-edge bg-surface-secondary p-0.5">
              <button
                onClick={() => setTaskType("worker")}
                className={`rounded-md px-4 py-1.5 text-[13px] font-medium transition ${taskType === "worker" ? "bg-surface text-fg shadow-sm" : "text-fg-muted hover:text-fg"}`}
              >Worker</button>
              <button
                onClick={() => setTaskType("reviewer")}
                className={`rounded-md px-4 py-1.5 text-[13px] font-medium transition ${taskType === "reviewer" ? "bg-surface text-fg shadow-sm" : "text-fg-muted hover:text-fg"}`}
              >Reviewer</button>
            </div>
          </div>

          {/* Reference badge */}
          {refTaskId && (
            <div className="flex items-center gap-2 rounded-lg border border-accent-border bg-accent-bg px-3 py-2">
              <svg className="h-3.5 w-3.5 shrink-0 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244" />
              </svg>
              <span className="min-w-0 truncate text-[12px] text-accent-text">
                Continuing from: <span className="font-medium">{refTaskTitle || refTaskId}</span>
              </span>
              <span className="ml-auto font-mono text-[10px] text-accent-muted">{refTaskId.slice(0, 8)}</span>
            </div>
          )}

          {/* Input card */}
          <div className="overflow-visible rounded-xl border border-edge bg-surface">
            {pendingImages.length > 0 && (
              <div className="flex flex-wrap gap-1.5 px-4 pt-3">
                {pendingImages.map((img, i) => (
                  <div key={i} className="relative">
                    <img src={img.dataUrl} alt="Pasted image" className="h-14 w-14 rounded-md border border-edge object-cover" />
                    <button
                      onClick={() => removeImage(i)}
                      aria-label="Remove image"
                      className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-fg text-[10px] text-surface"
                    >×</button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  handleSubmit()
                }
              }}
              onPaste={handlePaste}
              placeholder="Describe the task, paste an issue URL, or continue work on a branch/PR..."
              rows={4}
              className="w-full resize-none border-0 bg-transparent px-4 pt-4 pb-2 text-[16px] leading-[1.6] text-fg placeholder-fg-muted outline-none md:text-[14px]"
            />
            {/* Desktop: inline controls below textarea */}
            <div className="hidden gap-2.5 overflow-visible border-t border-edge px-3 py-2.5 md:flex md:flex-col">
              <div className="flex items-center gap-2 overflow-visible">
                <HarnessSelector value={provider} onChange={handleProviderChange} />
                <div className="flex min-w-0 items-center gap-1.5 rounded-md border border-edge px-2 py-1">
                  <svg className="h-3 w-3 shrink-0 text-fg-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0-12.814a2.25 2.25 0 1 0 0-2.186m0 2.186a2.25 2.25 0 1 0 0 2.186" />
                  </svg>
                  <input
                    type="text"
                    value={customBranch}
                    onChange={(e) => setCustomBranch(e.target.value)}
                    placeholder={branch}
                    aria-label="Branch or PR"
                    className="max-w-[160px] bg-transparent text-[11px] text-fg placeholder-fg-muted outline-none"
                  />
                </div>
                <ModelSelector
                  models={providerModels}
                  model={activeModel}
                  onModelChange={handleModelChange}
                  menuPlacement="bottom"
                />
                <ReasoningEffortSelector value={reasoningEffort} onChange={(e) => { setReasoningEffort(e); savePrefs({ reasoningEffort: e }) }} provider={provider} />
              </div>
              <button
                onClick={handleSubmit}
                disabled={!canSubmit}
                className="flex w-full items-center justify-center gap-1.5 rounded-md bg-surface-dark px-4 py-2 text-white transition hover:opacity-80 disabled:opacity-30"
              >
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z" />
                </svg>
                <span className="text-[13px] font-medium">Start Agent</span>
              </button>
            </div>
          </div>

          {/* Mobile: harness/branch/model chips + full-width start button */}
          <div className="flex flex-col gap-6 md:hidden">
            <div className="flex flex-col gap-2">
              <div className="flex gap-2">
                <div className="flex h-10 flex-1 items-center gap-2 rounded-lg border border-edge bg-surface px-3">
                  <svg className="h-4 w-4 shrink-0 text-fg-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0-12.814a2.25 2.25 0 1 0 0-2.186m0 2.186a2.25 2.25 0 1 0 0 2.186" />
                  </svg>
                  <input
                    type="text"
                    value={customBranch}
                    onChange={(e) => setCustomBranch(e.target.value)}
                    placeholder={branch}
                    aria-label="Branch or PR"
                    className="min-w-0 flex-1 bg-transparent text-[13px] text-fg placeholder-fg-muted outline-none"
                  />
                </div>
                <div className="flex h-10 min-w-0 flex-1 items-center rounded-lg border border-edge bg-surface px-3">
                  <ModelSelector
                    models={providerModels}
                    model={activeModel}
                    onModelChange={handleModelChange}
                    menuPlacement="bottom"
                    borderless
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <select
                  value={provider}
                  onChange={(e) => handleProviderChange(e.target.value as ProviderType)}
                  aria-label="Harness"
                  className="h-10 flex-1 rounded-lg border border-edge bg-surface px-3 text-[16px] text-fg outline-none md:text-[13px]"
                >
                  <option value="opencode">OpenCode</option>
                  <option value="claude-code">Claude Code</option>
                  <option value="codex">Codex</option>
                </select>
                <select
                  value={reasoningEffort}
                  onChange={(e) => { const v = e.target.value as ReasoningEffort; setReasoningEffort(v); savePrefs({ reasoningEffort: v }) }}
                  aria-label="Reasoning effort"
                  className="h-10 flex-1 rounded-lg border border-edge bg-surface px-3 text-[16px] text-fg outline-none md:text-[13px]"
                >
                  {getEfforts(provider).map((e) => (
                    <option key={e.value} value={e.value}>Effort: {e.label}</option>
                  ))}
                </select>
              </div>
            </div>
            <button
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="flex h-12 w-full items-center justify-center gap-2 rounded-[10px] bg-surface-dark text-white transition hover:opacity-80 disabled:opacity-30"
            >
              <svg className="h-[18px] w-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z" />
              </svg>
              <span className="text-[16px] font-semibold">Start Agent</span>
            </button>
          </div>

          {/* Divider -- mobile only */}
          <div className="h-px bg-edge md:hidden" />

          {/* Suggested tasks -- desktop: flex-wrap with icons, mobile: 2x2 grid */}
          <div className="flex flex-col gap-3">
            <span className="text-[12px] font-medium text-fg-muted md:text-[12px]">Suggested tasks</span>
            {/* Desktop */}
            <div className="hidden flex-wrap gap-2 md:flex">
              {suggestedTasks.map((task) => (
                <button
                  key={task.label}
                  onClick={() => setDescription(task.label)}
                  className="flex items-center gap-1.5 rounded-lg border border-edge bg-surface px-3 py-1.5 text-[12px] text-fg transition hover:bg-surface-secondary"
                >
                  <TaskIcon icon={task.icon} />
                  {task.label}
                </button>
              ))}
            </div>
            {/* Mobile: 2x2 grid */}
            <div className="flex flex-col gap-2 md:hidden">
              <div className="flex gap-2">
                {suggestedTasks.slice(0, 2).map((task) => (
                  <button
                    key={task.label}
                    onClick={() => setDescription(task.label)}
                    className="flex h-9 items-center rounded-[18px] bg-surface-secondary px-3.5 text-[13px] text-fg transition active:bg-edge"
                  >
                    {task.label}
                  </button>
                ))}
              </div>
              <div className="flex gap-2">
                {suggestedTasks.slice(2).map((task) => (
                  <button
                    key={task.label}
                    onClick={() => setDescription(task.label)}
                    className="flex h-9 items-center rounded-[18px] bg-surface-secondary px-3.5 text-[13px] text-fg transition active:bg-edge"
                  >
                    {task.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  )
}
