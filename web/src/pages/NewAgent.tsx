import { useState, useCallback } from "react"
import { useNavigate } from "react-router-dom"
import { useProject } from "../context/ProjectContext"
import { createTask } from "../lib/api"
import { formatModelName } from "../lib/format"

/* ── Toggle row (module-level) ── */

function ToggleRow({ icon, label, defaultOn }: { icon: string; label: string; defaultOn?: boolean }) {
  const [on, setOn] = useState(defaultOn ?? false)

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        {icon === "terminal" ? (
          <svg className="h-4 w-4 text-[#737373]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="m5.25 4.5 7.5 7.5-7.5 7.5m6 0h6.75" />
          </svg>
        ) : (
          <svg className="h-4 w-4 text-[#737373]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 0 0 8.716-6.747M12 21a9.004 9.004 0 0 1-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 0 1 7.843 4.582M12 3a8.997 8.997 0 0 0-7.843 4.582m15.686 0A11.953 11.953 0 0 1 12 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0 1 21 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0 1 12 16.5a17.92 17.92 0 0 1-8.716-2.247m0 0A8.966 8.966 0 0 1 3 12c0-1.264.26-2.467.73-3.558" />
          </svg>
        )}
        <span className="text-[14px] text-[#0a0a0a]">{label}</span>
      </div>
      <button
        role="switch"
        aria-checked={on}
        aria-label={label}
        onClick={() => setOn(!on)}
        className={`relative h-[28px] w-[48px] rounded-full transition-colors ${on ? "bg-[#171717]" : "bg-[#e5e5e5]"}`}
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

const suggestedTasks = [
  ["Fix failing tests", "Add API docs"],
  ["Refactor DB queries", "Update deps"],
]

export function NewAgent() {
  const navigate = useNavigate()
  const { current, model } = useProject()
  const [description, setDescription] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const branch = current?.defaultBranch ?? "main"

  const handleSubmit = useCallback(async () => {
    const trimmed = description.trim()
    if (!trimmed || !current || submitting) return
    setSubmitting(true)
    try {
      const task = await createTask({
        projectId: current.name,
        title: trimmed.slice(0, 80),
        description: trimmed,
      })
      navigate(`/tasks/${task.id}`)
    } catch {
      // TODO: error toast
    } finally {
      setSubmitting(false)
    }
  }, [description, current, submitting, navigate])

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex h-[52px] items-center gap-3 border-b border-[#e5e5e5] px-4">
        <button onClick={() => navigate("/")} aria-label="Back" className="text-[#0a0a0a]">
          <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
          </svg>
        </button>
        <span className="text-[18px] font-semibold text-[#0a0a0a]">New Agent</span>
      </div>

      {/* Content */}
      <div className="flex flex-1 flex-col gap-6 overflow-y-auto px-4 pt-6">
        {/* Heading */}
        <span className="text-[20px] font-semibold text-[#0a0a0a]">
          What should the agent work on?
        </span>

        {/* Textarea */}
        <div className="h-[120px] overflow-hidden rounded-xl border border-[#e5e5e5] bg-[#fafafa] p-3">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Describe the task or paste an issue URL..."
            className="h-full w-full resize-none bg-transparent text-[14px] leading-[1.5] text-[#0a0a0a] placeholder-[#737373] outline-none"
          />
        </div>

        {/* Branch + Model selectors — equal width */}
        <div className="flex gap-2">
          <div className="flex h-10 flex-1 items-center gap-2 rounded-lg border border-[#e5e5e5] bg-[#fafafa] px-3">
            <svg className="h-4 w-4 shrink-0 text-[#737373]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0-12.814a2.25 2.25 0 1 0 0-2.186m0 2.186a2.25 2.25 0 1 0 0 2.186" />
            </svg>
            <span className="text-[13px] text-[#0a0a0a]">{branch}</span>
          </div>
          <div className="flex h-10 flex-1 items-center gap-2 rounded-lg border border-[#e5e5e5] bg-[#fafafa] px-3">
            <svg className="h-4 w-4 shrink-0 text-[#737373]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 3v1.5M4.5 8.25H3m18 0h-1.5M4.5 12H3m18 0h-1.5m-15 3.75H3m18 0h-1.5M8.25 19.5V21M12 3v1.5m0 15V21m3.75-18v1.5m0 15V21m-9-1.5h10.5a2.25 2.25 0 0 0 2.25-2.25V6.75a2.25 2.25 0 0 0-2.25-2.25H6.75A2.25 2.25 0 0 0 4.5 6.75v10.5a2.25 2.25 0 0 0 2.25 2.25Z" />
            </svg>
            <span className="text-[13px] text-[#0a0a0a]">{model ? formatModelName(model) : "claude-4"}</span>
          </div>
        </div>

        {/* Start button */}
        <button
          onClick={handleSubmit}
          disabled={!description.trim() || !current || submitting}
          className="flex h-12 w-full items-center justify-center gap-2 rounded-[10px] bg-[#171717] text-white transition hover:bg-[#333] disabled:opacity-30"
        >
          <svg className="h-[18px] w-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z" />
          </svg>
          <span className="text-[16px] font-semibold">Start Agent</span>
        </button>

        {/* Divider */}
        <div className="h-px bg-[#e5e5e5]" />

        {/* Suggested tasks */}
        <div className="flex flex-col gap-2">
          <span className="text-[13px] font-medium text-[#737373]">Suggested tasks</span>
          {suggestedTasks.map((row, i) => (
            <div key={i} className="flex gap-2">
              {row.map((task) => (
                <button
                  key={task}
                  onClick={() => setDescription(task)}
                  className="flex h-9 items-center rounded-[18px] bg-[#f5f5f5] px-3.5 text-[13px] text-[#0a0a0a] transition active:bg-[#ebebeb]"
                >
                  {task}
                </button>
              ))}
            </div>
          ))}
        </div>

        {/* Configuration */}
        <div className="flex flex-col gap-3 pb-8">
          <span className="text-[13px] font-medium text-[#737373]">Configuration</span>
          <ToggleRow icon="terminal" label="Terminal access" defaultOn />
          <ToggleRow icon="globe" label="Web access" defaultOn />
        </div>
      </div>
    </div>
  )
}
