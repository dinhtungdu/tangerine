import type { ActivityEntry } from "@tangerine/shared"
import { getActivityStyle, getActivityDetail } from "../lib/activity"
import { formatTimestamp } from "../lib/format"

interface ActivityListProps {
  activities: ActivityEntry[]
  variant?: "compact" | "timeline"
}

export function ActivityList({ activities, variant = "compact" }: ActivityListProps) {
  if (activities.length === 0) {
    return <div className="py-8 text-center text-[12px] text-fg-muted">No activity yet</div>
  }

  // Show newest activity first so users don't have to scroll to see latest events
  const reversed = [...activities].reverse()

  if (variant === "timeline") {
    return <TimelineView activities={reversed} />
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="font-mono text-[11px] font-semibold tracking-wider text-fg-muted">ACTIVITY</span>
        <span className="font-mono text-[11px] font-medium text-fg-muted">{activities.length}</span>
      </div>
      <div className="flex flex-col">
        {reversed.map((entry, i) => (
          <ActivityItem
            key={entry.id}
            entry={entry}
            isLast={i === 0}
          />
        ))}
      </div>
    </div>
  )
}

function ActivityItem({ entry, isLast }: { entry: ActivityEntry; isLast: boolean }) {
  const style = getActivityStyle(entry.event)
  const detail = getActivityDetail(entry.event, entry.content, entry.metadata)
  const isRunning = entry.metadata?.status === "running"
  const meta = entry.metadata as Record<string, unknown> | null

  return (
    <div className="flex gap-2.5 px-3 py-1">
      <div
        className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full"
        style={{ backgroundColor: style.bg }}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke={style.color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          {style.iconPaths.map((d, i) => (
            <path key={i} d={d} />
          ))}
        </svg>
      </div>
      <div className="min-w-0 flex-1">
        {style.label ? (
          <>
            <p className="text-[12px] font-medium leading-tight text-fg">{style.label}</p>
            <p className="mt-0.5 line-clamp-2 break-all font-mono text-[11px] text-fg-muted">{detail}</p>
          </>
        ) : (
          <p className="line-clamp-2 break-all font-mono text-[12px] leading-tight text-fg">{detail}</p>
        )}
        <StatusRow meta={meta} isRunning={isRunning && isLast} />
        <span className="mt-0.5 block text-[10px] text-fg-faint">
          {formatTimestamp(entry.timestamp)}
        </span>
      </div>
    </div>
  )
}

function StatusRow({ meta, isRunning }: { meta: Record<string, unknown> | null; isRunning: boolean }) {
  if (!meta && !isRunning) return null

  const testPassed = meta?.testPassed as number | undefined
  const testFailed = meta?.testFailed as number | undefined
  const linesAdded = meta?.linesAdded as number | undefined
  const linesRemoved = meta?.linesRemoved as number | undefined

  // Test results
  if (testPassed !== undefined || testFailed !== undefined) {
    return (
      <div className="mt-1 flex gap-1">
        {testPassed !== undefined && (
          <span className="text-[11px] font-medium text-diff-add">{testPassed} passed{testFailed !== undefined ? "," : ""}</span>
        )}
        {testFailed !== undefined && testFailed > 0 && (
          <span className="text-[11px] font-medium text-diff-remove">{testFailed} failed</span>
        )}
        {testFailed === 0 && testPassed !== undefined && (
          <span className="text-[11px] font-medium text-diff-add">0 failed</span>
        )}
      </div>
    )
  }

  // Diff stats
  if (linesAdded !== undefined || linesRemoved !== undefined) {
    return (
      <div className="mt-1 flex gap-1.5">
        {linesAdded !== undefined && <span className="text-[11px] font-semibold text-diff-add">+{linesAdded}</span>}
        {linesRemoved !== undefined && <span className="text-[11px] font-semibold text-diff-remove">-{linesRemoved}</span>}
      </div>
    )
  }

  // In progress badge
  if (isRunning) {
    return (
      <div className="mt-1">
        <span className="rounded bg-accent-bg px-1.5 py-0.5 text-[10px] font-medium text-accent">
          in progress
        </span>
      </div>
    )
  }

  return null
}

function TimelineView({ activities }: { activities: ActivityEntry[] }) {
  const groups: { label: string; items: ActivityEntry[] }[] = []
  let currentLabel = ""

  for (const entry of activities) {
    const d = new Date(entry.timestamp)
    const today = new Date()
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)

    const label = d.toDateString() === today.toDateString() ? "Today"
      : d.toDateString() === yesterday.toDateString() ? "Yesterday"
      : d.toLocaleDateString("en-US", { month: "short", day: "numeric" })

    if (label !== currentLabel) {
      groups.push({ label, items: [] })
      currentLabel = label
    }
    groups[groups.length - 1]!.items.push(entry)
  }

  return (
    <div className="h-full overflow-y-auto px-4 py-4">
      {groups.map((group) => (
        <div key={group.label} className="mb-6">
          <div className="mb-3 text-[12px] font-semibold text-fg-faint">{group.label}</div>
          <div className="flex flex-col gap-4">
            {group.items.map((entry) => {
              const style = getActivityStyle(entry.event)
              const detail = getActivityDetail(entry.event, entry.content, entry.metadata)
              return (
                <div key={entry.id} className="flex gap-3">
                  <div className="flex flex-col items-center pt-1">
                    <div
                      className="flex h-6 w-6 items-center justify-center rounded-full"
                      style={{ backgroundColor: style.bg }}
                    >
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke={style.color} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                        {style.iconPaths.map((d, i) => (
                          <path key={i} d={d} />
                        ))}
                      </svg>
                    </div>
                    <div className="mt-1 w-px flex-1 bg-edge" />
                  </div>
                  <div className="min-w-0 flex-1 pb-2">
                    {style.label ? (
                      <>
                        <p className="text-[13px] font-medium leading-tight text-fg">{style.label}</p>
                        <p className="mt-0.5 text-[11px] text-fg-faint">{detail}</p>
                      </>
                    ) : (
                      <p className="text-[13px] leading-tight text-fg">{detail}</p>
                    )}
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
