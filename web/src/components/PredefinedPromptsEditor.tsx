import { useState, useCallback } from "react"
import type { PredefinedPrompt } from "@tangerine/shared"
import { updateProject } from "../lib/api"
import { useProject } from "../context/ProjectContext"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

interface PredefinedPromptsEditorProps {
  project: string
  prompts: PredefinedPrompt[]
  title?: string
  taskType: "worker" | "reviewer" | "runner"
}

export function PredefinedPromptsEditor({
  project,
  prompts: initial,
  title = "Predefined Prompts",
  taskType,
}: PredefinedPromptsEditorProps) {
  const { refreshProjects } = useProject()
  const [prompts, setPrompts] = useState<PredefinedPrompt[]>(initial)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<"idle" | "saved" | "error">("idle")

  const isDirty = JSON.stringify(prompts) !== JSON.stringify(initial)

  const handleAdd = useCallback(() => {
    setPrompts((prev) => [...prev, { label: "", text: "" }])
  }, [])

  const handleRemove = useCallback((index: number) => {
    setPrompts((prev) => prev.filter((_, i) => i !== index))
  }, [])

  const handleChange = useCallback((index: number, field: "label" | "text", value: string) => {
    setPrompts((prev) => prev.map((p, i) => (i === index ? { ...p, [field]: value } : p)))
  }, [])

  const handleSave = useCallback(async () => {
    setSaving(true)
    setStatus("idle")
    try {
      const valid = prompts.filter((p) => p.label.trim() && p.text.trim())
      await updateProject(project, {
        taskTypes: { [taskType]: { predefinedPrompts: valid } },
      })
      setPrompts(valid)
      refreshProjects()
      setStatus("saved")
      setTimeout(() => setStatus("idle"), 2000)
    } catch {
      setStatus("error")
    } finally {
      setSaving(false)
    }
  }, [project, prompts, taskType, refreshProjects])

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

      <div className="flex flex-col gap-2">
        {prompts.map((prompt, i) => (
          <div key={i} className="flex items-start gap-2">
            <Input
              type="text"
              value={prompt.label}
              onChange={(e) => handleChange(i, "label", e.target.value)}
              placeholder="Label"
              className="w-28 shrink-0 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground placeholder-muted-foreground/50 outline-none focus:border-muted-foreground/50"
            />
            <Input
              type="text"
              value={prompt.text}
              onChange={(e) => handleChange(i, "text", e.target.value)}
              placeholder="Prompt text sent to agent..."
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground placeholder-muted-foreground/50 outline-none focus:border-muted-foreground/50"
            />
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => handleRemove(i)}
              aria-label="Remove prompt"
              className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
              </svg>
            </Button>
          </div>
        ))}
      </div>

      <Button
        variant="ghost"
        size="sm"
        onClick={handleAdd}
        className="mt-2 flex w-fit items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
      >
        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
        </svg>
        Add prompt
      </Button>
    </div>
  )
}
