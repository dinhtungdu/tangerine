// Chat panel v2 - uses chunk-based ThreadEntry model for proper thinking block handling

import { useRef, useState, useCallback, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { TERMINAL_STATUSES } from "@tangerine/shared"
import type { AgentConfigOption, AgentSlashCommand, PromptImage, PredefinedPrompt, TaskStatus } from "@tangerine/shared"
import { useThreadSession } from "@/hooks/useThreadSession"
import { ThreadView } from "@/components/chat/ThreadView"
import { ChatInput } from "./ChatInput"
import { useProjectNav } from "../hooks/useProjectNav"
import { getStatusConfig } from "../lib/status"
import type { ThreadEntry } from "@/types/thread"

interface ChatPanelV2Props {
  taskId: string
  taskStatus?: TaskStatus | null
  taskError?: string | null
  taskTitle?: string
  initialEntries?: ThreadEntry[]
  model?: string | null
  reasoningEffort?: string | null
  onModelChange?: (model: string) => void
  onReasoningEffortChange?: (effort: string) => void
  onModeChange?: (mode: string) => void
  configOptions?: AgentConfigOption[]
  slashCommands?: AgentSlashCommand[]
  predefinedPrompts?: PredefinedPrompt[]
  onResolve?: () => Promise<void>
  canContinue?: boolean
  taskBranch?: string
  taskProjectId?: string
  autoFocusKey?: string
  contextTokens?: number
  contextWindowMax?: number
  onTaskStart?: () => Promise<void>
}

export function ChatPanelV2({
  taskId,
  taskStatus,
  taskError,
  taskTitle,
  initialEntries,
  model,
  reasoningEffort,
  onModelChange,
  onReasoningEffortChange,
  onModeChange,
  configOptions,
  slashCommands,
  predefinedPrompts,
  onResolve,
  canContinue,
  taskBranch,
  taskProjectId,
  autoFocusKey,
  contextTokens,
  contextWindowMax,
  onTaskStart,
}: ChatPanelV2Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const { navigate } = useProjectNav()
  const isTerminated = taskStatus ? TERMINAL_STATUSES.has(taskStatus) : false

  const { entries, connected, sendPrompt, abort } = useThreadSession({
    taskId,
    initialEntries,
  })

  const [isAtBottom, setIsAtBottom] = useState(true)

  useEffect(() => {
    const scroller = scrollRef.current
    if (scroller) scroller.scrollTop = scroller.scrollHeight
    setIsAtBottom(true)
  }, [taskId])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const threshold = 80
    setIsAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < threshold)
  }, [])

  const scrollToBottom = useCallback(() => {
    const scroller = scrollRef.current
    if (scroller) scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" })
  }, [])

  // Auto-scroll when new entries arrive
  const prevCount = useRef(entries.length)
  useEffect(() => {
    if (entries.length > prevCount.current && isAtBottom) {
      const scroller = scrollRef.current
      if (scroller) scroller.scrollTop = scroller.scrollHeight
    }
    prevCount.current = entries.length
  }, [entries.length, isAtBottom])

  const handleSend = useCallback(
    async (text: string, images?: PromptImage[]) => {
      if (taskStatus === "created" && onTaskStart) {
        await onTaskStart()
      }
      sendPrompt(text, images)
    },
    [taskStatus, onTaskStart, sendPrompt]
  )

  const handlePermissionRespond = useCallback((_requestId: string, _optionId: string) => {
    // TODO: Wire to websocket permission response
  }, [])

  const isWorking = entries.some(
    (e) => e.kind === "assistant" && e.streaming
  )

  return (
    <div className="flex h-full flex-col bg-background text-sm">
      {/* Connection indicator */}
      {!connected && (
        <div className="flex items-center gap-2 border-b border-border bg-muted/50 px-4 py-2 text-xs text-muted-foreground">
          <span className="h-2 w-2 rounded-full bg-yellow-500" />
          Connecting...
        </div>
      )}

      {/* Messages */}
      <div className="relative flex-1 overflow-hidden">
        <div
          ref={scrollRef}
          className="h-full overflow-y-auto"
          onScroll={handleScroll}
        >
          <ThreadView
            entries={entries}
            onPermissionRespond={handlePermissionRespond}
          />
        </div>
        {!isAtBottom && (
          <div className="absolute bottom-12 left-1/2 -translate-x-1/2">
            <Button
              size="icon-sm"
              onClick={scrollToBottom}
              className="rounded-full bg-foreground text-background shadow-lg hover:bg-foreground/90"
              aria-label="Scroll to bottom"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
              </svg>
            </Button>
          </div>
        )}
      </div>

      {/* Input or terminal-state banner */}
      {isTerminated ? (
        <TerminatedBanner
          taskStatus={taskStatus!}
          taskError={taskError}
          taskId={taskId}
          taskTitle={taskTitle}
          onContinue={canContinue ? (refTaskId, refTitle) => {
            const params = new URLSearchParams()
            if (refTaskId) params.set("ref", refTaskId)
            if (refTitle) params.set("refTitle", refTitle)
            if (taskBranch) params.set("branch", taskBranch)
            if (taskProjectId) params.set("refProject", taskProjectId)
            navigate(`/?${params}#new-agent-textarea`)
          } : undefined}
          onResolve={onResolve}
        />
      ) : (
        <ChatInput
          key={taskId}
          onSend={handleSend}
          disabled={false}
          queueLength={0}
          taskId={taskId}
          isWorking={isWorking}
          onAbort={abort}
          model={model}
          reasoningEffort={reasoningEffort}
          onModelChange={onModelChange}
          onReasoningEffortChange={onReasoningEffortChange}
          onModeChange={onModeChange}
          configOptions={configOptions}
          slashCommands={slashCommands}
          predefinedPrompts={predefinedPrompts}
          autoFocusKey={autoFocusKey}
          contextTokens={contextTokens}
          contextWindowMax={contextWindowMax}
        />
      )}
    </div>
  )
}

function TerminatedBanner({
  taskStatus,
  taskError,
  taskId,
  taskTitle,
  onContinue,
  onResolve,
}: {
  taskStatus: TaskStatus
  taskError?: string | null
  taskId?: string
  taskTitle?: string
  onContinue?: (taskId?: string, title?: string) => void
  onResolve?: () => Promise<void>
}) {
  const { color, label } = getStatusConfig(taskStatus)
  const [resolving, setResolving] = useState(false)

  const handleResolve = useCallback(async () => {
    if (!onResolve || resolving) return
    setResolving(true)
    try {
      await onResolve()
    } finally {
      setResolving(false)
    }
  }, [onResolve, resolving])

  return (
    <div className="border-t border-border bg-background px-4 py-3">
      {taskStatus === "failed" && taskError && (
        <p className="mb-2 truncate text-xs text-status-error" title={taskError}>{taskError}</p>
      )}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-muted-foreground">
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xxs font-medium"
            style={{ backgroundColor: `color-mix(in srgb, ${color} 10%, transparent)`, color }}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
            {label}
          </span>
          <span>This task has ended.</span>
        </div>
        <div className="flex items-center gap-2">
          {onResolve && (taskStatus === "failed" || taskStatus === "cancelled") && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleResolve()}
              disabled={resolving}
            >
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
              </svg>
              {resolving ? "Marking..." : "Mark as done"}
            </Button>
          )}
          {onContinue && (
            <Button
              size="sm"
              onClick={() => onContinue(taskId, taskTitle)}
            >
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
              Continue in new task
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
