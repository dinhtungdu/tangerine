import { useEffect, useRef, useState, useMemo } from "react"
import type { PromptImage, PredefinedPrompt, TaskStatus } from "@tangerine/shared"
import type { ChatMessage as ChatMessageType } from "../hooks/useSession"
import { ChatMessage } from "./ChatMessage"
import { ChatInput } from "./ChatInput"
import { useProjectNav } from "../hooks/useProjectNav"
import { getStatusConfig } from "../lib/status"

const TERMINAL_STATUSES: TaskStatus[] = ["done", "failed", "cancelled"]

interface ChatPanelProps {
  messages: ChatMessageType[]
  agentStatus: "idle" | "working"
  queueLength: number
  model?: string | null
  providerModels?: string[]
  reasoningEffort?: string | null
  taskStatus?: TaskStatus | null
  taskId?: string
  taskTitle?: string
  onSend: (text: string, images?: PromptImage[]) => void
  onAbort: () => void
  onModelChange?: (model: string) => void
  onReasoningEffortChange?: (effort: string) => void
  predefinedPrompts?: PredefinedPrompt[]
}

export function ChatPanel({
  messages,
  agentStatus,
  queueLength,
  model,
  providerModels,
  reasoningEffort,
  taskStatus,
  taskId,
  taskTitle,
  onSend,
  onAbort,
  onModelChange,
  onReasoningEffortChange,
  predefinedPrompts,
}: ChatPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const { navigate } = useProjectNav()
  const isTerminal = taskStatus ? TERMINAL_STATUSES.includes(taskStatus) : false
  const [showThinking, setShowThinking] = useState(false)

  const thinkingCount = useMemo(
    () => messages.filter((m) => m.role === "thinking" || m.role === "narration").length,
    [messages],
  )

  const visibleMessages = useMemo(
    () => (showThinking ? messages : messages.filter((m) => m.role !== "thinking" && m.role !== "narration")),
    [messages, showThinking],
  )

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [visibleMessages.length])

  return (
    <div className="flex h-full flex-col bg-surface">
      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="flex flex-col gap-3 p-4">
          {/* Thinking toggle */}
          {thinkingCount > 0 && (
            <div className="flex justify-end">
              <button
                onClick={() => setShowThinking((v) => !v)}
                className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-fg-muted transition hover:bg-surface-secondary"
              >
                <svg className="h-3 w-3 text-amber-500/70" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 18v-5.25m0 0a6.01 6.01 0 0 0 1.5-.189m-1.5.189a6.01 6.01 0 0 1-1.5-.189m3.75 7.478a12.06 12.06 0 0 1-4.5 0m3.75 2.383a14.406 14.406 0 0 1-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 1 0-7.517 0c.85.493 1.509 1.333 1.509 2.316V18" />
                </svg>
                {showThinking ? "Hide" : "Show"} reasoning ({thinkingCount})
              </button>
            </div>
          )}
          {visibleMessages.length === 0 && thinkingCount === 0 ? (
            <div className="flex h-full items-center justify-center py-20 text-[13px] text-fg-muted">
              No messages yet. Send a prompt to start.
            </div>
          ) : (
            visibleMessages.map((msg) => <ChatMessage key={msg.id} message={msg} />)
          )}

          {/* Thinking indicator */}
          {agentStatus === "working" && messages.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <div className="flex h-5 w-5 items-center justify-center rounded-[10px] bg-surface-dark">
                  <svg className="h-2.5 w-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 0 1-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 0 1 4.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0 1 12 15a9.065 9.065 0 0 0-6.23.693L5 14.5m14.8.8 1.402 1.402c1.232 1.232.65 3.318-1.067 3.611l-.772.13a18.142 18.142 0 0 1-6.126 0l-.772-.13c-1.717-.293-2.3-2.379-1.067-3.61L13 15" />
                  </svg>
                </div>
                <span className="text-[12px] font-semibold text-fg">Agent</span>
              </div>
              <div className="flex w-fit items-center gap-1 rounded-lg bg-surface-secondary px-3 py-2">
                <div className="h-1.5 w-1.5 rounded-full bg-fg-muted animate-thinking-dot" />
                <div className="h-1.5 w-1.5 rounded-full bg-fg-muted animate-thinking-dot" />
                <div className="h-1.5 w-1.5 rounded-full bg-fg-muted animate-thinking-dot" />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Input or terminal-state banner */}
      {isTerminal ? (
        <TerminalBanner
          taskStatus={taskStatus!}
          taskId={taskId}
          taskTitle={taskTitle}
          onContinue={(refTaskId, refTitle) => {
            const params = new URLSearchParams()
            if (refTaskId) params.set("ref", refTaskId)
            if (refTitle) params.set("refTitle", refTitle)
            navigate(`/new?${params}`)
          }}
        />
      ) : (
        <ChatInput
          onSend={onSend}
          disabled={false}
          queueLength={queueLength}
          taskId={taskId}
          isWorking={agentStatus === "working"}
          onAbort={onAbort}
          model={model}
          providerModels={providerModels}
          reasoningEffort={reasoningEffort}
          onModelChange={onModelChange}
          onReasoningEffortChange={onReasoningEffortChange}
          predefinedPrompts={predefinedPrompts}
        />
      )}
    </div>
  )
}

/* -- Banner shown when task is in a terminal state -- */

function TerminalBanner({
  taskStatus,
  taskId,
  taskTitle,
  onContinue,
}: {
  taskStatus: TaskStatus
  taskId?: string
  taskTitle?: string
  onContinue: (taskId?: string, title?: string) => void
}) {
  const { color, label } = getStatusConfig(taskStatus)

  return (
    <div className="border-t border-edge bg-surface px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[13px] text-fg-muted">
          <span
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium"
            style={{ backgroundColor: `color-mix(in srgb, ${color} 10%, transparent)`, color }}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
            {label}
          </span>
          <span>This task has ended.</span>
        </div>
        <button
          onClick={() => onContinue(taskId, taskTitle)}
          className="flex shrink-0 items-center gap-1.5 rounded-md bg-surface-dark px-3 py-1.5 text-[12px] font-medium text-white transition hover:opacity-80"
        >
          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          Continue in new task
        </button>
      </div>
    </div>
  )
}
