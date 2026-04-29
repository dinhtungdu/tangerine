import { memo, useState } from "react"
import { ChevronRight, Loader2, CheckCircle2, XCircle, ShieldQuestion } from "lucide-react"
import type { ToolCallEntry } from "@/types/thread"
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface ToolCallDisplayProps {
  entry: ToolCallEntry
  onPermissionRespond?: (requestId: string, optionId: string) => void
}

export const ToolCallDisplay = memo(function ToolCallDisplay({
  entry,
  onPermissionRespond,
}: ToolCallDisplayProps) {
  const [expanded, setExpanded] = useState(false)

  const StatusIcon = {
    pending_permission: ShieldQuestion,
    running: Loader2,
    done: CheckCircle2,
    error: XCircle,
  }[entry.status]

  const statusColor = {
    pending_permission: "text-yellow-500",
    running: "text-blue-500",
    done: "text-green-500",
    error: "text-red-500",
  }[entry.status]

  return (
    <div className="rounded-md border bg-muted/30 p-3">
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <CollapsibleTrigger className="flex w-full items-center gap-2 text-sm">
          <ChevronRight
            className={cn("size-4 transition-transform", expanded && "rotate-90")}
            data-icon
          />
          <StatusIcon
            className={cn("size-4", statusColor, entry.status === "running" && "animate-spin")}
            data-icon
          />
          <span className="font-mono text-xs">{entry.toolName}</span>
        </CollapsibleTrigger>

        <CollapsibleContent className="pt-3">
          <div className="flex flex-col gap-2 text-xs">
            <div>
              <div className="font-medium text-muted-foreground">Input</div>
              <pre className="mt-1 overflow-auto rounded bg-muted p-2">
                {JSON.stringify(entry.input, null, 2)}
              </pre>
            </div>

            {entry.result && (
              <div>
                <div className="font-medium text-muted-foreground">Result</div>
                <pre className="mt-1 overflow-auto rounded bg-muted p-2 max-h-48">
                  {entry.result}
                </pre>
              </div>
            )}

            {entry.permissionRequest && onPermissionRespond && (
              <div className="flex flex-col gap-2 pt-2 border-t">
                <div className="font-medium">Permission Required</div>
                <div className="flex flex-wrap gap-2">
                  {entry.permissionRequest.options.map((option) => (
                    <Button
                      key={option.id}
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        onPermissionRespond(entry.permissionRequest!.requestId, option.id)
                      }
                    >
                      {option.name}
                    </Button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
})
