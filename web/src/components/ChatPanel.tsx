import { useEffect, useRef, useState, useMemo, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { useVirtualizer } from "@tanstack/react-virtual"
import { TERMINAL_STATUSES } from "@tangerine/shared"
import type { PromptImage, PredefinedPrompt, TaskStatus, ProviderType } from "@tangerine/shared"
import type { ChatMessage as ChatMessageType } from "../hooks/useSession"
import { ChatMessage } from "./ChatMessage"
import { ChatInput } from "./ChatInput"
import { useProjectNav } from "../hooks/useProjectNav"
import { getStatusConfig } from "../lib/status"

interface ChatPanelProps {
  messages: ChatMessageType[]
  tasks?: ReadonlyArray<{ id: string }>
  agentStatus: "idle" | "working"
  queueLength: number
  model?: string | null
  provider?: ProviderType
  providerModels?: string[]
  reasoningEffort?: string | null
  taskStatus?: TaskStatus | null
  taskError?: string | null
  taskId?: string
  taskTitle?: string
  onSend: (text: string, images?: PromptImage[]) => void
  onAbort: () => void
  onModelChange?: (model: string) => void
  onReasoningEffortChange?: (effort: string) => void
  predefinedPrompts?: PredefinedPrompt[]
  onResolve?: () => Promise<void>
  canContinue?: boolean
  taskBranch?: string
  taskProjectId?: string
  autoFocusKey?: string
  contextTokens?: number
  inputTokens?: number
  outputTokens?: number
  contextWindowMax?: number
}

export function ChatPanel({
  messages,
  tasks,
  agentStatus,
  queueLength,
  model,
  provider,
  providerModels,
  reasoningEffort,
  taskStatus,
  taskError,
  taskId,
  taskTitle,
  onSend,
  onAbort,
  onModelChange,
  onReasoningEffortChange,
  predefinedPrompts,
  onResolve,
  canContinue,
  taskBranch,
  taskProjectId,
  autoFocusKey,
  contextTokens,
  inputTokens,
  outputTokens,
  contextWindowMax,
}: ChatPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const { navigate } = useProjectNav()
  const isTerminated = taskStatus ? TERMINAL_STATUSES.has(taskStatus) : false
  const [showThinking, setShowThinking] = useState(() => {
    try { return localStorage.getItem("showThinking") === "true" } catch { return false /* storage unavailable */ }
  })
  useEffect(() => {
    try { localStorage.setItem("showThinking", String(showThinking)) } catch { /* storage unavailable */ }
  }, [showThinking])
  // pendingQuote is persisted per task so it survives page reloads
  const quoteKey = taskId ? `tangerine:chat-quote:${taskId}` : null
  const [pendingQuote, setPendingQuote] = useState<string | null>(null)

  // Load/clear quote whenever the active task changes
  useEffect(() => {
    try { setPendingQuote(quoteKey ? (localStorage.getItem(quoteKey) ?? null) : null) } catch { /* ignore */ }
  }, [quoteKey])

  // Persist quote changes to storage
  useEffect(() => {
    if (!quoteKey) return
    try {
      if (pendingQuote) localStorage.setItem(quoteKey, pendingQuote)
      else localStorage.removeItem(quoteKey)
    } catch { /* ignore */ }
  }, [quoteKey, pendingQuote])

  // Clean up orphaned drafts when a task terminates
  useEffect(() => {
    if (isTerminated && taskId) {
      try {
        localStorage.removeItem(`tangerine:chat-draft:${taskId}`)
        localStorage.removeItem(`tangerine:chat-quote:${taskId}`)
      } catch { /* ignore */ }
    }
  }, [isTerminated, taskId])

  const effectivePendingQuote = pendingQuote

  const handleReply = useCallback((content: string) => {
    setPendingQuote(content)
  }, [])

  // Track text selection inside the messages area for the Quote button
  const [selectedText, setSelectedText] = useState<string | null>(null)
  // Clear stale selection when switching tasks
  useEffect(() => { setSelectedText(null) }, [taskId])
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const handleSelection = () => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed) { setSelectedText(null); return }
      // Only track selections inside the messages scroll area
      const anchor = sel.anchorNode
      if (!anchor || !el.contains(anchor)) { setSelectedText(null); return }
      const text = sel.toString().trim()
      setSelectedText(text || null)
    }
    document.addEventListener("selectionchange", handleSelection)
    return () => document.removeEventListener("selectionchange", handleSelection)
  }, [])

  const handleQuoteSelection = useCallback(() => {
    if (!selectedText) return
    setPendingQuote(selectedText)
    window.getSelection()?.removeAllRanges()
    setSelectedText(null)
  }, [selectedText])

  const thinkingCount = useMemo(
    () => messages.filter((m) => m.role === "thinking" || m.role === "narration").length,
    [messages],
  )

  const visibleMessages = useMemo(
    () => (showThinking ? messages : messages.filter((m) => m.role !== "thinking" && m.role !== "narration")),
    [messages, showThinking],
  )

  // Extra "rows" after messages: thinking indicator + thinking toggle
  const hasThinkingIndicator = agentStatus === "working" && messages.length > 0
  const hasThinkingToggle = thinkingCount > 0
  const extraRows = (hasThinkingIndicator ? 1 : 0) + (hasThinkingToggle ? 1 : 0)
  const rowCount = visibleMessages.length + extraRows

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 80,
    overscan: 5,
    paddingStart: 16,
    paddingEnd: 16,
    getItemKey: (index) => {
      if (index < visibleMessages.length) return visibleMessages[index]!.id
      if (index === visibleMessages.length && hasThinkingIndicator) return "__thinking__"
      return "__toggle__"
    },
  })

  // Track whether user is near the bottom to show/hide scroll button
  const [isAtBottom, setIsAtBottom] = useState(true)

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const threshold = 80
    setIsAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < threshold)
  }, [])

  const scrollToBottom = useCallback(() => {
    virtualizer.scrollToIndex(rowCount - 1, { align: "end" })
  }, [virtualizer, rowCount])

  // Auto-scroll only when user is already at the bottom
  const prevCountRef = useRef(0)
  useEffect(() => {
    if (rowCount > prevCountRef.current && isAtBottom) {
      virtualizer.scrollToIndex(rowCount - 1, { align: "end" })
    }
    prevCountRef.current = rowCount
  }, [rowCount, isAtBottom, virtualizer])

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Messages */}
      <div className="relative flex-1 overflow-hidden">
      <div
        ref={scrollRef}
        className="h-full overflow-y-auto"
        onScroll={handleScroll}
      >
        {visibleMessages.length === 0 && thinkingCount === 0 ? (
          <div className="flex h-full items-center justify-center py-20 text-sm text-muted-foreground">
            No messages yet. Send a prompt to start.
          </div>
        ) : (
          <div
            style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const msgIndex = virtualRow.index
              const isThinkingIndicator = msgIndex === visibleMessages.length && hasThinkingIndicator
              const isThinkingToggle = msgIndex === visibleMessages.length + (hasThinkingIndicator ? 1 : 0) && hasThinkingToggle

              return (
                <div
                  key={virtualRow.key}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <div className="px-4 pb-6">
                    {isThinkingIndicator ? (
                      <ThinkingIndicator />
                    ) : isThinkingToggle ? (
                      <div className="flex justify-end">
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={() => setShowThinking((v) => !v)}
                          className="text-muted-foreground"
                        >
                          <svg className="h-3 w-3 text-amber-500/70" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 18v-5.25m0 0a6.01 6.01 0 0 0 1.5-.189m-1.5.189a6.01 6.01 0 0 1-1.5-.189m3.75 7.478a12.06 12.06 0 0 1-4.5 0m3.75 2.383a14.406 14.406 0 0 1-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 1 0-7.517 0c.85.493 1.509 1.333 1.509 2.316V18" />
                          </svg>
                          {showThinking ? "Hide" : "Show"} reasoning ({thinkingCount})
                        </Button>
                      </div>
                    ) : (
                      <ChatMessage
                        message={visibleMessages[msgIndex]!}
                        tasks={tasks}
                        onReply={handleReply}
                      />
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
      {!isAtBottom && (
        <div className="absolute bottom-12 left-1/2 -translate-x-1/2">
          <Button
            size="icon-sm"
            onClick={scrollToBottom}
            className="rounded-full shadow-lg"
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
        <>
          <ChatInput
          key={taskId}
          onSend={onSend}
          disabled={false}
          queueLength={queueLength}
          taskId={taskId}
          isWorking={agentStatus === "working"}
          onAbort={onAbort}
          model={model}
          provider={provider}
          providerModels={providerModels}
          reasoningEffort={reasoningEffort}
          onModelChange={onModelChange}
          onReasoningEffortChange={onReasoningEffortChange}
          predefinedPrompts={predefinedPrompts}
          quotedMessage={effectivePendingQuote}
          onQuoteDismiss={() => setPendingQuote(null)}
          selectedText={selectedText}
          onQuoteSelection={handleQuoteSelection}
          autoFocusKey={autoFocusKey}
          contextTokens={contextTokens}
          inputTokens={inputTokens}
          outputTokens={outputTokens}
          contextWindowMax={contextWindowMax}
        />
        </>
      )}
    </div>
  )
}

/* -- Thinking indicator (extracted to avoid inline definition) -- */

function ThinkingIndicator() {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <div className="flex h-5 w-5 items-center justify-center rounded-[10px] bg-primary">
          <svg className="h-2.5 w-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 0 1-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 0 1 4.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0 1 12 15a9.065 9.065 0 0 0-6.23.693L5 14.5m14.8.8 1.402 1.402c1.232 1.232.65 3.318-1.067 3.611l-.772.13a18.142 18.142 0 0 1-6.126 0l-.772-.13c-1.717-.293-2.3-2.379-1.067-3.61L13 15" />
          </svg>
        </div>
        <span className="text-xs font-semibold text-foreground">Agent</span>
      </div>
      <div className="flex w-fit items-center gap-1 rounded-lg bg-muted px-3 py-2">
        <div className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-thinking-dot" />
        <div className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-thinking-dot" />
        <div className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-thinking-dot" />
      </div>
    </div>
  )
}

/* -- Banner shown when task is done / failed / cancelled -- */

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
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
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
