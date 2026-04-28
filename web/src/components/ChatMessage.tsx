import { memo, useState, useMemo, useCallback, useRef, useEffect, createContext, useContext } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import type { Components } from "react-markdown"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import remarkBreaks from "remark-breaks"
import { visit } from "unist-util-visit"
import type { Root, Text, Parent, Link } from "mdast"
import type { AgentContentBlock, AgentPlanEntry } from "@tangerine/shared"
import type { ChatMessage as ChatMessageType } from "../hooks/useSession"
import { formatTimestamp } from "../lib/format"
import { useNavigate } from "react-router-dom"
import { ToolCallDisplay } from "./ToolCallDisplay"
import { DiffViewer, getDiffStats } from "./DiffViewer"
import { AuthenticatedImage } from "./AuthenticatedImage"
import { ImageLightbox } from "./ImageLightbox"
import { copyToClipboard } from "../lib/clipboard"
import { FileDiff, FileText, Terminal } from "lucide-react"

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
  isThinkingActive?: boolean
  thinkingDuration?: number
}

function useElapsedTime(startTime: string, active: boolean): number {
  const [elapsed, setElapsed] = useState(() => {
    const start = new Date(startTime).getTime()
    return Math.floor((Date.now() - start) / 1000)
  })

  useEffect(() => {
    if (!active) return
    const start = new Date(startTime).getTime()
    const tick = () => setElapsed(Math.floor((Date.now() - start) / 1000))
    tick()
    const interval = setInterval(tick, 1000)
    return () => clearInterval(interval)
  }, [startTime, active])

  return elapsed
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`
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
        <Button
          key={action.key}
          variant="ghost"
          size="xs"
          onClick={action.onClick}
          title={action.label}
          aria-label={action.label}
          className="text-muted-foreground hover:text-foreground"
        >
          {action.icon}
          <span>{action.label}</span>
        </Button>
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


// Signals to the `code` renderer that it's inside a `pre` block, so it
// doesn't apply inline-code styles to unlanguaged fenced code blocks.
const InsidePreContext = createContext(false)

const markdownComponents: Components = {
  h1: ({ children }) => <h1 className="mt-4 mb-1 text-base font-bold">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-3 mb-1 text-sub font-bold">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-3 mb-1 font-semibold">{children}</h3>,
  h4: ({ children }) => <h4 className="mt-3 mb-1 font-semibold">{children}</h4>,
  p: ({ children }) => <p className="my-1">{children}</p>,
  pre: ({ children }) => (
    <InsidePreContext.Provider value={true}>
      <pre className="my-2 rounded-md bg-muted p-3 font-mono text-xxs leading-[1.6] overflow-x-auto border border-border">
        {children}
      </pre>
    </InsidePreContext.Provider>
  ),
  code: ({ children, className }) => {
    const insidePre = useContext(InsidePreContext)
    // Apply inline-code styling only for true inline code, not unlanguaged fenced blocks
    if (!className && !insidePre) {
      return <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs border border-border">{children}</code>
    }
    return <code className={className}>{children}</code>
  },
  ul: ({ children }) => <ul className="my-1 ml-4 list-disc space-y-0.5">{children}</ul>,
  ol: ({ children }) => <ol className="my-1 ml-4 list-decimal space-y-0.5">{children}</ol>,
  blockquote: ({ children }) => (
    <blockquote className="my-1 border-l-2 border-border pl-3 text-muted-foreground">{children}</blockquote>
  ),
  hr: () => <hr className="my-2 border-border" />,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="underline text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 break-all">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto rounded-md border border-border">
      <table className="w-full border-collapse text-foreground">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="px-3 py-1.5 text-left text-xxs font-semibold text-muted-foreground">{children}</th>
  ),
  td: ({ children }) => <td className="px-3 py-1.5 text-xs">{children}</td>,
  tr: ({ children }) => <tr className="border-t border-border">{children}</tr>,
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

const THINKING_TRUNCATE_LENGTH = 100

function ThinkingMessage({ message, isActive, duration }: {
  message: ChatMessageType
  isActive: boolean
  duration?: number
}) {
  const elapsed = useElapsedTime(message.timestamp, isActive)
  const displayDuration = duration ?? elapsed
  const [expanded, setExpanded] = useState(false)

  if (!isActive && !message.content.trim()) return null

  const content = message.content
  const needsTruncation = content.length > THINKING_TRUNCATE_LENGTH
  const displayContent = expanded || !needsTruncation
    ? content
    : content.slice(0, THINKING_TRUNCATE_LENGTH) + "…"

  return (
    <div className="animate-fade-in overflow-hidden flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <div className="flex h-5 w-5 items-center justify-center rounded-[10px] bg-amber-500/15">
          {isActive ? (
            <svg className="h-2.5 w-2.5 animate-spin text-amber-500" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          ) : (
            <svg className="h-2.5 w-2.5 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 18v-5.25m0 0a6.01 6.01 0 0 0 1.5-.189m-1.5.189a6.01 6.01 0 0 1-1.5-.189m3.75 7.478a12.06 12.06 0 0 1-4.5 0m3.75 2.383a14.406 14.406 0 0 1-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 1 0-7.517 0c.85.493 1.509 1.333 1.509 2.316V18" />
            </svg>
          )}
        </div>
        <span className="text-xs font-medium text-amber-500/70">
          {isActive ? "Thinking" : "Thought"}
        </span>
        <span className="text-2xs text-amber-500/50">
          {isActive ? `${formatElapsed(elapsed)}` : formatElapsed(displayDuration)}
        </span>
        <span className="text-2xs text-muted-foreground/50">{formatTimestamp(message.timestamp)}</span>
      </div>
      <div className="rounded-lg border border-amber-500/10 bg-amber-500/5 px-3 py-2 text-xs italic leading-[1.6] text-muted-foreground break-words">
        {displayContent}
        {needsTruncation && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="ml-1 text-amber-500/70 hover:text-amber-500 font-medium not-italic"
          >
            {expanded ? "show less" : "show more"}
          </button>
        )}
      </div>
    </div>
  )
}

function getContentBlock(message: ChatMessageType): AgentContentBlock | null {
  if (message.contentBlock) return message.contentBlock
  try {
    const parsed = JSON.parse(message.content) as unknown
    return typeof parsed === "object" && parsed !== null && "type" in parsed && typeof parsed.type === "string"
      ? parsed as AgentContentBlock
      : null
  } catch {
    return null
  }
}

function ContentBlockFrame({ label, timestamp, icon, children }: {
  label: string
  timestamp: string
  icon: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="animate-fade-in overflow-hidden rounded-md border border-border bg-muted">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span className="h-2 w-2 rounded-full bg-status-success" />
        <span className="h-3.5 w-3.5 text-muted-foreground [&>svg]:h-3.5 [&>svg]:w-3.5">{icon}</span>
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <span className="flex-1" />
        <span className="text-2xs text-muted-foreground">{formatTimestamp(timestamp)}</span>
      </div>
      <div className="border-t border-border p-3">{children}</div>
    </div>
  )
}

function getStringField(block: AgentContentBlock, key: string): string | null {
  const value = block[key]
  return typeof value === "string" ? value : null
}

function getDiffBlock(block: AgentContentBlock): { path: string; oldText: string; newText: string } | null {
  if (block.type !== "diff") return null
  const newText = getStringField(block, "newText")
  if (newText === null) return null
  return {
    path: getStringField(block, "path") ?? "Untitled diff",
    oldText: getStringField(block, "oldText") ?? "",
    newText,
  }
}

function getTerminalBlock(block: AgentContentBlock): { terminalId: string } | null {
  if (block.type !== "terminal") return null
  const terminalId = getStringField(block, "terminalId")
  return terminalId ? { terminalId } : null
}

function DiffContentBlockCard({ message, block }: { message: ChatMessageType; block: AgentContentBlock }) {
  const diff = getDiffBlock(block)
  if (!diff) return null
  const stats = getDiffStats(diff.oldText, diff.newText)
  return (
    <ContentBlockFrame label="Diff" timestamp={message.timestamp} icon={<FileDiff />}>
      <div className="overflow-hidden rounded-md border border-border bg-background">
        <div className="flex flex-wrap items-center gap-2 px-2.5 py-2">
          <div className="min-w-0 flex-1 break-words font-mono text-xs font-medium text-foreground">{diff.path}</div>
          <div className="flex items-center gap-1">
            <Badge variant="secondary">+{stats.additions}</Badge>
            <Badge variant="destructive">-{stats.deletions}</Badge>
          </div>
        </div>
        <Separator />
        <div className="max-h-80 overflow-auto">
          <DiffViewer oldString={diff.oldText} newString={diff.newText} className="rounded-none border-0" />
        </div>
      </div>
    </ContentBlockFrame>
  )
}

function TerminalContentBlockCard({ message, block }: { message: ChatMessageType; block: AgentContentBlock }) {
  const terminal = getTerminalBlock(block)
  if (!terminal) return null
  return (
    <ContentBlockFrame label="Terminal" timestamp={message.timestamp} icon={<Terminal />}>
      <div className="rounded-md border border-border bg-background px-2.5 py-2">
        <div className="font-mono text-xs font-medium text-foreground">{terminal.terminalId}</div>
        <div className="mt-1 text-2xs text-muted-foreground">Live terminal output is available in the terminal pane when attached.</div>
      </div>
    </ContentBlockFrame>
  )
}

function GenericContentBlockCard({ message, block }: { message: ChatMessageType; block: AgentContentBlock }) {
  const title = typeof block.title === "string" ? block.title
    : typeof block.name === "string" ? block.name
      : typeof block.uri === "string" ? block.uri
        : block.type
  const uri = typeof block.uri === "string" ? block.uri : null
  const label = block.type === "resource_link" ? "Resource link"
    : block.type === "resource" ? "Resource"
      : block.type === "image" ? "Image"
        : block.type

  return (
    <ContentBlockFrame label={label} timestamp={message.timestamp} icon={<FileText />}>
      <div className="rounded-md border border-border bg-background px-2.5 py-2">
        <div className="text-xs font-medium text-foreground">{title}</div>
        {uri && <div className="mt-1 break-words font-mono text-2xs text-muted-foreground">{uri}</div>}
        {typeof block.mimeType === "string" && <div className="mt-1 text-2xs text-muted-foreground">{block.mimeType}</div>}
      </div>
    </ContentBlockFrame>
  )
}

function ContentBlockMessage({ message }: { message: ChatMessageType }) {
  const block = getContentBlock(message)
  if (!block) return null
  if (block.type === "text") return null
  if (block.type === "diff") return <DiffContentBlockCard message={message} block={block} />
  if (block.type === "terminal") return <TerminalContentBlockCard message={message} block={block} />
  return <GenericContentBlockCard message={message} block={block} />
}

function getPlanEntries(message: ChatMessageType): AgentPlanEntry[] {
  if (message.planEntries) return message.planEntries
  try {
    const parsed = JSON.parse(message.content) as unknown
    return Array.isArray(parsed) ? parsed.filter((entry): entry is AgentPlanEntry => typeof entry === "object" && entry !== null && "content" in entry) : []
  } catch {
    return []
  }
}

function PlanMessage({ message }: { message: ChatMessageType }) {
  const entries = getPlanEntries(message)
  if (entries.length === 0) return null
  return (
    <div className="animate-fade-in flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex items-center gap-2">
        <div className="flex h-5 w-5 items-center justify-center rounded-[10px] bg-violet-500/15">
          <svg className="h-2.5 w-2.5 text-violet-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
          </svg>
        </div>
        <span className="text-xs font-medium text-violet-500/80">Plan</span>
        <span className="text-2xs text-muted-foreground/50">{formatTimestamp(message.timestamp)}</span>
      </div>
      <div className="flex flex-col gap-1.5">
        {entries.map((entry, index) => (
          <div key={`${entry.content}-${index}`} className="flex items-start gap-2 rounded-md bg-background/60 px-2.5 py-2 text-xs">
            <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-500/60" />
            <div className="min-w-0 flex-1 leading-[1.5] text-foreground">{entry.content}</div>
            {entry.status && <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">{entry.status}</span>}
            {entry.priority && <span className="shrink-0 rounded bg-violet-500/10 px-1.5 py-0.5 text-2xs text-violet-500">{entry.priority}</span>}
          </div>
        ))}
      </div>
    </div>
  )
}

export const ChatMessage = memo(function ChatMessage({ message, tasks, onReply, isThinkingActive = false, thinkingDuration }: ChatMessageProps) {
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
  const isPlan = message.role === "plan"
  const isContentBlock = message.role === "content"
  // Legacy narration rows from old providers — skip rendering (ACP doesn't emit these)
  const isNarration = message.role === "narration"
  const isTool = !isUser && !isSystem && !isThinking && !isPlan && !isContentBlock && !isNarration && isToolCall(message.content)

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

  // Skip legacy narration rows from old providers
  if (isNarration) return null

  if (isUser) {
    return (
      <div ref={messageRef} onClick={handleGroupClick} className="animate-fade-in group relative flex flex-col items-end gap-0.5">
        <div className="max-w-[85%] rounded-xl bg-primary px-3.5 py-2.5">
          {message.images && message.images.length > 0 && (
            <>
              <div className="mb-2 flex flex-wrap gap-1">
                {message.images.map((img, i) => (
                  <button key={i} onClick={() => setLightboxIndex(i)} className="cursor-zoom-in rounded outline-none focus-visible:ring-1 focus-visible:ring-ring/50">
                    <AuthenticatedImage
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
              className="break-words leading-[1.5] text-primary-foreground [&_a]:underline [&_a]:text-blue-600 [&_a]:dark:text-blue-400 hover:[&_a]:text-blue-800 dark:hover:[&_a]:text-blue-300 [&_a]:break-all [&_code]:bg-primary-foreground/15 [&_code]:border-primary-foreground/20 [&_pre_code]:bg-transparent [&_pre_code]:border-transparent [&_pre]:bg-primary-foreground/10 [&_pre]:border-primary-foreground/15 [&_blockquote]:border-primary-foreground/30 [&_blockquote]:text-primary-foreground/70"
              onClick={handleLinkClick}
            >
              <ReactMarkdown remarkPlugins={userRemarkPlugins} components={markdownComponents}>
                {message.content}
              </ReactMarkdown>
            </div>
          )}
          <span className="mt-1 block text-right text-2xs text-primary-foreground/50">
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
        <svg className="h-3 w-3 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 0 1-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 0 1 4.5 0" />
        </svg>
        <span className="text-xxs text-muted-foreground">{message.content}</span>
      </div>
    )
  }

  // Thinking message
  if (isThinking) {
    return (
      <ThinkingMessage
        message={message}
        isActive={isThinkingActive}
        duration={thinkingDuration}
      />
    )
  }

  if (isPlan) {
    return <PlanMessage message={message} />
  }

  if (isContentBlock) {
    return <ContentBlockMessage message={message} />
  }

  // Agent message
  return (
    <div ref={messageRef} onClick={handleGroupClick} className="animate-fade-in group relative flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <div className="flex h-5 w-5 items-center justify-center rounded-[10px] bg-primary">
          <svg className="h-2.5 w-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 0 1-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 0 1 4.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0 1 12 15a9.065 9.065 0 0 0-6.23.693L5 14.5m14.8.8 1.402 1.402c1.232 1.232.65 3.318-1.067 3.611l-.772.13a18.142 18.142 0 0 1-6.126 0l-.772-.13c-1.717-.293-2.3-2.379-1.067-3.61L13 15" />
          </svg>
        </div>
        <span className="text-xs font-semibold text-foreground">Agent</span>
        <span className="text-2xs text-muted-foreground/50">{formatTimestamp(message.timestamp)}</span>
      </div>
      <div className="leading-[1.6] text-foreground break-words" onClick={handleLinkClick}>
        <ReactMarkdown remarkPlugins={remarkPlugins} components={markdownComponents}>
          {message.content}
        </ReactMarkdown>
      </div>
      {message.images && message.images.length > 0 && (
        <>
          <div className="flex flex-wrap gap-1">
            {message.images.map((img, i) => (
              <button key={i} onClick={() => setLightboxIndex(i)} className="cursor-zoom-in">
                <AuthenticatedImage src={img.src} alt="Agent image" className="h-16 w-16 rounded-md object-cover" />
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
