import { useState, useCallback } from "react"
import { useProject } from "../context/ProjectContext"
import { ModelSelector } from "./ModelSelector"

interface NewAgentFormProps {
  onSubmit: (data: { projectId: string; title: string; description?: string; branch?: string }) => void
}

const suggestedTasks = [
  { icon: "bug", label: "Fix failing tests" },
  { icon: "wrench", label: "Write missing test" },
  { icon: "code", label: "Set up API client" },
  { icon: "sparkles", label: "Sync database models" },
]

export function NewAgentForm({ onSubmit }: NewAgentFormProps) {
  const { current } = useProject()
  const [description, setDescription] = useState("")
  const branch = current?.defaultBranch ?? "main"

  const handleSubmit = useCallback(() => {
    const trimmed = description.trim()
    if (!trimmed || !current) return
    onSubmit({
      projectId: current.name,
      title: trimmed.slice(0, 80),
      description: trimmed,
      branch,
    })
  }, [description, current, branch, onSubmit])

  return (
    <div className="flex h-full flex-1 items-center justify-center bg-[#fafafa] p-12">
      <div className="flex w-full max-w-[640px] flex-col gap-6">
        {/* Hero text */}
        <div className="flex flex-col gap-2">
          <h1 className="text-center text-2xl font-bold text-[#0a0a0a]">
            What should the agent work on?
          </h1>
          <p className="text-center text-sm leading-[1.6] text-[#737373]">
            Describe a task, bug, or feature. The agent will read your codebase and get to work.
          </p>
        </div>

        {/* Input card */}
        <div className="overflow-hidden rounded-xl border border-[#e5e5e5] bg-[#fafafa]">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. Refactor the auth middleware to support JWKS key rotation and add error handling for expired tokens"
            rows={4}
            className="w-full resize-none border-0 bg-transparent px-4 pt-4 pb-2 text-sm leading-[1.6] text-[#0a0a0a] placeholder-[#737373] outline-none"
          />
          <div className="flex items-center justify-between border-t border-[#e5e5e5] px-3 py-2.5">
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5 rounded-md border border-[#e5e5e5] px-2 py-1">
                <svg className="h-3 w-3 text-[#737373]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0-12.814a2.25 2.25 0 1 0 0-2.186m0 2.186a2.25 2.25 0 1 0 0 2.186" />
                </svg>
                <span className="text-[11px] text-[#0a0a0a]">{branch}</span>
              </div>
              <ModelSelector />
            </div>

            {/* Start button */}
            <button
              onClick={handleSubmit}
              disabled={!description.trim() || !current}
              className="flex items-center gap-1.5 rounded-md bg-[#171717] px-4 py-2 text-white transition hover:bg-[#333] disabled:opacity-30"
            >
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z" />
              </svg>
              <span className="text-[13px] font-medium">Start Agent</span>
            </button>
          </div>
        </div>

        {/* Suggested tasks */}
        <div className="flex flex-col gap-3">
          <span className="text-[12px] font-medium text-[#737373]">Suggested tasks</span>
          <div className="flex flex-wrap gap-2">
            {suggestedTasks.map((task) => (
              <button
                key={task.label}
                onClick={() => setDescription(task.label)}
                className="flex items-center gap-1.5 rounded-lg border border-[#e5e5e5] bg-[#fafafa] px-3 py-1.5 text-[12px] text-[#0a0a0a] transition hover:bg-[#f5f5f5]"
              >
                <svg className="h-3 w-3 text-[#737373]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  {task.icon === "bug" ? (
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 12.75c1.148 0 2.278.08 3.383.237 1.037.146 1.866.966 1.866 2.013 0 3.728-2.35 6.75-5.25 6.75S6.75 18.728 6.75 15c0-1.046.83-1.867 1.866-2.013A24.204 24.204 0 0 1 12 12.75Zm0 0c2.883 0 5.647.508 8.207 1.44a23.91 23.91 0 0 1-1.152 6.06M12 12.75c-2.883 0-5.647.508-8.208 1.44.125 2.104.52 4.136 1.153 6.06M12 12.75a2.25 2.25 0 0 0 2.248-2.354M12 12.75a2.25 2.25 0 0 1-2.248-2.354M12 8.25c.995 0 1.971-.08 2.922-.236.403-.066.74-.358.795-.762a3.778 3.778 0 0 0-.399-2.25M12 8.25c-.995 0-1.97-.08-2.922-.236-.402-.066-.74-.358-.795-.762a3.734 3.734 0 0 1 .4-2.253M12 8.25a2.25 2.25 0 0 0-2.248 2.146M12 8.25a2.25 2.25 0 0 1 2.248 2.146M8.683 5a6.032 6.032 0 0 1 6.634 0M7 6.5h10" />
                  ) : task.icon === "wrench" ? (
                    <path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17 17.25 21A2.652 2.652 0 0 0 21 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 1 1-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 0 0 4.486-6.336l-3.276 3.277a3.004 3.004 0 0 1-2.25-2.25l3.276-3.276a4.5 4.5 0 0 0-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085m-1.745 1.437L5.909 7.5H4.5L2.25 3.75l1.5-1.5L7.5 4.5v1.409l4.26 4.26m-1.745 1.437 1.745-1.437m6.615 8.206L15.75 15.75M4.867 19.125h.008v.008h-.008v-.008Z" />
                  ) : task.icon === "code" ? (
                    <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5" />
                  ) : (
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 0 0-2.455 2.456Z" />
                  )}
                </svg>
                {task.label}
              </button>
            ))}
          </div>
        </div>

      </div>
    </div>
  )
}
