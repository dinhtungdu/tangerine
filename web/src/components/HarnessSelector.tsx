import { DEFAULT_AGENT_ID, isProviderAvailable as checkProvider, type ProviderType, type SystemCapabilities } from "@tangerine/shared"
import { Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectItem } from "@/components/ui/select"
import { Terminal } from "lucide-react"
import { useProject } from "../context/ProjectContext"

interface HarnessSelectorProps {
  value: ProviderType
  onChange: (value: ProviderType) => void
  systemCapabilities?: SystemCapabilities | null
}

export function HarnessSelector({ value, onChange, systemCapabilities: capsRaw }: HarnessSelectorProps) {
  const { agents } = useProject()
  const systemCapabilities = capsRaw ?? null
  const harnesses = agents.length > 0
    ? agents.map((agent) => ({ value: agent.id, label: agent.name }))
    : Object.entries(systemCapabilities?.providers ?? { [DEFAULT_AGENT_ID]: { available: true, cliCommand: DEFAULT_AGENT_ID } })
      .map(([id]) => ({ value: id, label: id }))

  return (
    <Select
      value={value}
      onValueChange={(v) => {
        if (v) onChange(v as ProviderType)
      }}
    >
      <SelectTrigger size="sm">

        <Terminal className="h-3 w-3 text-muted-foreground" />
        <SelectValue>
          {harnesses.find((h) => h.value === value)?.label ?? value}
          {!checkProvider(systemCapabilities, value) && (
            <span className="text-2xs text-status-error-text">(not installed)</span>
          )}
        </SelectValue>
      </SelectTrigger>

      <SelectContent side="top" align="start" alignItemWithTrigger={false} className="min-w-[160px]">
        <SelectGroup>
          {harnesses.map((h) => {
            const available = checkProvider(systemCapabilities, h.value)
            const cliCmd = systemCapabilities?.providers[h.value]?.cliCommand
            return (
              <SelectItem
                key={h.value}
                value={h.value}
                disabled={!available}
                title={!available ? `Requires ${cliCmd ?? h.value} CLI` : undefined}
              >
                <span>{h.label}</span>
                {!available && <span className="text-2xs text-muted-foreground">(not installed)</span>}
              </SelectItem>
            )
          })}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}
