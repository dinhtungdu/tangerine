import { Button } from "@/components/ui/button"
import type { PermissionRequest, PermissionRequestOption } from "@tangerine/shared"

interface PermissionRequestDialogProps {
  request: PermissionRequest
  onRespond: (optionId: string) => void
}

export function PermissionRequestDialog({ request, onRespond }: PermissionRequestDialogProps) {
  const allowOptions = request.options.filter((o: PermissionRequestOption) => o.kind === "allow_once" || o.kind === "allow_always")
  const rejectOptions = request.options.filter((o: PermissionRequestOption) => o.kind === "reject_once" || o.kind === "reject_always")

  return (
    <div className="border border-yellow-500/30 bg-yellow-500/5 rounded-lg p-4 mb-4">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-yellow-500 text-sm font-medium">Permission Required</span>
        {request.toolName && (
          <span className="text-xs text-muted-foreground">({request.toolName})</span>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {allowOptions.map((option: PermissionRequestOption) => (
          <Button
            key={option.optionId}
            size="sm"
            variant="default"
            onClick={() => onRespond(option.optionId)}
          >
            {option.name}
          </Button>
        ))}
        {rejectOptions.map((option: PermissionRequestOption) => (
          <Button
            key={option.optionId}
            size="sm"
            variant="outline"
            onClick={() => onRespond(option.optionId)}
          >
            {option.name}
          </Button>
        ))}
      </div>
    </div>
  )
}
