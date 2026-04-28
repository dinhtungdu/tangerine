import { useEffect, useRef, useState, useCallback } from "react"
import { ChevronRight, Trash2, Pencil, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { TERMINAL_STATUSES } from "@tangerine/shared"
import type { AgentConfigOption, AgentSlashCommand, PromptImage, PromptQueueEntry, PredefinedPrompt, TaskStatus, ProviderType, ActivityEntry, PermissionRequest } from "@tangerine/shared"
import type { ChatMessage as ChatMessageType } from "../hooks/useSession"
import { AssistantMessageGroups } from "./AssistantMessageGroups"
import { ChatInput } from "./ChatInput"
import { PermissionRequestDialog } from "./PermissionRequestDialog"
import { useProjectNav } from "../hooks/useProjectNav"
import { getStatusConfig } from "../lib/status"

interface ChatPanelProps {
  messages: ChatMessageType[]
  activities?: ActivityEntry[]
  tasks?: ReadonlyArray<{ id: string }>
  agentStatus: "idle" | "working"
  queueLength: number
  queuedPrompts?: PromptQueueEntry[]
  model?: string | null
  provider?: ProviderType
  reasoningEffort?: string | null
  taskStatus?: TaskStatus | null
  taskError?: string | null
  taskId?: string
  taskTitle?: string
  onSend: (text: string, images?: PromptImage[]) => void
  onAbort: () => void
  onQueuedPromptUpdate?: (promptId: string, text: string) => void | Promise<void>
  onQueuedPromptRemove?: (promptId: string) => void | Promise<void>
  onQueuedPromptClearAll?: () => void | Promise<void>
  onQueuedPromptSendNow?: (promptId: string) => void | Promise<void>
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
  permissionRequest?: PermissionRequest | null
  onPermissionRespond?: (optionId: string) => void | Promise<void>
}

const EMPTY_ACTIVITIES: ActivityEntry[] = []
const EMPTY_QUEUE: PromptQueueEntry[] = []

function QueuedPromptList({
  queuedPrompts,
  onUpdate,
  onRemove,
  onClearAll,
  onSendNow,
}: {
  queuedPrompts: PromptQueueEntry[]
  onUpdate?: (promptId: string, text: string) => void | Promise<void>
  onRemove?: (promptId: string) => void | Promise<void>
  onClearAll?: () => void | Promise<void>
  onSendNow?: (promptId: string) => void | Promise<void>
}) {
  const [isOpen, setIsOpen] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)

  const handleStartEdit = useCallback((entry: PromptQueueEntry) => {
    setEditingId(entry.id)
    setEditDraft(entry.displayText ?? entry.text)
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [])

  const handleSaveEdit = useCallback(() => {
    if (editingId && editDraft.trim()) {
      void onUpdate?.(editingId, editDraft.trim())
    }
    setEditingId(null)
    setEditDraft("")
  }, [editingId, editDraft, onUpdate])

  const handleCancelEdit = useCallback(() => {
    setEditingId(null)
    setEditDraft("")
  }, [])

  const handleEditKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSaveEdit()
    } else if (e.key === "Escape") {
      handleCancelEdit()
    }
  }, [handleSaveEdit, handleCancelEdit])

  if (queuedPrompts.length === 0) return null

  const count = queuedPrompts.length
  const label = count === 1 ? "Queued Message" : "Queued Messages"

  return (
    <div className="border-t border-border bg-muted/30">
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <div className="flex items-center gap-2 px-3 py-2 md:px-4">
          <CollapsibleTrigger className="flex items-center gap-1.5 text-sm font-medium text-foreground hover:text-foreground/80">
            <ChevronRight className={`h-4 w-4 transition-transform ${isOpen ? "rotate-90" : ""}`} />
            <span>{count} {label}</span>
          </CollapsibleTrigger>
          {onClearAll && (
            <button
              onClick={() => void onClearAll()}
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              Clear All
            </button>
          )}
        </div>
        <CollapsibleContent>
          <div className="space-y-0.5 px-3 pb-2 md:px-4">
            {queuedPrompts.map((entry) => {
              const displayText = entry.displayText ?? entry.text
              const isEditing = editingId === entry.id
              return (
                <div key={entry.id} className="flex items-center gap-2 py-1">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-blue-500" />
                  {isEditing ? (
                    <input
                      ref={inputRef}
                      type="text"
                      value={editDraft}
                      onChange={(e) => setEditDraft(e.target.value)}
                      onKeyDown={handleEditKeyDown}
                      onBlur={handleSaveEdit}
                      aria-label={`Edit queued message: ${displayText}`}
                      className="min-w-0 flex-1 rounded border border-input bg-background px-2 py-1 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
                    />
                  ) : (
                    <span className="min-w-0 flex-1 truncate text-sm">{displayText}</span>
                  )}
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => void onRemove?.(entry.id)}
                      aria-label="Remove"
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                    {isEditing ? (
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={handleCancelEdit}
                        aria-label="Cancel edit"
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => handleStartEdit(entry)}
                        aria-label="Edit"
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    {onSendNow && (
                      <Button
                        variant="outline"
                        size="xs"
                        onClick={() => void onSendNow(entry.id)}
                        className="ml-1"
                      >
                        Send Now
                      </Button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

export function ChatPanel({
  messages,
  activities = EMPTY_ACTIVITIES,
  tasks,
  agentStatus,
  queueLength,
  queuedPrompts = EMPTY_QUEUE,
  model,
  provider,
  reasoningEffort,
  taskStatus,
  taskError,
  taskId,
  taskTitle,
  onSend,
  onAbort,
  onQueuedPromptUpdate,
  onQueuedPromptRemove,
  onQueuedPromptClearAll,
  onQueuedPromptSendNow,
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
  permissionRequest,
  onPermissionRespond,
}: ChatPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const { navigate } = useProjectNav()
  const isTerminated = taskStatus ? TERMINAL_STATUSES.has(taskStatus) : false
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

  // Track whether user is near the bottom to show/hide scroll button
  const [isAtBottom, setIsAtBottom] = useState(true)

  // Scroll to bottom when switching tasks (clicking on a different chat)
  useEffect(() => {
    if (!taskId) return
    const el = contentRef.current
    if (el) el.scrollIntoView({ block: "end" })
    setIsAtBottom(true)
  }, [taskId])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const threshold = 80
    setIsAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < threshold)
  }, [])

  const scrollToBottom = useCallback(() => {
    const el = contentRef.current
    if (el) el.scrollIntoView({ block: "end", behavior: "smooth" })
  }, [])

  // Track virtual keyboard state via visualViewport resize events so the auto-scroll
  // effect always reads current state rather than a stale snapshot at effect-fire time.
  const keyboardOpenRef = useRef(false)
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const onResize = () => { keyboardOpenRef.current = window.innerHeight - vv.height > 100 }
    vv.addEventListener("resize", onResize)
    return () => vv.removeEventListener("resize", onResize)
  }, [])

  // Auto-scroll only when user is already at the bottom
  const prevCountRef = useRef({ messages: 0, activities: 0 })
  useEffect(() => {
    const messagesGrew = messages.length > prevCountRef.current.messages
    const activitiesGrew = activities.length > prevCountRef.current.activities
    if ((messagesGrew || activitiesGrew) && isAtBottom) {
      const tag = document.activeElement?.tagName
      const inputFocused = tag === "TEXTAREA" || tag === "INPUT"
      // Suppress scroll when virtual keyboard is open to prevent pushing the input below it.
      // Use a ref updated by visualViewport resize events (avoids stale snapshot at effect time).
      // Fall back to maxTouchPoints when visualViewport is unavailable (rare legacy browsers).
      const keyboardOpen = window.visualViewport
        ? keyboardOpenRef.current
        : (navigator.maxTouchPoints > 0 && inputFocused)
      const lastMessageIsUser = messagesGrew && messages[messages.length - 1]?.role === "user"
      if (!(inputFocused && keyboardOpen) || lastMessageIsUser) {
        const el = contentRef.current
        if (el) el.scrollIntoView({ block: "end" })
      }
    }
    prevCountRef.current = { messages: messages.length, activities: activities.length }
  }, [messages.length, activities.length, isAtBottom])

  return (
    <div className="flex h-full flex-col bg-background text-sm">
      {/* Messages */}
      <div className="relative flex-1 overflow-hidden">
        <div
          ref={scrollRef}
          className="h-full overflow-y-auto"
          onScroll={handleScroll}
        >
          {messages.length === 0 ? (
            <div className="flex h-full items-center justify-center py-20 text-muted-foreground">
              No messages yet. Send a prompt to start.
            </div>
          ) : (
            <div ref={contentRef} className="px-4 pb-12 pt-4">
              <AssistantMessageGroups
                messages={messages}
                activities={activities}
                tasks={tasks}
                onReply={handleReply}
                isLastGroupStreaming={agentStatus === "working"}
              />
            </div>
          )}
        </div>
        {!isAtBottom && (
          <div className="absolute bottom-12 left-1/2 -translate-x-1/2">
            <Button
              size="icon-sm"
              onClick={scrollToBottom}
              className="rounded-full shadow-lg bg-foreground text-background hover:bg-foreground/90"
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
          <QueuedPromptList
            queuedPrompts={queuedPrompts}
            onUpdate={onQueuedPromptUpdate}
            onRemove={onQueuedPromptRemove}
            onClearAll={onQueuedPromptClearAll}
            onSendNow={onQueuedPromptSendNow}
          />
          {permissionRequest && onPermissionRespond && (
            <div className="px-4">
              <PermissionRequestDialog
                request={permissionRequest}
                onRespond={onPermissionRespond}
              />
            </div>
          )}
          <ChatInput
          key={taskId}
          onSend={onSend}
          disabled={false}
          queueLength={queuedPrompts.length || queueLength}
          taskId={taskId}
          isWorking={agentStatus === "working"}
          onAbort={onAbort}
          model={model}
          provider={provider}
          reasoningEffort={reasoningEffort}
          onModelChange={onModelChange}
          onReasoningEffortChange={onReasoningEffortChange}
          onModeChange={onModeChange}
          configOptions={configOptions}
          slashCommands={slashCommands}
          predefinedPrompts={predefinedPrompts}
          quotedMessage={effectivePendingQuote}
          onQuoteDismiss={() => setPendingQuote(null)}
          selectedText={selectedText}
          onQuoteSelection={handleQuoteSelection}
          autoFocusKey={autoFocusKey}
          contextTokens={contextTokens}
          contextWindowMax={contextWindowMax}
        />
        </>
      )}
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
