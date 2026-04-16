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
      <div ref={listRef} className="max-h-52 overflow-y-auto rounded-lg border border-border bg-background shadow-lg">
        {skills.map((skill, i) => (
          <button
            key={skill}
            onMouseDown={(e) => {
              e.preventDefault()
              onSelect(skill)
            }}
            onMouseMove={() => onHover(i)}
            className={`flex w-full items-center gap-2 px-3 py-2 text-left outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring/50 ${
              i === selectedIndex ? "bg-muted" : ""
            }`}
          >
            <span className="shrink-0 font-mono text-xs text-orange-500">/</span>
            <span className="min-w-0 flex-1 truncate text-sm text-foreground">{skill}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
