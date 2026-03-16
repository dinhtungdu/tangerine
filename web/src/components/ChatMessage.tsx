import type { ChatMessage as ChatMessageType } from "../hooks/useSession"
import { ToolCallDisplay } from "./ToolCallDisplay"

interface ChatMessageProps {
  message: ChatMessageType
}

function isToolCall(content: string): boolean {
  if (!content.startsWith("{")) return false
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>
    return "tool" in parsed || "name" in parsed || "command" in parsed
  } catch {
    return false
  }
}

function renderMarkdown(text: string): string {
  return text
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="my-2 rounded-md bg-[#f5f5f5] p-3 font-mono text-[11px] leading-[1.6] overflow-x-auto border border-[#e5e5e5]"><code>$2</code></pre>')
    .replace(/`([^`]+)`/g, '<code class="rounded bg-[#f5f5f5] px-1 py-0.5 font-mono text-[12px] border border-[#e5e5e5]">$1</code>')
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/\n/g, "<br />")
}

export function ChatMessage({ message }: ChatMessageProps) {
  const isUser = message.role === "user"
  const isSystem = message.role === "system"
  const isTool = !isUser && !isSystem && isToolCall(message.content)

  if (isTool) {
    return (
      <div className="animate-fade-in">
        <ToolCallDisplay content={message.content} />
      </div>
    )
  }

  if (isUser) {
    return (
      <div className="animate-fade-in flex justify-end">
        <div className="max-w-[280px] rounded-xl bg-[#171717] px-3.5 py-2.5">
          <p className="whitespace-pre-wrap text-[13px] leading-[1.5] text-[#fafafa]">{message.content}</p>
        </div>
      </div>
    )
  }

  if (isSystem) {
    return (
      <div className="animate-fade-in flex items-center justify-center gap-2">
        <svg className="h-3 w-3 text-[#737373]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 0 1-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 0 1 4.5 0" />
        </svg>
        <span className="text-[11px] text-[#737373]">{message.content}</span>
      </div>
    )
  }

  // Agent message
  return (
    <div className="animate-fade-in flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <div className="flex h-5 w-5 items-center justify-center rounded-[10px] bg-[#171717]">
          <svg className="h-2.5 w-2.5 text-[#fafafa]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 0 1-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 0 1 4.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0 1 12 15a9.065 9.065 0 0 0-6.23.693L5 14.5m14.8.8 1.402 1.402c1.232 1.232.65 3.318-1.067 3.611l-.772.13a18.142 18.142 0 0 1-6.126 0l-.772-.13c-1.717-.293-2.3-2.379-1.067-3.61L13 15" />
          </svg>
        </div>
        <span className="text-[12px] font-semibold text-[#0a0a0a]">Agent</span>
      </div>
      <div
        className="text-[13px] leading-[1.6] text-[#0a0a0a]"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
      />
    </div>
  )
}
