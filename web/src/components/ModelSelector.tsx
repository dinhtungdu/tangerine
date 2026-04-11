import { useState, useCallback } from "react"
import { useProject } from "../context/ProjectContext"
import { formatModelName } from "../lib/format"
import { searchModels } from "../lib/model-search"
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover"
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from "@/components/ui/command"
import { ChevronsUpDown, Check, Sparkles } from "lucide-react"

interface ModelSelectorProps {
  /** Override the model list (e.g. filtered by provider) */
  models?: string[]
  /** Override the currently selected model */
  model?: string
  /** Override the model change handler */
  onModelChange?: (model: string) => void
  /** Controls whether the menu opens above or below the trigger */
  menuPlacement?: "top" | "bottom"
  /** Remove border/padding so parent container can provide them */
  borderless?: boolean
}

export function ModelSelector({ models: propModels, model: propModel, onModelChange, menuPlacement = "top", borderless = false }: ModelSelectorProps = {}) {
  const ctx = useProject()
  const model = propModel ?? ctx.model
  const fallbackProvider = ctx.current?.defaultProvider ?? "claude-code"
  const models = propModels ?? ctx.modelsByProvider[fallbackProvider] ?? []
  const setModel = onModelChange ?? ctx.setModel
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")

  const filtered = searchModels(models, search)

  const handleSelect = useCallback((m: string) => {
    setModel(m)
    setOpen(false)
  }, [setModel])

  if (!model || !models.length) return null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={`flex items-center gap-1.5 transition ${borderless ? "w-full" : "h-7 rounded-md border border-border px-2 py-1 hover:bg-muted"}`}
      >
        <Sparkles className="h-3 w-3 text-muted-foreground" />
        <span className={`min-w-0 truncate font-medium text-foreground ${borderless ? "text-base md:text-xxs" : "text-xxs"}`}>{formatModelName(model)}</span>
        <ChevronsUpDown className="h-2.5 w-2.5 text-muted-foreground" />
      </PopoverTrigger>

      <PopoverContent
        side={menuPlacement === "bottom" ? "bottom" : "top"}
        align="start"
        className="w-[260px] p-0"
      >
        <Command shouldFilter={false}>
          {models.length > 5 && (
            <CommandInput
              placeholder="Search models..."
              value={search}
              onValueChange={setSearch}
            />
          )}
          <CommandList className="max-h-[200px] md:max-h-[280px]">
            <CommandEmpty>No models match</CommandEmpty>
            <CommandGroup>
              {filtered.map((m) => {
                const isActive = m === model
                return (
                  <CommandItem
                    key={m}
                    value={m}
                    data-checked={isActive || undefined}
                    onSelect={() => handleSelect(m)}
                  >
                    <span>{formatModelName(m)}</span>
                    {isActive && (
                      <Check className="ml-auto h-3 w-3 text-foreground" />
                    )}
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
