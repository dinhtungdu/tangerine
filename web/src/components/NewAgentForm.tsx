import { useState, useCallback, useEffect, useRef, type ClipboardEvent } from "react"
import type { ProviderType, PromptImage } from "@tangerine/shared"
import { useProject } from "../context/ProjectContext"
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

function loadDraftFromKey(key: string): { description?: string; customBranch?: string; taskType?: "worker" | "reviewer"; pendingImages?: PendingImage[] } {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "{}") as { description?: string; customBranch?: string; taskType?: "worker" | "reviewer"; pendingImages?: PendingImage[] }
  } catch {
    return {}
  }
}

/* -- Main form -- */

export function NewAgentForm({ onSubmit, refTaskId, refTaskTitle }: NewAgentFormProps) {
  const { current, modelsByProvider } = useProject()
  const PREFS_KEY = "tangerine:agent-prefs"
  const draftKey = `tangerine:new-agent-draft:${current?.name ?? "unknown"}:${refTaskId ?? "new"}`

  // prevDraftKeyRef tracks the last draftKey the effects operated on, to detect project switches
  const prevDraftKeyRef = useRef(draftKey)

  const [description, setDescription] = useState(() => loadDraftFromKey(draftKey).description ?? "")
  const [customBranch, setCustomBranch] = useState(() => loadDraftFromKey(draftKey).customBranch ?? "")
  const [pendingImages, setPendingImages] = useState<PendingImage[]>(() => loadDraftFromKey(draftKey).pendingImages ?? [])

  const loadPrefs = (): { provider?: string; models?: Record<string, string>; reasoningEffort?: string } => {
    try { return JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") } catch { return {} }
  }
  const saved = loadPrefs()

  const [provider, setProvider] = useState<ProviderType>((saved.provider as ProviderType) ?? current?.defaultProvider ?? "claude-code")
  const [modelByProvider, setModelByProvider] = useState<Record<string, string>>(saved.models ?? {})
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>((saved.reasoningEffort as ReasoningEffort) ?? "medium")
  const [taskType, setTaskType] = useState<"worker" | "reviewer">(() => loadDraftFromKey(draftKey).taskType ?? "worker")
  const [submitting, setSubmitting] = useState(false)
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
    if (prevDraftKeyRef.current !== draftKey) {
      // Project (or refTask) changed — save old draft under the OLD key first,
      // then load the new draft. This prevents data loss if React batches the
      // text change with the project switch (skipping the intermediate save).
      const oldKey = prevDraftKeyRef.current
      try {
        if (!description && !customBranch && pendingImages.length === 0 && taskType === "worker") {
          localStorage.removeItem(oldKey)
        } else {
          localStorage.setItem(oldKey, JSON.stringify({ description, customBranch, taskType, pendingImages }))
        }
      } catch { /* ignore */ }

      prevDraftKeyRef.current = draftKey
      const draft = loadDraftFromKey(draftKey)
      setDescription(draft.description ?? "")
      setCustomBranch(draft.customBranch ?? "")
      setPendingImages(draft.pendingImages ?? [])
      setTaskType(draft.taskType ?? "worker")
      return
    }
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
    <div className="flex flex-1 flex-col bg-surface md:h-full">
      {/* Desktop: centered card layout / Mobile: full-width scrollable */}
      <div className="flex flex-1 flex-col items-center px-4 pt-6 pb-6 md:overflow-y-auto md:justify-center md:p-12">
        <div className="flex w-full max-w-[640px] flex-col gap-6">
          {/* Heading */}
          <div className="flex flex-col gap-2">
            <h1 className="text-xl font-semibold text-fg md:text-center md:text-2xl md:font-bold">
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
                className={`rounded-md px-4 py-1.5 text-md font-medium transition ${taskType === "worker" ? "bg-surface text-fg shadow-sm" : "text-fg-muted hover:text-fg"}`}
              >Worker</button>
              <button
                onClick={() => setTaskType("reviewer")}
                className={`rounded-md px-4 py-1.5 text-md font-medium transition ${taskType === "reviewer" ? "bg-surface text-fg shadow-sm" : "text-fg-muted hover:text-fg"}`}
              >Reviewer</button>
            </div>
          </div>

          {/* Reference badge */}
          {refTaskId && (
            <div className="flex items-center gap-2 rounded-lg border border-accent-border bg-accent-bg px-3 py-2">
              <svg className="h-3.5 w-3.5 shrink-0 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244" />
              </svg>
              <span className="min-w-0 truncate text-xs text-accent-text">
                Continuing from: <span className="font-medium">{refTaskTitle || refTaskId}</span>
              </span>
              <span className="ml-auto font-mono text-2xs text-accent-muted">{refTaskId.slice(0, 8)}</span>
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
                      className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-fg text-2xs text-surface"
                    >×</button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              autoFocus
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
              className="w-full resize-none border-0 bg-transparent px-4 pt-4 pb-2 text-base leading-[1.6] text-fg placeholder-fg-muted outline-none md:text-sm"
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
                    className="max-w-[160px] bg-transparent text-xxs text-fg placeholder-fg-muted outline-none"
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
                <span className="text-md font-medium">Start Agent</span>
              </button>
            </div>
          </div>

          {/* Mobile: harness/branch/model chips + full-width start button */}
          <div className="flex flex-col gap-6 md:hidden">
            <div className="flex flex-col gap-2">
              <div className="flex gap-2">
                <div className="flex h-10 items-center gap-2 rounded-lg border border-edge bg-surface px-3">
                  <svg className="h-4 w-4 shrink-0 text-fg-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0-12.814a2.25 2.25 0 1 0 0-2.186m0 2.186a2.25 2.25 0 1 0 0 2.186" />
                  </svg>
                  <input
                    type="text"
                    value={customBranch}
                    onChange={(e) => setCustomBranch(e.target.value)}
                    placeholder={branch}
                    aria-label="Branch or PR"
                    size={6}
                    className="w-16 min-w-0 bg-transparent text-base text-fg placeholder-fg-muted outline-none md:text-md"
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
                  className="h-10 flex-1 rounded-lg border border-edge bg-surface px-3 text-base text-fg outline-none md:text-md"
                >
                  <option value="opencode">OpenCode</option>
                  <option value="claude-code">Claude Code</option>
                  <option value="codex">Codex</option>
                </select>
                <select
                  value={reasoningEffort}
                  onChange={(e) => { const v = e.target.value as ReasoningEffort; setReasoningEffort(v); savePrefs({ reasoningEffort: v }) }}
                  aria-label="Reasoning effort"
                  className="h-10 flex-1 rounded-lg border border-edge bg-surface px-3 text-base text-fg outline-none md:text-md"
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
              <span className="text-base font-semibold">Start Agent</span>
            </button>
          </div>

        </div>
      </div>
    </div>
  )
}
