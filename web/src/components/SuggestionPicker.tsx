import { useEffect, useRef, type Key, type ReactNode } from "react"

interface SuggestionPickerProps<T> {
  items: readonly T[]
  selectedIndex: number
  getKey: (item: T) => Key
  onSelect: (item: T) => void
  onHover: (index: number) => void
  maxHeightClassName?: string
  itemAlignClassName?: string
  children: (item: T, context: { index: number; isSelected: boolean }) => ReactNode
}

function joinClasses(...classes: Array<string | undefined>): string {
  return classes.filter(Boolean).join(" ")
}

export function SuggestionPicker<T>({
  items,
  selectedIndex,
  getKey,
  onSelect,
  onHover,
  maxHeightClassName = "max-h-52",
  itemAlignClassName = "items-center",
  children,
}: SuggestionPickerProps<T>) {
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const item = listRef.current?.children[selectedIndex] as HTMLElement | undefined
    item?.scrollIntoView({ block: "nearest" })
  }, [selectedIndex])

  if (items.length === 0) return null

  return (
    <div className="absolute bottom-full left-0 right-0 z-50 mb-1">
      <div
        ref={listRef}
        className={joinClasses(maxHeightClassName, "overflow-y-auto rounded-lg border border-border bg-background shadow-lg")}
      >
        {items.map((item, index) => {
          const isSelected = index === selectedIndex
          return (
            <button
              key={getKey(item)}
              onMouseDown={(event) => {
                event.preventDefault()
                onSelect(item)
              }}
              onMouseMove={() => onHover(index)}
              className={joinClasses(
                "flex w-full gap-2 px-3 py-2 text-left outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring/50",
                itemAlignClassName,
                isSelected ? "bg-muted" : undefined,
              )}
            >
              {children(item, { index, isSelected })}
            </button>
          )
        })}
      </div>
    </div>
  )
}
