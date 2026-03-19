import { useState, useCallback } from "react"
import { useNavigate } from "react-router-dom"
import type { ProviderType } from "@tangerine/shared"
import { useProject } from "../context/ProjectContext"
import { ModelSelector } from "./ModelSelector"
import { HarnessSelector } from "./HarnessSelector"
import { formatModelName } from "../lib/format"

interface NewAgentFormProps {
  onSubmit: (data: { projectId: string; title: string; description?: string; branch?: string; provider?: string }) => void
}

const suggestedTasks = [
  { icon: "bug", label: "Fix failing tests" },
  { icon: "wrench", label: "Add API docs" },
  { icon: "code", label: "Refactor DB queries" },
  { icon: "sparkles", label: "Update deps" },
]

/* -- Toggle row -- */

function ToggleRow({ icon, label, defaultOn }: { icon: string; label: string; defaultOn?: boolean }) {
  const [on, setOn] = useState(defaultOn ?? false)

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        {icon === "terminal" ? (
          <svg className="h-4 w-4 text-fg-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="m5.25 4.5 7.5 7.5-7.5 7.5m6 0h6.75" />
          </svg>
        ) : (
          <svg className="h-4 w-4 text-fg-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 0 0 8.716-6.747M12 21a9.004 9.004 0 0 1-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 0 1 7.843 4.582M12 3a8.997 8.997 0 0 0-7.843 4.582m15.686 0A11.953 11.953 0 0 1 12 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0 1 21 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0 1 12 16.5a17.92 17.92 0 0 1-8.716-2.247m0 0A8.966 8.966 0 0 1 3 12c0-1.264.26-2.467.73-3.558" />
          </svg>
        )}
        <span className="text-[14px] text-fg">{label}</span>
      </div>
      <button
        role="switch"
        aria-checked={on}
        aria-label={label}
        onClick={() => setOn(!on)}
        className={`relative h-[28px] w-[48px] rounded-full transition-colors ${on ? "bg-surface-dark" : "bg-edge"}`}
      >
        <div
          className={`absolute top-[3px] h-[22px] w-[22px] rounded-full bg-white shadow-sm transition-transform ${
            on ? "translate-x-[23px]" : "translate-x-[3px]"
          }`}
        />
      </button>
    </div>
  )
}

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

export function NewAgentForm({ onSubmit }: NewAgentFormProps) {
  const navigate = useNavigate()
  const { current, modelsByProvider } = useProject()
  const [description, setDescription] = useState("")
  const [provider, setProvider] = useState<ProviderType>(current?.defaultProvider ?? "opencode")
  const [selectedModel, setSelectedModel] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const branch = current?.defaultBranch ?? "main"

  // Models available for the selected harness
  const providerModels = modelsByProvider[provider] ?? []
  const activeModel = selectedModel && providerModels.includes(selectedModel)
    ? selectedModel
    : providerModels[0] ?? ""

  const handleProviderChange = useCallback((p: ProviderType) => {
    setProvider(p)
    setSelectedModel(null) // reset model when switching harness
  }, [])

  const handleModelChange = useCallback((m: string) => {
    setSelectedModel(m)
  }, [])

  const handleSubmit = useCallback(() => {
    const trimmed = description.trim()
    if (!trimmed || !current || submitting) return
    setSubmitting(true)
    onSubmit({
      projectId: current.name,
      title: trimmed.slice(0, 80),
      description: trimmed,
      branch,
      provider,
    })
    // Parent navigates on success; reset submitting if it fails
    setTimeout(() => setSubmitting(false), 3000)
  }, [description, current, branch, provider, submitting, onSubmit])

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

          {/* Input card */}
          <div className="overflow-hidden rounded-xl border border-edge bg-surface">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe the task or paste an issue URL..."
              rows={4}
              className="w-full resize-none border-0 bg-transparent px-4 pt-4 pb-2 text-[16px] leading-[1.6] text-fg placeholder-fg-muted outline-none md:text-[14px]"
            />
            {/* Desktop: inline controls below textarea */}
            <div className="hidden items-center justify-between border-t border-edge px-3 py-2.5 md:flex">
              <div className="flex items-center gap-2">
                <HarnessSelector value={provider} onChange={handleProviderChange} />
                <div className="flex items-center gap-1.5 rounded-md border border-edge px-2 py-1">
                  <svg className="h-3 w-3 text-fg-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0-12.814a2.25 2.25 0 1 0 0-2.186m0 2.186a2.25 2.25 0 1 0 0 2.186" />
                  </svg>
                  <span className="text-[11px] text-fg">{branch}</span>
                </div>
                <ModelSelector
                  models={providerModels}
                  model={activeModel}
                  onModelChange={handleModelChange}
                />
              </div>
              <button
                onClick={handleSubmit}
                disabled={!description.trim() || !current || submitting}
                className="flex items-center gap-1.5 rounded-md bg-surface-dark px-4 py-2 text-white transition hover:bg-neutral-800 disabled:opacity-30"
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
                  <span className="text-[13px] text-fg">{branch}</span>
                </div>
                <div className="flex h-10 flex-1 items-center rounded-lg border border-edge bg-surface px-3">
                  <ModelSelector
                    models={providerModels}
                    model={activeModel}
                    onModelChange={handleModelChange}
                  />
                </div>
              </div>
              <select
                value={provider}
                onChange={(e) => handleProviderChange(e.target.value as ProviderType)}
                aria-label="Harness"
                className="h-10 w-full rounded-lg border border-edge bg-surface px-3 text-[16px] text-fg outline-none md:text-[13px]"
              >
                <option value="opencode">OpenCode</option>
                <option value="claude-code">Claude Code</option>
              </select>
            </div>
            <button
              onClick={handleSubmit}
              disabled={!description.trim() || !current || submitting}
              className="flex h-12 w-full items-center justify-center gap-2 rounded-[10px] bg-surface-dark text-white transition hover:bg-neutral-800 disabled:opacity-30"
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
                    className="flex h-9 items-center rounded-[18px] bg-surface-secondary px-3.5 text-[13px] text-fg transition active:bg-neutral-200"
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
                    className="flex h-9 items-center rounded-[18px] bg-surface-secondary px-3.5 text-[13px] text-fg transition active:bg-neutral-200"
                  >
                    {task.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Configuration -- mobile only */}
          <div className="flex flex-col gap-3 pb-8 md:hidden">
            <span className="text-[13px] font-medium text-fg-muted">Configuration</span>
            <ToggleRow icon="terminal" label="Terminal access" defaultOn />
            <ToggleRow icon="globe" label="Web access" defaultOn />
          </div>
        </div>
      </div>
    </div>
  )
}
