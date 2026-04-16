import { useState, useCallback, useEffect, useRef, forwardRef, useImperativeHandle, type ClipboardEvent, type KeyboardEvent } from "react"
import { isGithubRepo, isProviderAvailable, getCapabilitiesForType, SUPPORTED_PROVIDERS, type ProviderType, type PromptImage, type Task, type TaskType } from "@tangerine/shared"
import { useProject } from "../context/ProjectContext"
import { ModelSelector } from "./ModelSelector"
import { HarnessSelector } from "./HarnessSelector"
import { ReasoningEffortSelector, type ReasoningEffort } from "./ReasoningEffortSelector"
import { MentionPicker } from "./MentionPicker"
import { useMentionPicker } from "../hooks/useMentionPicker"
import { useTasks } from "../hooks/useTasks"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { ProjectSelector } from "./ProjectSelector"
import { BranchInput } from "./BranchInput"

export interface NewAgentFormHandle {
  focus(): void
}

interface NewAgentFormProps {
  onSubmit: (data: { projectId: string; title: string; description?: string; branch?: string; provider?: string; model?: string; reasoningEffort?: string; parentTaskId?: string; type?: string; images?: PromptImage[] }) => void
  refTaskId?: string
  refTaskTitle?: string
  refBranch?: string
  refProjectId?: string
  autoFocus?: boolean
}

interface PendingImage extends PromptImage {
  dataUrl: string
}

/** Task types selectable in the form — excludes orchestrator (system-managed) */
type FormTaskType = Exclude<TaskType, "orchestrator">

function loadDraftFromKey(key: string): { description?: string; customBranch?: string; taskType?: FormTaskType; pendingImages?: PendingImage[] } {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "{}") as { description?: string; customBranch?: string; taskType?: FormTaskType; pendingImages?: PendingImage[] }
  } catch {
    return {}
  }
}

/* -- Main form -- */

export const NewAgentForm = forwardRef<NewAgentFormHandle, NewAgentFormProps>(function NewAgentForm({ onSubmit, refTaskId, refTaskTitle, refBranch, refProjectId, autoFocus }: NewAgentFormProps, ref) {
  const { current, projects, modelsByProvider, systemCapabilities, providerMetadata } = useProject()
  const PREFS_KEY = "tangerine:agent-prefs"

  // selectedProjectName is set when the user explicitly picks a project or when
  // refProjectId is provided (continue flow). Empty means "use context default".
  const [selectedProjectName, setSelectedProjectName] = useState<string>(refProjectId ?? "")

  const activeProjects = projects.filter((p) => !p.archived)
  // When no explicit selection, fall back to the URL project (current).
  const effectiveProject = projects.find((p) => p.name === selectedProjectName) ?? current

  const draftKey = `tangerine:new-agent-draft:${effectiveProject?.name ?? "unknown"}:${refTaskId ?? "new"}`

  // prevDraftKeyRef tracks the last draftKey the effects operated on, to detect project switches
  const prevDraftKeyRef = useRef(draftKey)

  const [description, setDescription] = useState(() => loadDraftFromKey(draftKey).description ?? "")
  const [customBranch, setCustomBranch] = useState(() => loadDraftFromKey(draftKey).customBranch ?? refBranch ?? "")
  const [pendingImages, setPendingImages] = useState<PendingImage[]>(() => loadDraftFromKey(draftKey).pendingImages ?? [])

  const loadPrefs = (): { provider?: string; models?: Record<string, string>; reasoningEffort?: string } => {
    try { return JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") } catch { return {} }
  }
  const saved = loadPrefs()

  const defaultProvider = (() => {
    const preferred = (saved.provider as ProviderType) ?? effectiveProject?.defaultProvider ?? "claude-code"
    if (isProviderAvailable(systemCapabilities, preferred)) return preferred
    const available = SUPPORTED_PROVIDERS.find((p) => isProviderAvailable(systemCapabilities, p))
    return (available ?? preferred) as ProviderType
  })()

  const [provider, setProvider] = useState<ProviderType>(defaultProvider)
  const [modelByProvider, setModelByProvider] = useState<Record<string, string>>(saved.models ?? {})
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>((saved.reasoningEffort as ReasoningEffort) ?? "medium")

  // Resync provider once systemCapabilities loads (initially null → object)
  const capsLoadedRef = useRef(false)
  useEffect(() => {
    if (!systemCapabilities || capsLoadedRef.current) return
    capsLoadedRef.current = true
    if (!isProviderAvailable(systemCapabilities, provider)) {
      const available = SUPPORTED_PROVIDERS.find((p) => isProviderAvailable(systemCapabilities, p))
      if (available) setProvider(available as ProviderType)
    }
  }, [systemCapabilities, provider])
  const [taskType, setTaskType] = useState<FormTaskType>(() => loadDraftFromKey(draftKey).taskType ?? "worker")
  const [submitting, setSubmitting] = useState(false)
  const branch = effectiveProject?.defaultBranch ?? "main"

  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useImperativeHandle(ref, () => ({
    focus() { textareaRef.current?.focus() },
  }))

  const { tasks: allTasks } = useTasks({ project: effectiveProject?.name })
  const mention = useMentionPicker(allTasks)
  const mentionRef = useRef(mention)
  mentionRef.current = mention
  const descriptionRef = useRef(description)
  descriptionRef.current = description

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
    // Reset reasoningEffort if the current value is invalid for the new provider
    const meta = providerMetadata[p]
    if (meta?.reasoningEfforts.length) {
      const validValues = meta.reasoningEfforts.map((e) => e.value)
      if (!validValues.includes(reasoningEffort)) {
        const fallback = meta.reasoningEfforts.find((e) => e.value === "medium") ?? meta.reasoningEfforts[0]!
        setReasoningEffort(fallback.value as ReasoningEffort)
        savePrefs({ reasoningEffort: fallback.value })
      }
    }
  }, [savePrefs, providerMetadata, reasoningEffort])

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

  const handleMentionSelect = useCallback((task: Task) => {
    const { newText, cursorPos } = mentionRef.current.selectTask(task, descriptionRef.current)
    setDescription(newText)
    requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea) return
      textarea.setSelectionRange(cursorPos, cursorPos)
      textarea.focus()
    })
  }, [])

  useEffect(() => {
    if (prevDraftKeyRef.current !== draftKey) {
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
      setCustomBranch(draft.customBranch ?? refBranch ?? "")
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

  const providerAvailable = isProviderAvailable(systemCapabilities, provider)
  const canSubmit = (!!description.trim() || pendingImages.length > 0) && !!effectiveProject && !submitting && providerAvailable

  const submitAndReset = useCallback((data: Parameters<typeof onSubmit>[0]) => {
    setSubmitting(true)
    onSubmit(data)
    try { localStorage.removeItem(draftKey) } catch { /* ignore */ }
    setTimeout(() => setSubmitting(false), 3000)
  }, [onSubmit, draftKey])

  const handleCodeSubmit = useCallback(() => {
    if (!effectiveProject || submitting) return
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
      projectId: effectiveProject.name,
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
  }, [effectiveProject, submitting, description, pendingImages, customBranch, provider, activeModel, reasoningEffort, taskType, refTaskId, refTaskTitle, submitAndReset])

  const handleSubmit = handleCodeSubmit

  return (
    <div className="flex flex-1 flex-col bg-background md:h-full">
      {/* Desktop: centered card layout / Mobile: full-width scrollable */}
      <div className="flex flex-1 flex-col items-center px-4 pt-6 pb-6 md:overflow-y-auto md:justify-center md:p-12">
        <div className="flex w-full max-w-[640px] flex-col gap-6">
          {/* Heading */}
          <div className="flex flex-col gap-2">
            <h1 className="text-xl font-semibold text-foreground md:text-center md:text-2xl md:font-bold">
              What should the agent work on?
            </h1>
            <p className="text-center text-sm leading-[1.6] text-muted-foreground">
              Describe a task, bug, or feature. The agent will read your codebase and get to work.
            </p>
          </div>

          {/* Worker / Reviewer / Runner toggle */}
          <div className="flex justify-center">
            <div className="inline-flex rounded-lg border border-border bg-muted p-0.5">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setTaskType("worker")}
                className={`rounded-md px-4 py-1.5 text-sm font-medium ${taskType === "worker" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
              >Worker</Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setTaskType("reviewer")}
                className={`rounded-md px-4 py-1.5 text-sm font-medium ${taskType === "reviewer" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
              >Reviewer</Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setTaskType("runner")}
                className={`rounded-md px-4 py-1.5 text-sm font-medium ${taskType === "runner" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
              >Runner</Button>
            </div>
          </div>

          {/* Reference badge */}
          {refTaskId && (
            <div className="flex items-center gap-2 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/20 px-3 py-2">
              <svg className="h-3.5 w-3.5 shrink-0 text-blue-600 dark:text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244" />
              </svg>
              <span className="min-w-0 truncate text-xs text-blue-700 dark:text-blue-300">
                Continuing from: <span className="font-medium">{refTaskTitle || refTaskId}</span>
              </span>
              <span className="ml-auto font-mono text-2xs text-blue-400 dark:text-blue-500">{refTaskId.slice(0, 8)}</span>
            </div>
          )}

          {/* gh CLI warning for GitHub-backed projects */}
          {(() => {
            if (!systemCapabilities || !effectiveProject?.repo || !isGithubRepo(effectiveProject.repo)) return null
            const msg = !systemCapabilities.gh.available
              ? "gh CLI not installed — PR creation and tracking unavailable"
              : !systemCapabilities.gh.authenticated
                ? <>gh CLI not authenticated — run <code className="font-mono">gh auth login</code> for PR features</>
                : null
            if (!msg) return null
            return (
              <div className="flex items-center gap-2 rounded-lg border border-status-warning-text/20 bg-status-warning-bg px-3 py-2 text-xs text-status-warning-text">
                <svg className="h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
                </svg>
                <span>{msg}</span>
              </div>
            )
          })()}

          {/* Input card */}
          <div className="overflow-visible rounded-xl border border-border bg-background transition-colors focus-within:border-ring focus-within:ring-1 focus-within:ring-ring/50">
            {pendingImages.length > 0 && (
              <div className="flex flex-wrap gap-1.5 px-4 pt-3">
                {pendingImages.map((img, i) => (
                  <div key={i} className="relative">
                    <img src={img.dataUrl} alt="Pasted image" className="h-14 w-14 rounded-md border border-border object-cover" />
                    <button
                      onClick={() => removeImage(i)}
                      aria-label="Remove image"
                      className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-foreground text-2xs text-background"
                    >×</button>
                  </div>
                ))}
              </div>
            )}
            <div className="relative">
              {mention.state.isOpen && (
                <MentionPicker
                  tasks={mention.filteredTasks}
                  selectedIndex={mention.state.selectedIndex}
                  onSelect={handleMentionSelect}
                  onHover={(i) => mention.setSelectedIndex(i)}
                />
              )}
              <Textarea
                ref={textareaRef}
                id="new-agent-textarea"
                autoFocus={autoFocus}
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value)
                  mention.onTextChange(e.target.value, e.target.selectionStart ?? e.target.value.length)
                }}
                onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
                  const m = mentionRef.current
                  if (m.state.isOpen) {
                    const selectedTask = m.filteredTasks[m.state.selectedIndex]
                    if ((e.key === "Enter" || e.key === "Tab") && selectedTask) {
                      e.preventDefault()
                      handleMentionSelect(selectedTask)
                      return
                    }
                    if (m.onKeyDown(e)) return
                  }
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault()
                    handleSubmit()
                  }
                }}
                onBlur={() => mention.close()}
                onPaste={handlePaste}
                placeholder="Describe the task, paste an issue URL, or continue work on a branch/PR..."
                rows={4}
                className="w-full min-h-[8rem] resize-none rounded-none border-0 bg-transparent px-4 pt-4 pb-2 text-base leading-[1.6] text-foreground placeholder-muted-foreground shadow-none outline-none ring-0 focus-visible:ring-0 focus-visible:border-0 md:text-sm scroll-mt-4"
              />
            </div>
            {/* Inline controls below textarea */}
            <div className="flex flex-col gap-2.5 overflow-visible border-t border-border px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2 overflow-visible">
                {activeProjects.length > 0 && (
                  <ProjectSelector
                    projects={projects}
                    value={selectedProjectName || (effectiveProject?.name ?? "")}
                    onChange={(v) => { if (v) setSelectedProjectName(v) }}
                    side="top"
                    size="sm"
                  />
                )}
                <HarnessSelector value={provider} onChange={handleProviderChange} systemCapabilities={systemCapabilities} />
                <ModelSelector
                  models={providerModels}
                  model={activeModel}
                  onModelChange={handleModelChange}
                  menuPlacement="bottom"
                  variant="default"
                />
                <ReasoningEffortSelector value={reasoningEffort} onChange={(e) => { setReasoningEffort(e); savePrefs({ reasoningEffort: e }) }} provider={provider} variant="default" />
                {getCapabilitiesForType(taskType).includes("pr-track") && (
                  <BranchInput
                    value={customBranch}
                    onChange={setCustomBranch}
                    placeholder={branch}
                    aria-label="Branch or PR"
                    className="h-7 max-w-[180px] text-sm"
                  />
                )}
              </div>
              <Button
                onClick={handleSubmit}
                disabled={!canSubmit}
                className="flex w-full items-center justify-center gap-1.5 rounded-md px-4 py-2.5"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z" />
                </svg>
                <span className="text-sm font-semibold">Start Agent</span>
              </Button>
            </div>
          </div>

        </div>
      </div>
    </div>
  )
})
