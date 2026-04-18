import { useState } from "react"
import { ChevronDown } from "lucide-react"
import type { ProviderType } from "@tangerine/shared"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
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

  // Don't render if there's nothing to show
  const resolvedModel = model || models[0] || ""
  if (!resolvedModel && !onReasoningEffortChange) return null

  const effortsByProvider: Record<string, { value: string; label: string; description: string }[]> = {}
  for (const [key, meta] of Object.entries(providerMetadata)) {
    effortsByProvider[key] = meta.reasoningEfforts
  }
  const efforts = getEfforts(provider, effortsByProvider)
  // Normalize to an effective value so trigger and highlight stay in sync
  const effectiveEffort = (efforts.find((e) => e.value === reasoningEffort) ?? efforts.find((e) => e.value === "medium") ?? efforts[0])?.value
  const currentEffortLabel = efforts.find((e) => e.value === effectiveEffort)?.label

  const showEffort = !!onReasoningEffortChange

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="h-auto gap-1 border-0 bg-transparent px-1.5 py-1 text-xs text-muted-foreground hover:text-foreground"
          />
        }
      >
        <span className="max-w-[140px] truncate">{formatModelName(resolvedModel)}</span>
        {showEffort && currentEffortLabel && (
          <span className="text-muted-foreground/60">· {currentEffortLabel}</span>
        )}
        <ChevronDown data-icon="inline-end" />
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={6} className="w-auto max-w-none p-0">
        <div className="flex">
          {/* Model column */}
          {resolvedModel && (
            <div className="flex min-w-[160px] flex-col">
              <div className="border-b border-border px-3 py-2 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                Model
              </div>
              <div className="max-h-60 overflow-y-auto p-1">
                {models.map((m) => (
                  <Button
                    key={m}
                    variant="ghost"
                    size="sm"
                    disabled={!canChangeModel}
                    onClick={() => {
                      if (canChangeModel) {
                        onModelChange(m)
                        setOpen(false)
                      }
                    }}
                    className={cn(
                      "h-auto w-full justify-start px-2 py-1.5 text-xs",
                      m === resolvedModel && "bg-accent/60 font-medium"
                    )}
                  >
                    {formatModelName(m)}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {/* Effort column */}
          {showEffort && (
            <>
              {resolvedModel && <Separator orientation="vertical" />}
              <div className="flex min-w-[160px] flex-col">
                <div className="border-b border-border px-3 py-2 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                  Effort
                </div>
                <div className="p-1">
                  {efforts.map((e) => (
                    <Button
                      key={e.value}
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        onReasoningEffortChange!(e.value)
                        setOpen(false)
                      }}
                      className={cn(
                        "h-auto w-full flex-col items-start gap-0 px-2 py-1.5",
                        e.value === effectiveEffort && "bg-accent/60"
                      )}
                    >
                      <span className="text-xs font-medium">{e.label}</span>
                      <span className="text-2xs text-muted-foreground">{e.description}</span>
                    </Button>
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
