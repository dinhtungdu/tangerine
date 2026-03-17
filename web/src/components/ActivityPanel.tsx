import { useState } from "react"
import type { ChatMessage } from "../hooks/useSession"
import { getEventStyle } from "../lib/activity"
import { formatTimestamp } from "../lib/format"

type PanelTab = "activities" | "diff"

interface ActivityPanelProps {
  messages: ChatMessage[]
  onCollapse?: () => void
}

export function ActivityPanel({ messages, onCollapse }: ActivityPanelProps) {
  const [tab, setTab] = useState<PanelTab>("activities")

  const activities = messages.filter((m) => m.role === "assistant" || m.role === "tool")

  return (
    <div className="flex h-full w-[340px] shrink-0 flex-col border-l border-[#e4e4e7] bg-[#f5f5f5]">
      {/* Panel header */}
      <div className="flex h-11 items-center justify-between border-b border-[#e5e5e5] bg-[#fafafa] px-4">
        <div className="flex items-center gap-0.5" role="tablist">
          <button
            role="tab"
            aria-selected={tab === "activities"}
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
            role="tab"
            aria-selected={tab === "diff"}
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
          <button onClick={onCollapse} aria-label="Collapse panel" className="text-[#737373] hover:text-[#0a0a0a]">
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
            <div className="flex h-7 items-center justify-between">
              <span className="font-mono text-[10px] font-medium tracking-wider text-[#737373]">ACTIVITY</span>
              <div className="flex items-center justify-center rounded-sm bg-[#f5f5f5] px-1.5">
                <span className="font-mono text-[10px] font-medium text-[#737373]">{activities.length}</span>
              </div>
            </div>

            <div className="flex flex-col">
              {activities.map((msg) => {
                const style = getEventStyle(msg.content)

                return (
                  <div key={msg.id} className="flex gap-3 py-2">
                    <span className="w-11 shrink-0 text-[11px] text-[#737373]">
                      {formatTimestamp(msg.timestamp)}
                    </span>
                    <div
                      className="flex h-4 w-4 shrink-0 items-center justify-center rounded-lg"
                      style={{ backgroundColor: style.bg }}
                    >
                      <div className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: style.dot }} />
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
