import { useRef, useEffect } from "react"

interface SlashCommandPickerProps {
  skills: string[]
  selectedIndex: number
  onSelect: (skill: string) => void
  onHover: (index: number) => void
}

export function SlashCommandPicker({ skills, selectedIndex, onSelect, onHover }: SlashCommandPickerProps) {
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const item = listRef.current?.children[selectedIndex] as HTMLElement | undefined
    item?.scrollIntoView({ block: "nearest" })
  }, [selectedIndex])

  if (skills.length === 0) return null

  return (
    <div className="absolute bottom-full left-0 right-0 z-50 mb-1">
      <div ref={listRef} className="max-h-52 overflow-y-auto rounded-lg border border-edge bg-surface shadow-lg">
        {skills.map((skill, i) => (
          <button
            key={skill}
            onMouseDown={(e) => {
              e.preventDefault()
              onSelect(skill)
            }}
            onMouseMove={() => onHover(i)}
            className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors ${
              i === selectedIndex ? "bg-surface-secondary" : ""
            }`}
          >
            <span className="shrink-0 font-mono text-xs text-tangerine">/</span>
            <span className="min-w-0 flex-1 truncate text-sm text-fg">{skill}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
