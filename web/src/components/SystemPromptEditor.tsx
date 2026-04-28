import { useState, useCallback } from "react"
import { updateProject } from "../lib/api"
import { useProject } from "../context/ProjectContext"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

interface SystemPromptEditorProps {
  project: string
  taskType: "worker" | "reviewer" | "runner"
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
        taskTypes: { [taskType]: { systemPrompt: trimmed || null } },
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
    <div className="flex flex-1 flex-col rounded-xl border border-border bg-background p-4 md:p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sub font-semibold text-foreground md:text-base">{title}</h2>
        <div className="flex items-center gap-2">
          {status === "saved" && <span className="text-xs text-status-success">Saved</span>}
          {status === "error" && <span className="text-xs text-status-error">Failed to save</span>}
          <Button
            onClick={handleSave}
            disabled={saving || !isDirty}
            size="sm"
            className="px-3 py-1.5 text-xs font-medium"
          >
            {saving ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>
      <Textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        rows={4}
        className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder-muted-foreground/50 outline-none focus:border-muted-foreground/50"
      />
    </div>
  )
}
