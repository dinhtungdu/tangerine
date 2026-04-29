import { memo } from "react"
import { Circle, CircleDot, CheckCircle2 } from "lucide-react"
import type { PlanEntry } from "@/types/thread"
import { cn } from "@/lib/utils"

interface PlanDisplayProps {
  entry: PlanEntry
}

export const PlanDisplay = memo(function PlanDisplay({ entry }: PlanDisplayProps) {
  return (
    <div className="rounded-md border bg-muted/30 p-3">
      <div className="text-sm font-medium mb-2">Plan</div>
      <ul className="flex flex-col gap-1">
        {entry.entries.map((item) => {
          const Icon = {
            pending: Circle,
            in_progress: CircleDot,
            done: CheckCircle2,
          }[item.status]

          const iconColor = {
            pending: "text-muted-foreground",
            in_progress: "text-blue-500",
            done: "text-green-500",
          }[item.status]

          return (
            <li key={item.id} className="flex items-center gap-2 text-sm">
              <Icon className={cn("size-4", iconColor)} data-icon />
              <span
                className={cn(
                  item.status === "done" && "line-through text-muted-foreground"
                )}
              >
                {item.title}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
})
