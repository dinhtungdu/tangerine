import { memo, useState, useMemo, useCallback, useRef } from "react"
import type { Components } from "react-markdown"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import remarkBreaks from "remark-breaks"
import { visit } from "unist-util-visit"
import type { Root, Text, Parent, Link } from "mdast"
import type { ChatMessage as ChatMessageType } from "../hooks/useSession"
import { formatTimestamp } from "../lib/format"
import { useNavigate } from "react-router-dom"
import { ToolCallDisplay } from "./ToolCallDisplay"
import { ImageLightbox } from "./ImageLightbox"
import { copyToClipboard } from "../lib/clipboard"

export interface MessageAction {
  key: string
  label: string
  icon: React.ReactNode
  onClick: () => void
}

interface ChatMessageProps {
  message: ChatMessageType
  tasks?: ReadonlyArray<{ id: string }>
  onReply?: (content: string) => void
}

function MessageActionsBar({ actions, align = "start" }: { actions: MessageAction[], align?: "start" | "end" }) {
  if (actions.length === 0) return null
  return (
    // stopPropagation prevents action button clicks from bubbling to the group toggle handler
    <div
      onClick={e => e.stopPropagation()}
      className={`absolute bottom-0 translate-y-full ${align === "end" ? "right-0" : "left-0"} flex gap-0.5 opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto [.actions-open_&]:opacity-100 [.actions-open_&]:pointer-events-auto`}
    >
      {actions.map((action) => (
        <button
          key={action.key}
          onClick={action.onClick}
          title={action.label}
          aria-label={action.label}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xxs text-fg-muted transition hover:bg-surface-secondary hover:text-fg"
        >
          {action.icon}
          <span>{action.label}</span>
        </button>
      ))}
    </div>
  )
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

// Negative lookbehind/lookahead for `/` prevents linkifying UUIDs inside URL paths
const UUID_RE = /(?<!\/)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b(?!\/)/gi

/** Remark plugin that replaces task UUID text nodes with MDAST link nodes.
 *  Because it operates on the AST, `text` nodes are already outside code
 *  blocks/spans — no manual splitting needed. */
function makeRemarkLinkifyTaskIds(tasks: ReadonlyArray<{ id: string }>) {
  const known = new Map(tasks.map((t) => [t.id.toLowerCase(), t.id]))

  function makeTaskLink(canonicalId: string): Link {
    return { type: "link", url: `/tasks/${canonicalId}`, children: [{ type: "text", value: canonicalId.slice(0, 8) }], title: null }
  }

  /** Scan `value` for task UUIDs, splitting into alternating plain/link segments.
   *  `wrapPlain` controls how non-UUID text is represented (text vs inlineCode). */
  function splitOnTaskIds<T>(value: string, wrapPlain: (s: string) => T): Array<T | Link> | null {
    const parts: Array<T | Link> = []
    let last = 0
    UUID_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = UUID_RE.exec(value)) !== null) {
      const canonicalId = known.get(m[0].toLowerCase())
      if (!canonicalId) continue
      if (m.index > last) parts.push(wrapPlain(value.slice(last, m.index)))
      parts.push(makeTaskLink(canonicalId))
      last = m.index + m[0].length
    }
    if (parts.length === 0) return null
    if (last < value.length) parts.push(wrapPlain(value.slice(last)))
    return parts
  }

  return () => (tree: Root) => {
    visit(tree, "text", (node: Text, index: number | undefined, parent: Parent | undefined) => {
      if (!parent || index === undefined || parent.type === "link") return
      const parts = splitOnTaskIds(node.value, (s): Text => ({ type: "text", value: s }))
      if (parts) parent.children.splice(index, 1, ...(parts as Parent["children"]))
    })
    visit(tree, "inlineCode", (node: { type: "inlineCode"; value: string }, index: number | undefined, parent: Parent | undefined) => {
      if (!parent || index === undefined || parent.type === "link") return
      const parts = splitOnTaskIds(node.value, (s) => ({ type: "inlineCode" as const, value: s }))
      if (parts) parent.children.splice(index, 1, ...(parts as Parent["children"]))
    })
  }
}

const BASE_REMARK_PLUGINS = [remarkGfm]
// User messages preserve single newlines (matching whitespace-pre-wrap semantics)
const BASE_USER_REMARK_PLUGINS = [remarkGfm, remarkBreaks]

export const ChatMessage = memo(function ChatMessage({ message, tasks, onReply }: ChatMessageProps) {
  const navigate = useNavigate()
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const handleLinkClick = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
      const anchor = (e.target as HTMLElement).closest("a")
      if (!anchor) return
      const href = anchor.getAttribute("href")
      if (href && href.startsWith("/")) {
        e.preventDefault()
        navigate(href)
      }
    },
    [navigate],
  )
  const remarkPlugins = useMemo(
    () => tasks && tasks.length > 0 ? [...BASE_REMARK_PLUGINS, makeRemarkLinkifyTaskIds(tasks)] : BASE_REMARK_PLUGINS,
    [tasks],
  )
  const userRemarkPlugins = useMemo(
    () => tasks && tasks.length > 0 ? [...BASE_USER_REMARK_PLUGINS, makeRemarkLinkifyTaskIds(tasks)] : BASE_USER_REMARK_PLUGINS,
    [tasks],
  )
  const isUser = message.role === "user"
  const isSystem = message.role === "system"
  const isThinking = message.role === "thinking"
  const isNarration = message.role === "narration"
  const isTool = !isUser && !isSystem && !isThinking && !isNarration && isToolCall(message.content)

  const messageRef = useRef<HTMLDivElement>(null)

  const handleGroupClick = useCallback(() => {
    messageRef.current?.classList.toggle("actions-open")
  }, [])

  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const handleCopy = useCallback(() => {
    void copyToClipboard(message.content).then(() => {
      setCopied(true)
      clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(false), 1500)
    })
  }, [message.content])

  const messageActions: MessageAction[] = message.content ? [
    {
      key: "copy",
      label: copied ? "Copied" : "Copy",
      icon: copied ? (
        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      ) : (
        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0 0 13.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 0 1-.75.75H9.75a.75.75 0 0 1-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 0 1-2.25 2.25H6.75A2.25 2.25 0 0 1 4.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 0 1 1.927-.184" />
        </svg>
      ),
      onClick: handleCopy,
    },
    ...(onReply ? [{
      key: "reply",
      label: "Reply",
      icon: (
        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="m15 15-6 6m0 0-6-6m6 6V9a6 6 0 0 1 12 0v3" />
        </svg>
      ),
      onClick: () => onReply(message.content),
    }] : []),
  ] : []

  if (isTool) {
    return (
      <div className="animate-fade-in">
        <ToolCallDisplay content={message.content} />
      </div>
    )
  }

  if (isUser) {
    return (
      <div ref={messageRef} onClick={handleGroupClick} className="animate-fade-in group relative flex flex-col items-end gap-0.5">
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
            <div
              className="text-md leading-[1.5] text-white [&_a]:underline [&_a]:text-link hover:[&_a]:text-link-hover [&_a]:break-all"
              onClick={handleLinkClick}
            >
              <ReactMarkdown remarkPlugins={userRemarkPlugins} components={markdownComponents}>
                {message.content}
              </ReactMarkdown>
            </div>
          )}
          <span className="mt-1 block text-right text-2xs text-fg-muted/50">
            {formatTimestamp(message.timestamp)}
          </span>
        </div>
        <MessageActionsBar actions={messageActions} align="end" />
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
        <div className="rounded-lg border border-blue-500/10 bg-blue-500/5 px-3 py-2 text-xs leading-[1.6] text-fg-muted break-words" onClick={handleLinkClick}>
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
  }

  // Agent message
  return (
    <div ref={messageRef} onClick={handleGroupClick} className="animate-fade-in group relative flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <div className="flex h-5 w-5 items-center justify-center rounded-[10px] bg-surface-dark">
          <svg className="h-2.5 w-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 0 1-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 0 1 4.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0 1 12 15a9.065 9.065 0 0 0-6.23.693L5 14.5m14.8.8 1.402 1.402c1.232 1.232.65 3.318-1.067 3.611l-.772.13a18.142 18.142 0 0 1-6.126 0l-.772-.13c-1.717-.293-2.3-2.379-1.067-3.61L13 15" />
          </svg>
        </div>
        <span className="text-xs font-semibold text-fg">Agent</span>
        <span className="text-2xs text-fg-muted/50">{formatTimestamp(message.timestamp)}</span>
      </div>
      <div className="text-md leading-[1.6] text-fg break-words" onClick={handleLinkClick}>
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
      <MessageActionsBar actions={messageActions} align="start" />
    </div>
  )
})
