import { useState } from "react"
import { Check, ChevronDown } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import { formatModelName } from "../lib/format"

export interface EffortOption {
  value: string
  label: string
  description: string
}

export interface HarnessSupport {
  model: boolean
  effort: boolean
  mode: boolean
}

interface ModelEffortPopoverProps {
  models: string[]
  model: string
  onModelChange: (model: string) => void
  reasoningEffort?: string | null
  onReasoningEffortChange?: (effort: string) => void
  provider?: string
  efforts?: EffortOption[]
  mode?: string | null
  modes?: EffortOption[]
  onModeChange?: (mode: string) => void
  /** Whether the model list is interactive (vs read-only display) */
  canChangeModel?: boolean
  /** ACP selectors advertised by the harness for this session. */
  harnessSupport?: HarnessSupport
}

export function ModelEffortPopover({
  models,
  model,
  onModelChange,
  reasoningEffort,
  onReasoningEffortChange,
  efforts: propEfforts,
  mode,
  modes,
  onModeChange,
  canChangeModel = true,
  harnessSupport,
}: ModelEffortPopoverProps) {
  const [open, setOpen] = useState(false)

  // Don't render if there's nothing to show
  const resolvedModel = model || models[0] || ""
  const efforts = propEfforts ?? []
  const showEffort = !!onReasoningEffortChange && efforts.length > 0
  const showMode = !!onModeChange && !!modes?.length
  if (!resolvedModel && !showEffort && !showMode) return null

  // Normalize to an effective value so trigger and highlight stay in sync
  const effectiveEffort = (efforts.find((e) => e.value === reasoningEffort) ?? efforts[0])?.value

  const effectiveMode = modes?.find((entry) => entry.value === mode)?.value ?? modes?.[0]?.value
  const harnessSupportItems = harnessSupport
    ? [
      { label: "Model", supported: harnessSupport.model },
      { label: "Effort", supported: harnessSupport.effort },
      { label: "Mode", supported: harnessSupport.mode },
    ]
    : []

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
        <span className="max-w-35 truncate">{formatModelName(resolvedModel)}</span>
        <ChevronDown data-icon="inline-end" />
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        className="w-lg max-w-[calc(100vw-16px)] overflow-hidden p-0"
      >
        {harnessSupport && (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
            <span className="mr-1 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              Harness supports
            </span>
            {harnessSupportItems.map((item) => (
              <Badge
                key={item.label}
                variant={item.supported ? "secondary" : "outline"}
                className={cn("h-5 text-2xs", !item.supported && "text-muted-foreground")}
              >
                {item.supported ? item.label : `No ${item.label}`}
              </Badge>
            ))}
          </div>
        )}
        <div className="flex flex-wrap">
          {/* Model column */}
          {resolvedModel && (
            <div className="flex min-w-35 flex-1 flex-col">
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
                      "h-auto w-full justify-start gap-1.5 px-2 py-1.5 text-xs",
                      m === resolvedModel && "bg-accent/60 font-medium"
                    )}
                  >
                    <Check
                      className={cn("size-3 shrink-0", m !== resolvedModel && "invisible")}
                    />
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
              <div className="flex min-w-35 flex-1 flex-col">
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
                        "h-auto w-full justify-start items-start gap-1.5 px-2 py-1.5",
                        e.value === effectiveEffort && "bg-accent/60"
                      )}
                    >
                      <Check
                        className={cn(
                          "mt-0.5 size-3 shrink-0",
                          e.value !== effectiveEffort && "invisible"
                        )}
                      />
                      <span className="flex flex-col items-start gap-0">
                        <span className="text-xs font-medium">{e.label}</span>
                        <span className="text-2xs text-muted-foreground">{e.description}</span>
                      </span>
                    </Button>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* Mode column */}
          {showMode && (
            <>
              {(resolvedModel || showEffort) && <Separator orientation="vertical" />}
              <div className="flex min-w-35 flex-1 flex-col">
                <div className="border-b border-border px-3 py-2 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                  Mode
                </div>
                <div className="p-1">
                  {modes!.map((entry) => (
                    <Button
                      key={entry.value}
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        onModeChange!(entry.value)
                        setOpen(false)
                      }}
                      className={cn(
                        "h-auto w-full justify-start items-start gap-1.5 px-2 py-1.5",
                        entry.value === effectiveMode && "bg-accent/60"
                      )}
                    >
                      <Check
                        className={cn(
                          "mt-0.5 size-3 shrink-0",
                          entry.value !== effectiveMode && "invisible"
                        )}
                      />
                      <span className="flex flex-col items-start gap-0">
                        <span className="text-xs font-medium">{entry.label}</span>
                        <span className="text-2xs text-muted-foreground">{entry.description}</span>
                      </span>
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
