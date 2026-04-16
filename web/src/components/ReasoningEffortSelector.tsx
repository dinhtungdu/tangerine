import type { ProviderType } from "@tangerine/shared"
import { Zap } from "lucide-react"
import { useProject } from "../context/ProjectContext"
import { Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectItem } from "@/components/ui/select"

interface EffortOption {
  value: string
  label: string
  description: string
}

const DEFAULT_EFFORTS: EffortOption[] = [
  { value: "low", label: "Low", description: "Quick, minimal thinking" },
  { value: "medium", label: "Medium", description: "Balanced (default)" },
  { value: "high", label: "High", description: "Extended reasoning" },
]

export function getEfforts(provider: ProviderType | undefined, providerMetadata: Record<string, EffortOption[]>): EffortOption[] {
  if (provider && providerMetadata[provider]?.length) {
    return providerMetadata[provider]
  }
  return DEFAULT_EFFORTS
}

export type ReasoningEffort = string

interface ReasoningEffortSelectorProps {
  value: ReasoningEffort
  onChange: (value: ReasoningEffort) => void
  provider?: ProviderType
  /** "ghost" = borderless (chat input); "default" = bordered with icon (new agent form) */
  variant?: "ghost" | "default"
}

export function ReasoningEffortSelector({ value, onChange, provider, variant = "ghost" }: ReasoningEffortSelectorProps) {
  const { providerMetadata } = useProject()

  const effortsByProvider: Record<string, EffortOption[]> = {}
  for (const [key, meta] of Object.entries(providerMetadata)) {
    effortsByProvider[key] = meta.reasoningEfforts
  }
  const efforts = getEfforts(provider, effortsByProvider)
  const current = efforts.find((e) => e.value === value) ?? efforts.find((e) => e.value === "medium") ?? efforts[0]!

  return (
    <Select
      value={value}
      onValueChange={(v) => {
        if (v) onChange(v as string)
      }}
    >
      <SelectTrigger size="sm" className={variant === "ghost" ? "border-0 bg-transparent p-0 dark:bg-transparent dark:hover:bg-transparent focus-visible:ring-1 focus-visible:ring-ring/50" : undefined}>
        {variant === "default" && <Zap className="h-3 w-3 text-muted-foreground" />}
        <SelectValue>{current.label}</SelectValue>
      </SelectTrigger>

      <SelectContent side="top" align="start" alignItemWithTrigger={false} className="min-w-[180px]">
        <SelectGroup>
          {efforts.map((e) => (
            <SelectItem key={e.value} value={e.value} className="flex flex-col items-start gap-0">
              <span className="text-xs">{e.label}</span>
              <span className="text-2xs text-muted-foreground">{e.description}</span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}
