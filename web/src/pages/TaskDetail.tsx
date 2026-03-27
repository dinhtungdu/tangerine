import { useState, useEffect, useCallback, useRef } from "react"
import { useParams } from "react-router-dom"
import type { Task } from "@tangerine/shared"
import { fetchTask, changeTaskConfig, markTaskSeen } from "../lib/api"
import { getStatusConfig } from "../lib/status"
import { useSession } from "../hooks/useSession"
import { useTaskSearch } from "../hooks/useTaskSearch"
import { useProject } from "../context/ProjectContext"
import { useProjectNav } from "../hooks/useProjectNav"
import { useDiffFiles } from "../hooks/useDiffFiles"
import { useResizable } from "../hooks/useResizable"
import { TasksSidebar } from "../components/TasksSidebar"
import { ChatPanel } from "../components/ChatPanel"
import { DiffView } from "../components/DiffView"
import { ActivityList } from "../components/ActivityList"
import { ChangesPanel as DiffSidebar, type DiffComment } from "../components/ChangesPanel"
import { ResizeHandle, PaneToggle } from "../components/PaneControls"
import { TerminalPane } from "../components/TerminalPane"
import { formatPrNumber } from "../lib/format"

// navigator.clipboard requires HTTPS; fall back to execCommand for HTTP (local network, mobile)
function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text)
  }
  return new Promise((resolve, reject) => {
    const el = document.createElement("textarea")
    el.value = text
    el.style.cssText = "position:fixed;opacity:0;pointer-events:none"
    document.body.appendChild(el)
    el.focus()
    el.select()
    try {
      document.execCommand("copy")
      resolve()
    } catch (err) {
      reject(err)
    } finally {
      document.body.removeChild(el)
    }
  })
}

type PaneId = "chat" | "diff" | "terminal" | "activity"

export function TaskDetail() {
  const { id } = useParams<{ id: string }>()
  const { navigate } = useProjectNav()
  const [task, setTask] = useState<Task | null>(null)
  const [loading, setLoading] = useState(true)
  const [visiblePanes, setVisiblePanes] = useState<Set<PaneId>>(() => {
    try {
      const saved = localStorage.getItem(`tangerine:panes:${id}`)
      if (saved) return new Set(JSON.parse(saved) as PaneId[])
    } catch { /* ignore */ }
    return new Set<PaneId>(["chat", "activity"])
  })
  const [mobilePane, setMobilePane] = useState<PaneId>("chat")

  const { current, modelsByProvider } = useProject()
  const session = useSession(id ?? "")
  const { query, setQuery, tasks } = useTaskSearch(current?.name)
  const { files: diffFiles } = useDiffFiles(id ?? "")
  const [diffComments, setDiffComments] = useState<DiffComment[]>([])
  const [copiedId, setCopiedId] = useState(false)
  const handleCopyId = useCallback(() => {
    if (!id) return
    copyToClipboard(id).then(() => {
      setCopiedId(true)
      setTimeout(() => setCopiedId(false), 1500)
    })
  }, [id])
  const [copiedBranch, setCopiedBranch] = useState(false)
  const handleCopyBranch = useCallback((branch: string) => {
    copyToClipboard(branch).then(() => {
      setCopiedBranch(true)
      setTimeout(() => setCopiedBranch(false), 1500)
    })
  }, [])

  const dimsKey = `tangerine:pane-dims:${id}`
  const dimsRef = useRef<{ terminal: number; activity: number }>((() => {
    try {
      const s = localStorage.getItem(dimsKey)
      if (s) return JSON.parse(s)
    } catch { /* ignore */ }
    return { terminal: 480, activity: 250 }
  })())
  const saveDims = useCallback(() => {
    try { localStorage.setItem(dimsKey, JSON.stringify(dimsRef.current)) } catch { /* ignore */ }
  }, [dimsKey])

  const [terminalWidth, setTerminalWidth] = useState(dimsRef.current.terminal)
  const [activityWidth, setActivityWidth] = useState(dimsRef.current.activity)
  const containerRef = useRef<HTMLDivElement>(null)

  const MIN_PANE = 200

  const terminalResize = useResizable({
    onResize: useCallback((delta: number) => {
      setTerminalWidth((w) => {
        const next = Math.max(MIN_PANE, w - delta)
        dimsRef.current.terminal = next
        saveDims()
        return next
      })
    }, [saveDims]),
  })

  const activityResize = useResizable({
    onResize: useCallback((delta: number) => {
      setActivityWidth((w) => {
        const next = Math.max(MIN_PANE, w - delta)
        dimsRef.current.activity = next
        saveDims()
        return next
      })
    }, [saveDims]),
  })

  const togglePane = useCallback((pane: PaneId) => {
    setMobilePane(pane)
    setVisiblePanes((prev) => {
      const next = new Set(prev)
      if (next.has(pane)) next.delete(pane)
      else next.add(pane)
      if (next.size === 0) next.add("chat")
      try { localStorage.setItem(`tangerine:panes:${id}`, JSON.stringify([...next])) } catch { /* ignore */ }
      return next
    })
  }, [id])

  const handleAddComment = useCallback((comment: DiffComment) => {
    setDiffComments((prev) => [...prev, comment])
  }, [])

  const handleRemoveComment = useCallback((commentId: string) => {
    setDiffComments((prev) => prev.filter((c) => c.id !== commentId))
  }, [])

  const handleScrollToFile = useCallback((path: string) => {
    const el = document.getElementById(`diff-file-${path}`)
    el?.scrollIntoView({ behavior: "smooth", block: "start" })
  }, [])

  const providerModels = task ? (modelsByProvider[task.provider] ?? []) : []

  const handleModelChange = useCallback(async (model: string) => {
    if (!id || !task) return
    try {
      await changeTaskConfig(id, { model })
      setTask((prev) => prev ? { ...prev, model } : prev)
    } catch {
      // TODO: error toast
    }
  }, [id, task])

  const handleReasoningEffortChange = useCallback(async (reasoningEffort: string) => {
    if (!id || !task) return
    try {
      await changeTaskConfig(id, { reasoningEffort })
      setTask((prev) => prev ? { ...prev, reasoningEffort } : prev)
    } catch {
      // TODO: error toast
    }
  }, [id, task])

  const handleSendComments = useCallback((comments: DiffComment[]) => {
    const text = comments
      .map((c) => {
        const sideLabel = c.side === "left" ? "before change" : "after change"
        return `[${c.filePath}:${c.lineRef} (${sideLabel})] ${c.text}`
      })
      .join("\n\n")
    session.sendPrompt(text)
    setDiffComments([])
    setMobilePane("chat")
  }, [session])

  useEffect(() => {
    if (!id) return
    let cancelled = false
    async function load() {
      try {
        const data = await fetchTask(id!)
        if (!cancelled) setTask(data)
      } catch {
        // task not found
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    const interval = setInterval(load, 10000)

    // Immediately refresh when returning from background (iOS Safari suspends
    // timers and closes WebSockets when the tab is not visible).
    function onVisibilityChange() {
      if (document.visibilityState === "visible" && !cancelled) load()
    }
    document.addEventListener("visibilitychange", onVisibilityChange)

    return () => {
      cancelled = true
      clearInterval(interval)
      document.removeEventListener("visibilitychange", onVisibilityChange)
    }
  }, [id])

  // Mark task as seen on view and whenever it updates while viewing
  useEffect(() => {
    if (id) markTaskSeen(id).catch(() => {})
  }, [id, task?.updatedAt])

  useEffect(() => {
    if (session.taskStatus) {
      setTask((prev) => (prev ? { ...prev, status: session.taskStatus! } : prev))
    }
  }, [session.taskStatus])

  if (loading) {
    return (
      <div className="flex h-full">
        <div className="hidden md:block">
          <TasksSidebar tasks={tasks} searchQuery={query} onSearchChange={setQuery} onNewAgent={() => navigate("/new")} />
        </div>
        <div className="flex flex-1 items-center justify-center text-[13px] text-fg-muted">
          Loading...
        </div>
      </div>
    )
  }

  if (!task) {
    return (
      <div className="flex h-full">
        <div className="hidden md:block">
          <TasksSidebar tasks={tasks} searchQuery={query} onSearchChange={setQuery} onNewAgent={() => navigate("/new")} />
        </div>
        <div className="flex flex-1 items-center justify-center text-[13px] text-fg-muted">
          Task not found
        </div>
      </div>
    )
  }

  const { color: statusColor, label: statusLabel } = getStatusConfig(task.status)
  const isTerminal = task.status === "done" || task.status === "failed" || task.status === "cancelled"

  // Desktop: multi-pane from visiblePanes set. Mobile: single pane from mobilePane.
  // Both states are tracked; CSS breakpoints control which layout renders.
  const desktopIsSolo = visiblePanes.size === 1

  return (
    <div className="flex h-full">
      {/* Sidebar — desktop only */}
      <div className="hidden md:block">
        <TasksSidebar tasks={tasks} searchQuery={query} onSearchChange={setQuery} onNewAgent={() => navigate("/new")} />
      </div>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Task header — two rows on mobile (flex-col), one row on desktop (md:flex-row) */}
        <div className="flex flex-col border-b border-edge md:h-12 md:flex-row md:items-center md:justify-between md:px-5">
          {/* Row 1 / Left: back + task name + branch + status */}
          <div className="flex h-11 min-w-0 items-center gap-2 px-3 md:h-auto md:flex-1 md:gap-3 md:px-0">
            <button onClick={() => navigate("/")} aria-label="Back to runs" className="shrink-0 text-fg md:hidden">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18" />
              </svg>
            </button>
            <button
              onClick={handleCopyId}
              title="Click to copy task ID"
              className="min-w-0 truncate text-[14px] font-semibold text-fg hover:text-fg-muted"
            >
              {copiedId ? "Copied ID!" : task.title}
            </button>
            {task.branch && (
              <button
                onClick={() => handleCopyBranch(task.branch!)}
                title="Click to copy branch name"
                className="hidden shrink-0 items-center gap-1 hover:text-fg md:flex"
              >
                <svg className="h-3.5 w-3.5 text-fg-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 3v12m0 0a3 3 0 1 0 3 3m-3-3a3 3 0 0 1 3 3m0 0h6a3 3 0 0 0 3-3V9m0 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
                </svg>
                <span className="font-mono text-[12px] text-fg-muted">{copiedBranch ? "Copied!" : task.branch}</span>
              </button>
            )}
            {task.prUrl && (
              <a
                href={task.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex shrink-0 items-center gap-1 rounded bg-status-success-bg px-1.5 py-0.5 text-[10px] font-medium text-status-success-text"
              >
                {formatPrNumber(task.prUrl)}
              </a>
            )}
            <span
              className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium"
              style={{ backgroundColor: `color-mix(in srgb, ${statusColor} 10%, transparent)`, color: statusColor }}
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: statusColor }} />
              {statusLabel}
            </span>

          </div>

          {/* Row 2 / Right: pane toggles + divider + stop + more */}
          <div className="flex h-9 shrink-0 items-center justify-end gap-2 px-3 pb-1 md:h-auto md:px-0 md:pb-0">
            <div className="flex items-center gap-0.5 rounded-lg bg-surface-secondary p-[3px]">
              <PaneToggle desktopActive={visiblePanes.has("chat")} mobileActive={mobilePane === "chat"} onClick={() => togglePane("chat")} label="Chat">
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </PaneToggle>
              <PaneToggle desktopActive={visiblePanes.has("diff")} mobileActive={mobilePane === "diff"} onClick={() => togglePane("diff")} label="Diff">
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" />
                  <path d="M13 6h3a2 2 0 0 1 2 2v7M11 18H8a2 2 0 0 1-2-2V9" />
                </svg>
              </PaneToggle>
              <PaneToggle desktopActive={visiblePanes.has("terminal")} mobileActive={mobilePane === "terminal"} onClick={() => togglePane("terminal")} label="Terminal">
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="m6.75 7.5 3 2.25-3 2.25m4.5 0h3" />
                  <rect x="2" y="3" width="20" height="18" rx="2" />
                </svg>
              </PaneToggle>
              <PaneToggle desktopActive={visiblePanes.has("activity")} mobileActive={mobilePane === "activity"} onClick={() => togglePane("activity")} label="Activity">
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
                </svg>
              </PaneToggle>
            </div>
            <div className="h-5 w-px bg-edge" />
            <button className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-surface-secondary" aria-label="More options">
              <svg className="h-4 w-4 text-fg-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" />
              </svg>
            </button>
          </div>
        </div>

        {/* Desktop pane layout — multi-pane with resize handles */}
        <div ref={containerRef} className="hidden min-h-0 flex-1 md:flex">
          {visiblePanes.has("chat") && (
            <div className="flex min-w-0 flex-1 flex-col">
              <ChatPanel
                messages={session.messages}
                agentStatus={session.agentStatus}
                queueLength={session.queueLength}
                model={task.model}
                providerModels={providerModels}
                reasoningEffort={task.reasoningEffort}
                taskStatus={task.status}
                taskId={task.id}
                taskTitle={task.title}
                onSend={session.sendPrompt}
                onAbort={session.abort}
                onModelChange={handleModelChange}
                onReasoningEffortChange={handleReasoningEffortChange}
              />
            </div>
          )}

          {visiblePanes.has("chat") && !visiblePanes.has("diff") && visiblePanes.has("activity") && (
            <ResizeHandle onMouseDown={activityResize.onMouseDown} />
          )}

          {visiblePanes.has("diff") && (
            <div className="@container/diff flex min-w-0 flex-1 flex-col">
              <div className="flex min-h-0 flex-1 flex-col @min-[700px]/diff:flex-row">
                <div className="min-w-0 flex-1 overflow-y-auto">
                  {diffFiles.length > 0 ? (
                    <DiffView files={diffFiles} onAddComment={isTerminal ? undefined : handleAddComment} />
                  ) : (
                    <div className="flex h-full items-center justify-center text-[13px] text-fg-muted">
                      No file changes yet
                    </div>
                  )}
                </div>
                {diffFiles.length > 0 && (
                  <DiffSidebar
                    files={diffFiles}
                    comments={diffComments}
                    onScrollToFile={handleScrollToFile}
                    onRemoveComment={handleRemoveComment}
                    onSendComments={handleSendComments}
                  />
                )}
              </div>
            </div>
          )}

          {visiblePanes.has("terminal") && (visiblePanes.has("chat") || visiblePanes.has("diff")) && (
            <ResizeHandle onMouseDown={terminalResize.onMouseDown} />
          )}

          {visiblePanes.has("terminal") && (
            <div className={`flex min-w-0 flex-col${desktopIsSolo ? " flex-1" : ""}`} style={desktopIsSolo ? undefined : { width: terminalWidth, flexShrink: 0 }}>
              <TerminalPane taskId={id!} />
            </div>
          )}

          {visiblePanes.has("activity") && (visiblePanes.has("diff") || visiblePanes.has("terminal")) && (
            <ResizeHandle onMouseDown={activityResize.onMouseDown} />
          )}

          {visiblePanes.has("activity") && (
            <div
              className={`flex flex-col bg-surface-secondary${desktopIsSolo ? " flex-1" : ""}`}
              style={desktopIsSolo ? undefined : { width: activityWidth, flexShrink: 0 }}
            >
              <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-3">
                <ActivityList activities={session.activities} variant="compact" />
              </div>
            </div>
          )}
        </div>

        {/* Mobile pane layout — single pane, switched by mobilePane */}
        <div className="flex min-h-0 flex-1 md:hidden">
          {mobilePane === "chat" && (
            <div className="flex min-w-0 flex-1 flex-col">
              <ChatPanel
                messages={session.messages}
                agentStatus={session.agentStatus}
                queueLength={session.queueLength}
                model={task.model}
                providerModels={providerModels}
                reasoningEffort={task.reasoningEffort}
                taskStatus={task.status}
                taskId={task.id}
                taskTitle={task.title}
                onSend={session.sendPrompt}
                onAbort={session.abort}
                onModelChange={handleModelChange}
                onReasoningEffortChange={handleReasoningEffortChange}
              />
            </div>
          )}
          {mobilePane === "diff" && (
            <div className="@container/diff flex min-w-0 flex-1 flex-col">
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="min-w-0 flex-1 overflow-y-auto">
                  {diffFiles.length > 0 ? (
                    <DiffView files={diffFiles} onAddComment={isTerminal ? undefined : handleAddComment} />
                  ) : (
                    <div className="flex h-full items-center justify-center text-[13px] text-fg-muted">
                      No file changes yet
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
          {mobilePane === "terminal" && (
            <div className="flex min-w-0 flex-1 flex-col">
              <TerminalPane taskId={id!} />
            </div>
          )}
          {mobilePane === "activity" && (
            <div className="flex flex-1 flex-col bg-surface-secondary">
              <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-3">
                <ActivityList activities={session.activities} variant="compact" />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
