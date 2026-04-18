import { useState } from "react"
import { ChevronDown } from "lucide-react"
import type { ProviderType } from "@tangerine/shared"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { useProject } from "../context/ProjectContext"
import { formatModelName } from "../lib/format"
import { getEfforts } from "./ReasoningEffortSelector"

interface ModelEffortPopoverProps {
  models: string[]
  model: string
  onModelChange: (model: string) => void
  reasoningEffort?: string | null
  onReasoningEffortChange?: (effort: string) => void
  provider?: ProviderType
  /** Whether the model list is interactive (vs read-only display) */
  canChangeModel?: boolean
}

export function ModelEffortPopover({
  models,
  model,
  onModelChange,
  reasoningEffort,
  onReasoningEffortChange,
  provider,
  canChangeModel = true,
}: ModelEffortPopoverProps) {
  const [open, setOpen] = useState(false)
  const { providerMetadata } = useProject()

  const effortsByProvider: Record<string, { value: string; label: string; description: string }[]> = {}
  for (const [key, meta] of Object.entries(providerMetadata)) {
    effortsByProvider[key] = meta.reasoningEfforts
  }
  const efforts = getEfforts(provider, effortsByProvider)
  const currentEffort = efforts.find((e) => e.value === reasoningEffort) ?? efforts.find((e) => e.value === "medium") ?? efforts[0]

  const showEffort = !!onReasoningEffortChange

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="h-auto gap-1 border-0 bg-transparent px-1.5 py-1 text-xs text-muted-foreground hover:text-foreground dark:bg-transparent dark:hover:bg-transparent"
          />
        }
      >
        <span className="truncate max-w-[140px]">{formatModelName(model)}</span>
        {showEffort && currentEffort && (
          <span className="text-muted-foreground/60">· {currentEffort.label}</span>
        )}
        <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        className="w-auto max-w-none p-0"
      >
        <div className="flex">
          {/* Model column */}
          <div className="flex flex-col min-w-[160px]">
            <div className="px-3 py-2 text-2xs font-medium uppercase tracking-wide text-muted-foreground border-b border-border">
              Model
            </div>
            <div className="overflow-y-auto max-h-60 p-1">
              {models.map((m) => (
                <button
                  key={m}
                  onClick={() => {
                    if (canChangeModel) {
                      onModelChange(m)
                      setOpen(false)
                    }
                  }}
                  className={cn(
                    "w-full rounded px-2 py-1.5 text-left text-xs transition-colors",
                    "hover:bg-accent hover:text-accent-foreground",
                    m === model ? "bg-accent/60 font-medium" : "text-foreground",
                    !canChangeModel && "cursor-default opacity-60"
                  )}
                  disabled={!canChangeModel}
                >
                  {formatModelName(m)}
                </button>
              ))}
            </div>
          </div>

          {/* Effort column */}
          {showEffort && (
            <>
              <div className="w-px bg-border" />
              <div className="flex flex-col min-w-[160px]">
                <div className="px-3 py-2 text-2xs font-medium uppercase tracking-wide text-muted-foreground border-b border-border">
                  Effort
                </div>
                <div className="p-1">
                  {efforts.map((e) => (
                    <button
                      key={e.value}
                      onClick={() => {
                        onReasoningEffortChange!(e.value)
                        setOpen(false)
                      }}
                      className={cn(
                        "w-full rounded px-2 py-1.5 text-left transition-colors",
                        "hover:bg-accent hover:text-accent-foreground",
                        e.value === reasoningEffort ? "bg-accent/60" : ""
                      )}
                    >
                      <div className="text-xs font-medium">{e.label}</div>
                      <div className="text-2xs text-muted-foreground">{e.description}</div>
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
