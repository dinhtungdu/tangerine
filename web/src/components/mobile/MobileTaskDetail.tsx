import { useState, useEffect, useRef, useCallback, type KeyboardEvent } from "react"
import { useParams, useNavigate } from "react-router-dom"
import type { Task } from "@tangerine/shared"
import { fetchTask, fetchDiff, type DiffFile } from "../../lib/api"
import { useSession, type ChatMessage as ChatMessageType } from "../../hooks/useSession"
import { ChatMessage } from "../ChatMessage"

type ViewTab = "chat" | "diff" | "activities"

const statusColors: Record<string, string> = {
  running: "#22c55e",
  done: "#a3a3a3",
  failed: "#ef4444",
  cancelled: "#a3a3a3",
  created: "#f59e0b",
  provisioning: "#f59e0b",
}

export function MobileTaskDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [task, setTask] = useState<Task | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<ViewTab>("chat")

  const session = useSession(id ?? "")

  useEffect(() => {
    if (!id) return
    let cancelled = false
    async function load() {
      try {
        const data = await fetchTask(id!)
        if (!cancelled) setTask(data)
      } catch {
        // not found
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    const interval = setInterval(load, 10000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [id])

  useEffect(() => {
    if (session.taskStatus) {
      setTask((prev) => (prev ? { ...prev, status: session.taskStatus! } : prev))
    }
  }, [session.taskStatus])

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-[#a3a3a3]">
        Loading...
      </div>
    )
  }

  if (!task) {
    return (
      <div className="flex h-full flex-col">
        <TaskHeader onBack={() => navigate("/")} title="Not found" status="failed" />
        <div className="flex flex-1 items-center justify-center text-[13px] text-[#a3a3a3]">
          Task not found
        </div>
      </div>
    )
  }

  const statusColor = statusColors[task.status] ?? "#a3a3a3"

  return (
    <div className="flex h-full flex-col bg-[#fafafa]">
      {/* Header */}
      <TaskHeader
        onBack={() => navigate("/")}
        title={task.title}
        status={task.status}
        statusColor={statusColor}
      />

      {/* View tabs */}
      <ViewTabs active={tab} onChange={setTab} />

      {/* Tab content */}
      <div className="min-h-0 flex-1">
        {tab === "chat" && (
          <MobileChatTab
            messages={session.messages}
            agentStatus={session.agentStatus}
            onSend={session.sendPrompt}
            onAbort={session.abort}
          />
        )}
        {tab === "diff" && <MobileDiffTab taskId={id!} />}
        {tab === "activities" && <MobileActivityTab messages={session.messages} />}
      </div>
    </div>
  )
}

/* ─── Header ─── */

function TaskHeader({
  onBack,
  title,
  status,
  statusColor,
}: {
  onBack: () => void
  title: string
  status: string
  statusColor?: string
}) {
  const color = statusColor ?? "#a3a3a3"
  const label =
    status === "running" ? "Running" :
    status === "done" ? "Completed" :
    status === "failed" ? "Failed" :
    status === "provisioning" ? "Provisioning" :
    status === "created" ? "Queued" :
    status

  return (
    <div className="flex items-center gap-2 border-b border-[#e5e5e5] bg-white px-4 py-2.5">
      <button onClick={onBack} className="text-[#0a0a0a]">
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18" />
        </svg>
      </button>
      <div className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
      <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-[#0a0a0a]">{title}</span>
      <span className="shrink-0 text-[12px] font-normal" style={{ color }}>{label}</span>
    </div>
  )
}

/* ─── View Tabs ─── */

function ViewTabs({ active, onChange }: { active: ViewTab; onChange: (t: ViewTab) => void }) {
  const tabs: { id: ViewTab; label: string }[] = [
    { id: "chat", label: "Chat" },
    { id: "diff", label: "Diff" },
    { id: "activities", label: "Activities" },
  ]

  return (
    <div className="flex items-center gap-1 border-b border-[#e5e5e5] bg-[#f5f5f5] px-3 py-1">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={`rounded-md px-3 py-1.5 text-[13px] font-medium transition ${
            active === t.id
              ? "bg-white text-[#0a0a0a] shadow-sm"
              : "text-[#737373]"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

/* ─── Chat Tab ─── */

function MobileChatTab({
  messages,
  agentStatus,
  onSend,
  onAbort,
}: {
  messages: ChatMessageType[]
  agentStatus: "idle" | "working"
  onSend: (text: string) => void
  onAbort: () => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [text, setText] = useState("")
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length])

  const handleSend = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed) return
    onSend(trimmed)
    setText("")
    if (textareaRef.current) textareaRef.current.style.height = "auto"
  }, [text, onSend])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend],
  )

  return (
    <div className="flex h-full flex-col">
      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4">
        <div className="flex flex-col gap-3">
          {messages.length === 0 ? (
            <div className="py-20 text-center text-[13px] text-[#a3a3a3]">
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
              <div className="flex w-fit items-center gap-1 rounded-lg bg-[#f5f5f5] px-3 py-2">
                <div className="h-1.5 w-1.5 rounded-full bg-[#737373] animate-thinking-dot" />
                <div className="h-1.5 w-1.5 rounded-full bg-[#737373] animate-thinking-dot" />
                <div className="h-1.5 w-1.5 rounded-full bg-[#737373] animate-thinking-dot" />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Input bar */}
      <div className="flex items-center gap-2 border-t border-[#e5e5e5] bg-white px-3 py-2">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            const ta = textareaRef.current
            if (ta) {
              ta.style.height = "auto"
              ta.style.height = `${Math.min(ta.scrollHeight, 100)}px`
            }
          }}
          onKeyDown={handleKeyDown}
          placeholder={agentStatus === "working" ? "Agent is working..." : "Message agent..."}
          disabled={agentStatus === "working"}
          rows={1}
          className="min-w-0 flex-1 resize-none rounded-lg border border-[#e5e5e5] bg-[#fafafa] px-3 py-2 text-[14px] text-[#0a0a0a] placeholder-[#a3a3a3] outline-none disabled:opacity-50"
        />
        {agentStatus === "working" ? (
          <button
            onClick={onAbort}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#ef4444] text-white"
          >
            <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24">
              <rect x="6" y="6" width="12" height="12" rx="1" />
            </svg>
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!text.trim()}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#171717] text-white disabled:opacity-30"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 10.5 12 3m0 0 7.5 7.5M12 3v18" />
            </svg>
          </button>
        )}
      </div>
    </div>
  )
}

/* ─── Diff Tab ─── */

function MobileDiffTab({ taskId }: { taskId: string }) {
  const [files, setFiles] = useState<DiffFile[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const data = await fetchDiff(taskId)
        if (!cancelled) setFiles(data.files ?? [])
      } catch {
        // no diff
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    const interval = setInterval(load, 15000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [taskId])

  if (loading) {
    return <div className="p-4 text-center text-[13px] text-[#a3a3a3]">Loading diff...</div>
  }

  if (files.length === 0) {
    return <div className="p-8 text-center text-[13px] text-[#a3a3a3]">No file changes yet</div>
  }

  // Count additions/deletions
  let totalAdded = 0
  let totalRemoved = 0
  for (const f of files) {
    for (const line of f.diff.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) totalAdded++
      if (line.startsWith("-") && !line.startsWith("---")) totalRemoved++
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      {/* Stats bar */}
      <div className="flex items-center gap-2 border-b border-[#e5e5e5] bg-[#f5f5f5] px-4 py-2 text-[12px]">
        <span className="text-green-600">+{totalAdded}</span>
        <span className="text-red-500">-{totalRemoved}</span>
        <span className="text-[#737373]">{files.length} files changed</span>
      </div>

      {/* File diffs */}
      {files.map((file) => (
        <div key={file.path} className="border-b border-[#e5e5e5]">
          <div className="bg-[#f9fafb] px-4 py-2 text-[12px] font-medium font-mono text-[#0a0a0a]">
            {file.path}
          </div>
          <pre className="overflow-x-auto px-4 py-2 font-mono text-[11px] leading-[1.7]">
            {file.diff.split("\n").map((line, i) => {
              const color = line.startsWith("+")
                ? "text-green-700 bg-green-50"
                : line.startsWith("-")
                  ? "text-red-600 bg-red-50"
                  : line.startsWith("@@")
                    ? "text-blue-600"
                    : "text-[#737373]"
              return (
                <div key={i} className={`px-1 ${color}`}>
                  {line}
                </div>
              )
            })}
          </pre>
        </div>
      ))}
    </div>
  )
}

/* ─── Activities Tab ─── */

const eventColors: Record<string, { bg: string; dot: string }> = {
  read: { bg: "#3b82f620", dot: "#3b82f6" },
  write: { bg: "#8b5cf620", dot: "#8b5cf6" },
  edit: { bg: "#8b5cf620", dot: "#8b5cf6" },
  bash: { bg: "#3b82f620", dot: "#3b82f6" },
  search: { bg: "#f59e0b20", dot: "#f59e0b" },
  test: { bg: "#22c55e20", dot: "#22c55e" },
  default: { bg: "#3b82f620", dot: "#3b82f6" },
}

function getEventType(content: string): string {
  const lc = content.toLowerCase()
  if (lc.includes("read file") || lc.includes("file-search")) return "read"
  if (lc.includes("write file") || lc.includes("file-pen")) return "write"
  if (lc.includes("edit")) return "edit"
  if (lc.includes("bash") || lc.includes("terminal")) return "bash"
  if (lc.includes("search") || lc.includes("grep")) return "search"
  if (lc.includes("test")) return "test"
  return "default"
}

function formatTimestamp(ts: string): string {
  const d = new Date(ts)
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return d.toLocaleTimeString("en-US", { hour12: true, hour: "numeric", minute: "2-digit" })
}

function MobileActivityTab({ messages }: { messages: ChatMessageType[] }) {
  const activities = messages.filter((m) => m.role === "assistant" || m.role === "tool")

  if (activities.length === 0) {
    return <div className="p-8 text-center text-[13px] text-[#a3a3a3]">No activity yet</div>
  }

  // Group by day
  const groups: { label: string; items: ChatMessageType[] }[] = []
  let currentLabel = ""

  for (const msg of activities) {
    const d = new Date(msg.timestamp)
    const today = new Date()
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)

    let label: string
    if (d.toDateString() === today.toDateString()) label = "Today"
    else if (d.toDateString() === yesterday.toDateString()) label = "Yesterday"
    else label = d.toLocaleDateString("en-US", { month: "short", day: "numeric" })

    if (label !== currentLabel) {
      groups.push({ label, items: [] })
      currentLabel = label
    }
    groups[groups.length - 1]!.items.push(msg)
  }

  return (
    <div className="h-full overflow-y-auto px-4 py-4">
      {groups.map((group) => (
        <div key={group.label} className="mb-6">
          <div className="mb-3 text-[12px] font-semibold text-[#a3a3a3]">{group.label}</div>
          <div className="flex flex-col gap-4">
            {group.items.map((msg) => {
              const eventType = getEventType(msg.content)
              const colors = eventColors[eventType] ?? eventColors.default!

              return (
                <div key={msg.id} className="flex gap-3">
                  {/* Timeline dot */}
                  <div className="flex flex-col items-center pt-1">
                    <div
                      className="flex h-6 w-6 items-center justify-center rounded-full"
                      style={{ backgroundColor: colors.bg }}
                    >
                      <div className="h-2 w-2 rounded-full" style={{ backgroundColor: colors.dot }} />
                    </div>
                    <div className="mt-1 w-px flex-1 bg-[#e5e5e5]" />
                  </div>

                  {/* Content */}
                  <div className="min-w-0 flex-1 pb-2">
                    <p className="text-[13px] font-medium text-[#0a0a0a] leading-tight">
                      {msg.content.slice(0, 100)}
                      {msg.content.length > 100 && "..."}
                    </p>
                    <span className="mt-1 text-[11px] text-[#a3a3a3]">{formatTimestamp(msg.timestamp)}</span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
