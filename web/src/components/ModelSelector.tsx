import { useCallback } from "react"
import { useProject } from "../context/ProjectContext"
import { formatModelName } from "../lib/format"
import { Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectItem } from "@/components/ui/select"

interface ModelSelectorProps {
  /** Override the model list (e.g. filtered by provider) */
  models?: string[]
  /** Override the currently selected model */
  model?: string
  /** Override the model change handler */
  onModelChange?: (model: string) => void
  /** Controls whether the menu opens above or below the trigger */
  menuPlacement?: "top" | "bottom"
}

export function ModelSelector({ models: propModels, model: propModel, onModelChange, menuPlacement = "top" }: ModelSelectorProps = {}) {
  const ctx = useProject()
  const model = propModel ?? ctx.model
  const fallbackProvider = ctx.current?.defaultProvider ?? "claude-code"
  const models = propModels ?? ctx.modelsByProvider[fallbackProvider] ?? []
  const setModel = onModelChange ?? ctx.setModel

  const handleChange = useCallback((v: string | null) => {
    if (v) setModel(v)
  }, [setModel])

  if (!model || !models.length) return null

  return (
    <Select value={model} onValueChange={handleChange}>
      <SelectTrigger size="sm" className="border-0 bg-transparent dark:bg-transparent dark:hover:bg-transparent focus-visible:ring-0">
        <SelectValue>{formatModelName(model)}</SelectValue>
      </SelectTrigger>
      <SelectContent side={menuPlacement === "bottom" ? "bottom" : "top"} align="start" alignItemWithTrigger={false}>
        <SelectGroup>
          {models.map((m) => (
            <SelectItem key={m} value={m}>
              {formatModelName(m)}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}
