import { useEffect, useRef } from "react"
import type { ChatMessage as ChatMessageType } from "../hooks/useSession"
import { ChatMessage } from "./ChatMessage"
import { ChatInput } from "./ChatInput"

interface ChatPanelProps {
  messages: ChatMessageType[]
  agentStatus: "idle" | "working"
  queueLength: number
  taskTitle?: string
  branch?: string
  prUrl?: string
  onSend: (text: string) => void
  onAbort: () => void
  onToggleActivity?: () => void
  showActivityToggle?: boolean
}

export function ChatPanel({
  messages,
  agentStatus,
  queueLength,
  taskTitle,
  branch,
  prUrl,
  onSend,
  onAbort,
  onToggleActivity,
  showActivityToggle,
}: ChatPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages.length])

  return (
    <div className="flex h-full flex-col bg-[#fafafa]">
      {/* Chat header */}
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-[#e5e5e5] px-5">
        <div className="flex flex-col gap-0.5">
          <span className="text-[15px] font-bold text-[#0a0a0a]">{taskTitle ?? "Agent"}</span>
          {branch && (
            <div className="flex items-center gap-2 text-[11px] text-[#737373]">
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0-12.814a2.25 2.25 0 1 0 0-2.186m0 2.186a2.25 2.25 0 1 0 0 2.186" />
              </svg>
              <span className="font-mono">{branch}</span>
              {prUrl && (
                <>
                  <span>·</span>
                  <a
                    href={prUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 rounded bg-[#22c55e18] px-1.5 py-0.5 text-[10px] font-medium text-green-700"
                  >
                    PR
                  </a>
                </>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-1">
          {showActivityToggle && (
            <button
              onClick={onToggleActivity}
              className="flex items-center gap-1.5 rounded-md bg-[#f5f5f5] px-2.5 py-1.5 text-[12px] font-medium text-[#0a0a0a]"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25H12" />
              </svg>
              Activity
            </button>
          )}
          {agentStatus === "working" && (
            <button
              onClick={onAbort}
              className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-[#f5f5f5]"
              aria-label="Stop agent"
            >
              <svg className="h-4 w-4 text-[#737373]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 7.5A2.25 2.25 0 0 1 7.5 5.25h9a2.25 2.25 0 0 1 2.25 2.25v9a2.25 2.25 0 0 1-2.25 2.25h-9a2.25 2.25 0 0 1-2.25-2.25v-9Z" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="flex flex-col gap-3 p-4">
          {messages.length === 0 ? (
            <div className="flex h-full items-center justify-center py-20 text-[13px] text-[#737373]">
              No messages yet. Send a prompt to start.
            </div>
          ) : (
            messages.map((msg) => <ChatMessage key={msg.id} message={msg} />)
          )}

          {/* Thinking indicator */}
          {agentStatus === "working" && messages.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <div className="flex h-5 w-5 items-center justify-center rounded-[10px] bg-[#171717]">
                  <svg className="h-2.5 w-2.5 text-[#fafafa]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 0 1-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 0 1 4.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0 1 12 15a9.065 9.065 0 0 0-6.23.693L5 14.5m14.8.8 1.402 1.402c1.232 1.232.65 3.318-1.067 3.611l-.772.13a18.142 18.142 0 0 1-6.126 0l-.772-.13c-1.717-.293-2.3-2.379-1.067-3.61L13 15" />
                  </svg>
                </div>
                <span className="text-[12px] font-semibold text-[#0a0a0a]">Agent</span>
              </div>
              <div className="flex items-center gap-1 rounded-lg bg-[#f5f5f5] px-3 py-2 w-fit">
                <div className="h-1.5 w-1.5 rounded-full bg-[#737373] animate-thinking-dot" />
                <div className="h-1.5 w-1.5 rounded-full bg-[#737373] animate-thinking-dot" />
                <div className="h-1.5 w-1.5 rounded-full bg-[#737373] animate-thinking-dot" />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Input */}
      <ChatInput
        onSend={onSend}
        disabled={agentStatus === "working"}
        queueLength={queueLength}
        isWorking={agentStatus === "working"}
        onAbort={onAbort}
      />
    </div>
  )
}
