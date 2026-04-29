import { ChevronRight, Brain } from "lucide-react"
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"

interface ThoughtBlockProps {
  content: string
  expanded: boolean
  duration: number | null
  streaming: boolean
  onToggle: () => void
}

export function ThoughtBlock({
  content,
  expanded,
  duration,
  streaming,
  onToggle,
}: ThoughtBlockProps) {
  const label = streaming
    ? "Thinking..."
    : duration !== null
      ? `Thought for ${duration}s`
      : "Thought"

  return (
    <Collapsible open={expanded} onOpenChange={onToggle}>
      <CollapsibleTrigger
        className={cn(
          "flex items-center gap-2 text-sm text-muted-foreground",
          "hover:text-foreground transition-colors cursor-pointer",
          "py-1"
        )}
      >
        <ChevronRight
          className={cn(
            "size-4 transition-transform",
            expanded && "rotate-90"
          )}
          data-icon
        />
        <Brain className={cn("size-4", streaming && "animate-pulse")} data-icon />
        <span>{label}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="pl-6 pt-2 text-sm text-muted-foreground whitespace-pre-wrap">
        {content}
      </CollapsibleContent>
    </Collapsible>
  )
}
