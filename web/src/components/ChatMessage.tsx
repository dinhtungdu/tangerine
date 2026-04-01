import { memo, useState } from "react"
import type { Components } from "react-markdown"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type { ChatMessage as ChatMessageType } from "../hooks/useSession"
import { formatTimestamp } from "../lib/format"
import { ToolCallDisplay } from "./ToolCallDisplay"
import { ImageLightbox } from "./ImageLightbox"

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

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function linkifyUrls(text: string): string {
  return escapeHtml(text).replace(
    /(https?:\/\/[^\s<]+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>',
  )
}

const markdownComponents: Components = {
  h1: ({ children }) => <h1 className="mt-4 mb-1 text-base font-bold">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-3 mb-1 text-sub font-bold">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-3 mb-1 text-sm font-semibold">{children}</h3>,
  h4: ({ children }) => <h4 className="mt-3 mb-1 text-md font-semibold">{children}</h4>,
  p: ({ children }) => <p className="my-1">{children}</p>,
  pre: ({ children }) => (
    <pre className="my-2 rounded-md bg-surface-secondary p-3 font-mono text-xxs leading-[1.6] overflow-x-auto border border-edge">
      {children}
    </pre>
  ),
  code: ({ children, className }) => {
    // Inline code (no className means not inside a code block)
    if (!className) {
      return <code className="rounded bg-surface-secondary px-1 py-0.5 font-mono text-xs border border-edge">{children}</code>
    }
    return <code className={className}>{children}</code>
  },
  ul: ({ children }) => <ul className="my-1 ml-4 list-disc space-y-0.5">{children}</ul>,
  ol: ({ children }) => <ol className="my-1 ml-4 list-decimal space-y-0.5">{children}</ol>,
  blockquote: ({ children }) => (
    <blockquote className="my-1 border-l-2 border-edge pl-3 text-fg-muted">{children}</blockquote>
  ),
  hr: () => <hr className="my-2 border-edge" />,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="underline text-link hover:text-link-hover break-all">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto rounded-md border border-edge">
      <table className="w-full border-collapse text-fg">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="px-3 py-1.5 text-left text-xxs font-semibold text-fg-muted">{children}</th>
  ),
  td: ({ children }) => <td className="px-3 py-1.5 text-xs">{children}</td>,
  tr: ({ children }) => <tr className="border-t border-edge">{children}</tr>,
}

const remarkPlugins = [remarkGfm]

export const ChatMessage = memo(function ChatMessage({ message }: ChatMessageProps) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const isUser = message.role === "user"
  const isSystem = message.role === "system"
  const isThinking = message.role === "thinking"
  const isNarration = message.role === "narration"
  const isTool = !isUser && !isSystem && !isThinking && !isNarration && isToolCall(message.content)

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
        <div className="max-w-[280px] md:max-w-[480px] rounded-xl bg-surface-dark px-3.5 py-2.5">
          {message.images && message.images.length > 0 && (
            <>
              <div className="mb-2 flex flex-wrap gap-1">
                {message.images.map((img, i) => (
                  <button key={i} onClick={() => setLightboxIndex(i)} className="cursor-zoom-in">
                    <img
                      src={img.src}
                      alt="Attached image"
                      className="h-16 w-16 rounded-md object-cover"
                    />
                  </button>
                ))}
              </div>
              {lightboxIndex !== null && (
                <ImageLightbox
                  images={message.images}
                  initialIndex={lightboxIndex}
                  onClose={() => setLightboxIndex(null)}
                />
              )}
            </>
          )}
          {message.content && (
            <p
              className="whitespace-pre-wrap text-md leading-[1.5] text-white [&_a]:underline [&_a]:text-link hover:[&_a]:text-link-hover [&_a]:break-all"
              dangerouslySetInnerHTML={{ __html: linkifyUrls(message.content) }}
            />
          )}
          <span className="mt-1 block text-right text-2xs text-fg-muted/50">
            {formatTimestamp(message.timestamp)}
          </span>
        </div>
      </div>
    )
  }

  if (isSystem) {
    return (
      <div className="animate-fade-in flex items-center justify-center gap-2">
        <svg className="h-3 w-3 text-fg-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 0 1-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 0 1 4.5 0" />
        </svg>
        <span className="text-xxs text-fg-muted">{message.content}</span>
      </div>
    )
  }

  // Thinking message
  if (isThinking) {
    return (
      <div className="animate-fade-in flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <div className="flex h-5 w-5 items-center justify-center rounded-[10px] bg-amber-500/15">
            <svg className="h-2.5 w-2.5 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 18v-5.25m0 0a6.01 6.01 0 0 0 1.5-.189m-1.5.189a6.01 6.01 0 0 1-1.5-.189m3.75 7.478a12.06 12.06 0 0 1-4.5 0m3.75 2.383a14.406 14.406 0 0 1-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 1 0-7.517 0c.85.493 1.509 1.333 1.509 2.316V18" />
            </svg>
          </div>
          <span className="text-xs font-medium text-amber-500/70">Thinking</span>
          <span className="text-2xs text-fg-muted/50">{formatTimestamp(message.timestamp)}</span>
        </div>
        <div className="rounded-lg border border-amber-500/10 bg-amber-500/5 px-3 py-2 text-xs italic leading-[1.6] text-fg-muted break-words">
          {message.content}
        </div>
      </div>
    )
  }

  // Narration — per-turn agent text (collapsed alongside thinking)
  if (isNarration) {
    return (
      <div className="animate-fade-in flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <div className="flex h-5 w-5 items-center justify-center rounded-[10px] bg-blue-500/15">
            <svg className="h-2.5 w-2.5 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 0 1 .865-.501 48.172 48.172 0 0 0 3.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z" />
            </svg>
          </div>
          <span className="text-xs font-medium text-blue-500/70">Narration</span>
          <span className="text-2xs text-fg-muted/50">{formatTimestamp(message.timestamp)}</span>
        </div>
        <div className="rounded-lg border border-blue-500/10 bg-blue-500/5 px-3 py-2 text-xs leading-[1.6] text-fg-muted break-words">
          {message.content}
        </div>
        {message.images && message.images.length > 0 && (
          <>
            <div className="flex flex-col gap-2">
              {message.images.map((img, i) => (
                <button key={i} onClick={() => setLightboxIndex(i)} className="cursor-zoom-in">
                  <img src={img.src} alt="Agent image" className="w-full rounded-md" />
                </button>
              ))}
            </div>
            {lightboxIndex !== null && (
              <ImageLightbox images={message.images} initialIndex={lightboxIndex} onClose={() => setLightboxIndex(null)} />
            )}
          </>
        )}
      </div>
    )
  }

  // Agent message
  return (
    <div className="animate-fade-in flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <div className="flex h-5 w-5 items-center justify-center rounded-[10px] bg-surface-dark">
          <svg className="h-2.5 w-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 0 1-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 0 1 4.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0 1 12 15a9.065 9.065 0 0 0-6.23.693L5 14.5m14.8.8 1.402 1.402c1.232 1.232.65 3.318-1.067 3.611l-.772.13a18.142 18.142 0 0 1-6.126 0l-.772-.13c-1.717-.293-2.3-2.379-1.067-3.61L13 15" />
          </svg>
        </div>
        <span className="text-xs font-semibold text-fg">Agent</span>
        <span className="text-2xs text-fg-muted/50">{formatTimestamp(message.timestamp)}</span>
      </div>
      <div className="text-md leading-[1.6] text-fg">
        <ReactMarkdown remarkPlugins={remarkPlugins} components={markdownComponents}>
          {message.content}
        </ReactMarkdown>
      </div>
      {message.images && message.images.length > 0 && (
        <>
          <div className="flex flex-col gap-2">
            {message.images.map((img, i) => (
              <button key={i} onClick={() => setLightboxIndex(i)} className="cursor-zoom-in">
                <img src={img.src} alt="Agent image" className="w-full rounded-md" />
              </button>
            ))}
          </div>
          {lightboxIndex !== null && (
            <ImageLightbox images={message.images} initialIndex={lightboxIndex} onClose={() => setLightboxIndex(null)} />
          )}
        </>
      )}
    </div>
  )
})
