import { useState, useCallback } from "react"
import type { Checkpoint } from "@tangerine/shared"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { createBranch } from "../lib/api"
import { formatTimestamp } from "../lib/format"

interface BranchModalProps {
  open: boolean
  onClose: () => void
  taskId: string
  checkpoint: Checkpoint
  onSuccess: (newTaskId: string) => void
}

export function BranchModal({ open, onClose, taskId, checkpoint, onSuccess }: BranchModalProps) {
  const [title, setTitle] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleCreate = useCallback(async () => {
    const trimmed = title.trim()
    if (!trimmed) return
    setLoading(true)
    setError(null)
    try {
      const result = await createBranch(taskId, {
        checkpointId: checkpoint.id,
        title: trimmed,
      })
      onSuccess(result.id)
      setTitle("")
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create branch")
    } finally {
      setLoading(false)
    }
  }, [taskId, checkpoint.id, title, onSuccess, onClose])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      void handleCreate()
    }
    if (e.key === "Escape") onClose()
  }, [handleCreate, onClose])

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Branch from checkpoint</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/50 px-3 py-2.5">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-amber-500/15">
              <svg className="h-3.5 w-3.5 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 3v12m0 0a3 3 0 1 0 3 3m-3-3a3 3 0 0 1 3 3m0 0h6a3 3 0 0 0 3-3V9m0 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
              </svg>
            </div>
            <div className="min-w-0">
              <div className="text-xs font-medium">Turn {checkpoint.turnIndex + 1}</div>
              <div className="text-2xs text-muted-foreground">{formatTimestamp(checkpoint.createdAt)}</div>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-foreground" htmlFor="branch-title">
              Branch title
            </label>
            <input
              id="branch-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Try different approach..."
              autoFocus
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
            />
          </div>

          {error && (
            <p className="text-xs text-destructive">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleCreate}
            disabled={!title.trim() || loading}
          >
            {loading ? "Creating…" : "Create branch"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
