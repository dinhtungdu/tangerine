import type { AgentSlashCommand } from "@tangerine/shared"
import { SuggestionPicker } from "./SuggestionPicker"

interface SlashCommandPickerProps {
  commands: AgentSlashCommand[]
  selectedIndex: number
  onSelect: (command: AgentSlashCommand) => void
  onHover: (index: number) => void
}

export function SlashCommandPicker({ commands, selectedIndex, onSelect, onHover }: SlashCommandPickerProps) {
  return (
    <SuggestionPicker
      items={commands}
      selectedIndex={selectedIndex}
      getKey={(command) => command.name}
      onSelect={onSelect}
      onHover={onHover}
      maxHeightClassName="max-h-64"
      itemAlignClassName="items-start"
    >
      {(command) => (
        <>
          <span className="mt-0.5 shrink-0 font-mono text-xs text-orange-500">/</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-mono text-sm text-foreground">{command.name}</span>
            {command.description && (
              <span className="block truncate text-xs text-muted-foreground">{command.description}</span>
            )}
            {command.input?.hint && (
              <span className="block truncate font-mono text-2xs text-muted-foreground/70">{command.input.hint}</span>
            )}
          </span>
        </>
      )}
    </SuggestionPicker>
  )
}
