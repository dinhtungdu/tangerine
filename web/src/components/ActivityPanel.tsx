import { useState } from "react"
import type { ChatMessage } from "../hooks/useSession"

type PanelTab = "activities" | "diff"

interface ActivityPanelProps {
  messages: ChatMessage[]
  onCollapse?: () => void
}

const eventColors: Record<string, string> = {
  read: "#3b82f620",
  write: "#8b5cf620",
  edit: "#8b5cf620",
  bash: "#3b82f620",
  search: "#f59e0b20",
  test: "#22c55e20",
  default: "#3b82f620",
}

const eventIconColors: Record<string, string> = {
  read: "#3b82f6",
  write: "#8b5cf6",
  edit: "#8b5cf6",
  bash: "#3b82f6",
  search: "#f59e0b",
  test: "#22c55e",
  default: "#3b82f6",
}

function getEventType(msg: ChatMessage): string {
  const content = msg.content.toLowerCase()
  if (content.includes("read file") || content.includes("file-search")) return "read"
  if (content.includes("write file") || content.includes("file-pen")) return "write"
  if (content.includes("edit")) return "edit"
  if (content.includes("bash") || content.includes("terminal")) return "bash"
  if (content.includes("search") || content.includes("grep")) return "search"
  if (content.includes("test")) return "test"
  return "default"
}

function formatTimestamp(ts: string): string {
  const d = new Date(ts)
  return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

export function ActivityPanel({ messages, onCollapse }: ActivityPanelProps) {
  const [tab, setTab] = useState<PanelTab>("activities")

  // Filter to only tool calls and agent messages for activity
  const activities = messages.filter((m) => m.role === "assistant" || m.role === "tool")

  return (
    <div className="flex h-full w-[340px] shrink-0 flex-col border-l border-[#e4e4e7] bg-[#f5f5f5]">
      {/* Panel header */}
      <div className="flex h-11 items-center justify-between border-b border-[#e5e5e5] bg-[#fafafa] px-4">
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => setTab("activities")}
            className={`rounded-sm px-3 py-1.5 text-[13px] font-medium ${
              tab === "activities"
                ? "bg-[#fafafa] text-[#0a0a0a] shadow-sm"
                : "text-[#737373]"
            }`}
          >
            Activities
          </button>
          <button
            onClick={() => setTab("diff")}
            className={`rounded-sm px-3 py-1.5 text-[13px] font-medium ${
              tab === "diff"
                ? "bg-[#fafafa] text-[#0a0a0a] shadow-sm"
                : "text-[#737373]"
            }`}
          >
            Diff
          </button>
        </div>
        {onCollapse && (
          <button onClick={onCollapse} className="text-[#737373] hover:text-[#0a0a0a]">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3" />
            </svg>
          </button>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 pt-3">
        {tab === "activities" ? (
          <div className="flex flex-col">
            {/* Section label */}
            <div className="flex h-7 items-center justify-between">
              <span className="font-mono text-[10px] font-medium tracking-wider text-[#737373]">ACTIVITY</span>
              <div className="flex items-center justify-center rounded-sm bg-[#f5f5f5] px-1.5">
                <span className="font-mono text-[10px] font-medium text-[#737373]">{activities.length}</span>
              </div>
            </div>

            {/* Activity entries */}
            <div className="flex flex-col">
              {activities.map((msg) => {
                const eventType = getEventType(msg)
                const bgColor = eventColors[eventType] ?? eventColors.default
                const iconColor = eventIconColors[eventType] ?? eventIconColors.default

                return (
                  <div key={msg.id} className="flex gap-3 py-2">
                    <span className="w-11 shrink-0 text-[11px] text-[#737373]">
                      {formatTimestamp(msg.timestamp)}
                    </span>
                    <div
                      className="flex h-4 w-4 shrink-0 items-center justify-center rounded-lg"
                      style={{ backgroundColor: bgColor }}
                    >
                      <div className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: iconColor }} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12px] text-[#0a0a0a]">
                        {msg.content.slice(0, 80)}
                      </p>
                    </div>
                  </div>
                )
              })}

              {activities.length === 0 && (
                <div className="py-8 text-center text-[12px] text-[#737373]">
                  No activity yet
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="py-8 text-center text-[12px] text-[#737373]">
            No file changes yet
          </div>
        )}
      </div>
    </div>
  )
}
