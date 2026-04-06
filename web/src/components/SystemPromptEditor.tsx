import { useState, useCallback } from "react"
import { updateProject } from "../lib/api"
import { useProject } from "../context/ProjectContext"

interface SystemPromptEditorProps {
  project: string
  taskType: "worker" | "orchestrator" | "reviewer"
  title: string
  value?: string
  placeholder?: string
}

export function SystemPromptEditor({
  project,
  taskType,
  title,
  value: initial = "",
  placeholder = "Custom system prompt for this task type...",
}: SystemPromptEditorProps) {
  const { refreshProjects } = useProject()
  const [value, setValue] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<"idle" | "saved" | "error">("idle")

  const isDirty = value !== initial

  const handleSave = useCallback(async () => {
    setSaving(true)
    setStatus("idle")
    try {
      const trimmed = value.trim()
      await updateProject(project, {
        taskTypes: { [taskType]: { systemPrompt: trimmed || undefined } },
      })
      refreshProjects()
      setStatus("saved")
      setTimeout(() => setStatus("idle"), 2000)
    } catch {
      setStatus("error")
    } finally {
      setSaving(false)
    }
  }, [project, value, taskType, refreshProjects])

  return (
    <div className="flex flex-1 flex-col rounded-xl border border-edge bg-surface p-4 md:p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sub font-semibold text-fg md:text-base">{title}</h2>
        <div className="flex items-center gap-2">
          {status === "saved" && <span className="text-xs text-status-success">Saved</span>}
          {status === "error" && <span className="text-xs text-status-error">Failed to save</span>}
          <button
            onClick={handleSave}
            disabled={saving || !isDirty}
            className="rounded-md bg-surface-dark px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-30"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        rows={4}
        className="w-full resize-y rounded-md border border-edge bg-surface px-3 py-2 text-md text-fg placeholder-fg-faint outline-none focus:border-fg-faint"
      />
    </div>
  )
}
