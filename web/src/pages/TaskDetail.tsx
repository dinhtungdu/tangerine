import { useState, useEffect, useCallback, useRef, useMemo } from "react"
import { useParams, Link, useOutletContext } from "react-router-dom"
import type { SidebarContext } from "../components/Layout"
import { resolveTaskTypeConfig, type Task } from "@tangerine/shared"
import { fetchTask, fetchChildTasks, changeTaskConfig, markTaskSeen, resolveTask, startTask } from "../lib/api"
import { getStatusConfig } from "../lib/status"
import { useSession } from "../hooks/useSession"
import { useProject } from "../context/ProjectContext"
import { buildSshEditorUri, EDITOR_NAMES } from "../lib/ssh-editor"
import { useProjectNav } from "../hooks/useProjectNav"
import { useDiffFiles } from "../hooks/useDiffFiles"
import { useResizable } from "../hooks/useResizable"
import { ChatPanel } from "../components/ChatPanel"
import { DiffView } from "../components/DiffView"
import { ActivityList } from "../components/ActivityList"
import { ChangesPanel as DiffSidebar, type DiffComment } from "../components/ChangesPanel"
import { ResizeHandle, PaneToggle } from "../components/PaneControls"
import { TerminalPane } from "../components/TerminalPane"
import { formatPrNumber, formatTaskTitle } from "../lib/format"
import { copyToClipboard } from "../lib/clipboard"
import { TaskOverflowMenu } from "../components/TaskListItem"
import { useTaskActions } from "../hooks/useTaskActions"
import { usePanelActions } from "../hooks/usePanelActions"
import { useToast } from "../context/ToastContext"

type PaneId = "chat" | "diff" | "terminal" | "activity"

export function TaskDetail() {
  const { id } = useParams<{ id: string }>()
  const { navigate, link } = useProjectNav()
  const outletCtx = useOutletContext<SidebarContext | null>()
  const tasks = outletCtx?.tasks ?? []
  const [task, setTask] = useState<Task | null>(null)
  const [parentTask, setParentTask] = useState<Task | null>(null)
  const [childTasks, setChildTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [visiblePanes, setVisiblePanes] = useState<Set<PaneId>>(() => {
    try {
      const saved = localStorage.getItem(`tangerine:panes:${id}`)
      if (saved) return new Set(JSON.parse(saved) as PaneId[])
    } catch { /* ignore */ }
    return new Set<PaneId>(["chat", "activity"])
  })
  const [mobilePane, setMobilePane] = useState<PaneId>("chat")

  const { current, modelsByProvider, sshHost, sshUser, editor } = useProject()
  const { showToast } = useToast()

  // When viewing a task from a different project, show that project's orchestrator chat
  const isCrossProject = task !== null && current !== null && task.projectId !== current.name
  const TERMINATED = useMemo(() => new Set(["done", "completed", "cancelled"]), [])
  const orchestratorTask = useMemo(() => {
    if (!isCrossProject) return null
    const orchTasks = tasks.filter((t) => t.type === "orchestrator")
    return orchTasks.find((t) => !TERMINATED.has(t.status)) ?? null
  }, [isCrossProject, tasks, TERMINATED])

  const chatTaskId = (isCrossProject && orchestratorTask) ? orchestratorTask.id : (id ?? "")
  const session = useSession(chatTaskId)
  const { files: diffFiles } = useDiffFiles(id ?? "")
  const diffCommentsKey = `diff-comments:${id}`
  const [diffComments, setDiffComments] = useState<DiffComment[]>(() => {
    try {
      const s = localStorage.getItem(`diff-comments:${id}`)
      if (s) return JSON.parse(s) as DiffComment[]
    } catch { /* ignore */ }
    return []
  })
  const setDiffCommentsAndPersist = useCallback((updater: DiffComment[] | ((prev: DiffComment[]) => DiffComment[])) => {
    setDiffComments((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater
      try { localStorage.setItem(diffCommentsKey, JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
  }, [diffCommentsKey])
  const [showAllChildren, setShowAllChildren] = useState(false)
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
  const dimsRef = useRef<{ terminal: number; activity: number; diff: number }>((() => {
    try {
      const s = localStorage.getItem(dimsKey)
      if (s) return JSON.parse(s)
    } catch { /* ignore */ }
    return { terminal: 480, activity: 250, diff: 600 }
  })())
  const saveDims = useCallback(() => {
    try { localStorage.setItem(dimsKey, JSON.stringify(dimsRef.current)) } catch { /* ignore */ }
  }, [dimsKey])

  const [terminalWidth, setTerminalWidth] = useState(dimsRef.current.terminal)
  const [activityWidth, setActivityWidth] = useState(dimsRef.current.activity)
  const [diffWidth, setDiffWidth] = useState(dimsRef.current.diff)
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

  const diffResize = useResizable({
    onResize: useCallback((delta: number) => {
      setDiffWidth((w) => {
        const next = Math.max(MIN_PANE, w - delta)
        dimsRef.current.diff = next
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
    setDiffCommentsAndPersist((prev) => [...prev, comment])
  }, [])

  const handleRemoveComment = useCallback((commentId: string) => {
    setDiffCommentsAndPersist((prev) => prev.filter((c) => c.id !== commentId))
  }, [])

  const handleScrollToFile = useCallback((path: string) => {
    const el = document.getElementById(`diff-file-${path}`)
    el?.scrollIntoView({ behavior: "smooth", block: "start" })
  }, [])

  // The task whose chat is shown — orchestrator when cross-project, otherwise the viewed task
  const chatTask = (isCrossProject && orchestratorTask) ? orchestratorTask : task
  const providerModels = chatTask ? (modelsByProvider[chatTask.provider] ?? []) : []

  const handleModelChange = useCallback(async (model: string) => {
    const targetId = chatTask?.id
    if (!targetId) return
    try {
      await changeTaskConfig(targetId, { model })
      if (!isCrossProject) {
        setTask((prev) => prev ? { ...prev, model } : prev)
      }
    } catch {
      showToast("Failed to change model")
    }
  }, [chatTask?.id, isCrossProject, showToast])

  const handleReasoningEffortChange = useCallback(async (reasoningEffort: string) => {
    const targetId = chatTask?.id
    if (!targetId) return
    try {
      await changeTaskConfig(targetId, { reasoningEffort })
      if (!isCrossProject) {
        setTask((prev) => prev ? { ...prev, reasoningEffort } : prev)
      }
    } catch {
      showToast("Failed to change reasoning effort")
    }
  }, [chatTask?.id, isCrossProject, showToast])

  const canResolve = chatTask?.capabilities.includes("resolve") ?? false
  const hasPredefinedPrompts = chatTask?.capabilities.includes("predefined-prompts") ?? false
  const hasDiff = task?.capabilities.includes("diff") ?? false
  const canContinue = chatTask?.capabilities.includes("continue") ?? false

  const resolvedPrompts = useMemo(() => {
    if (!hasPredefinedPrompts || !chatTask || !current) return undefined
    const tt = chatTask.type as "worker" | "orchestrator" | "reviewer"
    return resolveTaskTypeConfig(current, tt).predefinedPrompts
  }, [hasPredefinedPrompts, chatTask, current])

  const handleResolve = useCallback(async () => {
    if (!chatTask) return
    try {
      await resolveTask(chatTask.id)
      if (!isCrossProject) {
        const updated = await fetchTask(chatTask.id)
        setTask(updated)
      }
    } catch {
      showToast("Failed to resolve task")
    }
  }, [chatTask, isCrossProject, showToast])

  const sendPromptRef = useRef(session.sendPrompt)
  sendPromptRef.current = session.sendPrompt

  const handleSendComments = useCallback((comments: DiffComment[]) => {
    const text = comments
      .map((c) => {
        const sideLabel = c.side === "left" ? "before change" : "after change"
        return `[${c.filePath}:${c.lineRef} (${sideLabel})] ${c.text}`
      })
      .join("\n\n")
    sendPromptRef.current(text)
    try { localStorage.removeItem(diffCommentsKey) } catch { /* ignore */ }
    setDiffComments([])
    setMobilePane("chat")
  }, [])

  const handleRefetch = useCallback(async () => {
    if (!id) return
    try {
      const data = await fetchTask(id)
      setTask(data)
    } catch {
      // Task was deleted — navigate back to the runs list
      navigate("/")
    }
  }, [id, navigate])

  // Register task-contextual actions in the command palette
  useTaskActions(task, handleRefetch)
  // Register panel toggle actions colocated with the pane state they control
  usePanelActions(task, togglePane)

  // Start the task on first prompt if it's still in "created" status
  const handleSend = useCallback(
    async (text: string, images?: import("@tangerine/shared").PromptImage[]) => {
      if (chatTask?.status === "created") {
        await startTask(chatTask.id)
        // Only optimistically update the viewed task's status when it IS the chat task
        if (!isCrossProject) {
          setTask((prev) => prev ? { ...prev, status: "provisioning" } : prev)
        }
      }
      sendPromptRef.current(text, images)
    },
    [chatTask?.status, chatTask?.id, isCrossProject],
  )

  // Fetch parent and children once per task ID (not on every poll)
  useEffect(() => {
    if (!id) return
    let cancelled = false
    async function loadRelated() {
      try {
        const [data, children] = await Promise.all([
          fetchTask(id!),
          fetchChildTasks(id!),
        ])
        if (cancelled) return
        setChildTasks(children)
        if (data.parentTaskId) {
          fetchTask(data.parentTaskId).then((p) => { if (!cancelled) setParentTask(p) }).catch(() => {})
        } else {
          setParentTask(null)
        }
      } catch { /* ignore */ }
    }
    loadRelated()
    return () => { cancelled = true }
  }, [id])

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

  // Mark task as seen on view, whenever it updates while viewing, and on leave
  useEffect(() => {
    if (id) markTaskSeen(id).catch(() => {})
    return () => {
      if (id) markTaskSeen(id).catch(() => {})
    }
  }, [id, task?.updatedAt])

  // Sanitize pane state: if the loaded task lacks "diff" capability, remove any stale
  // "diff" entry from visiblePanes/mobilePane so the layout doesn't render blank.
  useEffect(() => {
    if (!task) return
    if (!task.capabilities.includes("diff")) {
      setVisiblePanes((prev) => {
        if (!prev.has("diff")) return prev
        const next = new Set(prev)
        next.delete("diff")
        if (next.size === 0) next.add("chat")
        return next
      })
      setMobilePane((prev) => prev === "diff" ? "chat" : prev)
    }
  }, [task?.id, task?.capabilities])

  useEffect(() => {
    if (!session.taskStatus || isCrossProject) return
    const terminal = ["done", "failed", "cancelled"]
    if (terminal.includes(session.taskStatus)) {
      // Refetch the full task to capture error and other fields set on completion
      fetchTask(id!).then(setTask).catch(() => {})
    } else {
      setTask((prev) => (prev ? { ...prev, status: session.taskStatus! } : prev))
    }
  }, [session.taskStatus, id, isCrossProject])

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-md text-fg-muted">
        Loading...
      </div>
    )
  }

  if (!task) {
    return (
      <div className="flex h-full items-center justify-center text-md text-fg-muted">
        Task not found
      </div>
    )
  }

  const { color: statusColor, label: statusLabel } = getStatusConfig(task.status)
  const isTerminated = task.status === "done" || task.status === "failed" || task.status === "cancelled"

  // Desktop: multi-pane from visiblePanes set. Mobile: single pane from mobilePane.
  // Both states are tracked; CSS breakpoints control which layout renders.
  const desktopIsSolo = visiblePanes.size === 1
  const PANE_ORDER: PaneId[] = ["chat", "diff", "terminal", "activity"]
  const orderedVisible = PANE_ORDER.filter((p) => visiblePanes.has(p) && (p !== "diff" || hasDiff))
  const firstVisiblePane = orderedVisible[0]
  const resizeHandlers: Partial<Record<PaneId, (e: React.PointerEvent<HTMLDivElement>) => void>> = {
    diff: diffResize.onPointerDown,
    terminal: terminalResize.onPointerDown,
    activity: activityResize.onPointerDown,
  }

  return (
    <div className="flex h-full">
      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Task header — two rows on mobile (flex-col), one row on desktop (md:flex-row) */}
        <div className="flex flex-col border-b border-edge md:h-12 md:flex-row md:items-center md:px-5">
          {/* Row 1 / Left: back + task name + branch */}
          <div className="flex h-11 min-w-0 items-center gap-2 px-3 md:h-auto md:flex-1 md:gap-3 md:px-0">
            <button onClick={() => navigate("/")} aria-label="Back to runs" className="shrink-0 text-fg md:hidden">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18" />
              </svg>
            </button>
            <button
              onClick={handleCopyId}
              title="Click to copy task ID"
              className="min-w-0 truncate text-sm font-semibold text-fg hover:text-fg-muted"
            >
              {copiedId ? "Copied ID!" : formatTaskTitle(task)}
            </button>
            {task.branch && (
              <button
                onClick={() => handleCopyBranch(task.branch!)}
                title="Click to copy branch name"
                className="flex shrink-0 items-center gap-1 hover:text-fg"
              >
                <svg className="h-3.5 w-3.5 text-fg-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 3v12m0 0a3 3 0 1 0 3 3m-3-3a3 3 0 0 1 3 3m0 0h6a3 3 0 0 0 3-3V9m0 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
                </svg>
                <span className="max-w-[120px] truncate font-mono text-xs text-fg-muted">{copiedBranch ? "Copied!" : task.branch}</span>
              </button>
            )}
          </div>

          {/* Row 2 / Right: editor + PR + status + pane toggles + overflow */}
          <div className="flex h-9 shrink-0 items-center gap-2 px-3 pb-1 md:h-auto md:px-0 md:pb-0">
            {sshHost && editor && task.worktreePath && (editor !== "zed" || sshUser) && (() => {
              const uri = buildSshEditorUri(editor, sshHost, task.worktreePath, sshUser)
              return (
                <a
                  href={uri}
                  title={`Open in ${EDITOR_NAMES[editor]}`}
                  className="flex shrink-0 items-center gap-1 text-fg-muted hover:text-fg"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5" />
                  </svg>
                  <span className="text-xs">{EDITOR_NAMES[editor]}</span>
                </a>
              )
            })()}
            {task.prUrl && (
              <a
                href={task.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex shrink-0 items-center gap-1 rounded bg-status-success-bg px-1.5 py-0.5 text-2xs font-medium text-status-success-text"
              >
                {formatPrNumber(task.prUrl)}
              </a>
            )}
            <span
              className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-2xs font-medium"
              style={{ backgroundColor: `color-mix(in srgb, ${statusColor} 10%, transparent)`, color: statusColor }}
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: statusColor }} />
              {statusLabel}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <div className="flex items-center gap-0.5 rounded-lg bg-surface-secondary p-[3px]">
                <PaneToggle desktopActive={visiblePanes.has("chat")} mobileActive={mobilePane === "chat"} onClick={() => togglePane("chat")} label="Chat">
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                </PaneToggle>
                {hasDiff && (
                  <PaneToggle desktopActive={visiblePanes.has("diff")} mobileActive={mobilePane === "diff"} onClick={() => togglePane("diff")} label="Diff">
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" />
                      <path d="M13 6h3a2 2 0 0 1 2 2v7M11 18H8a2 2 0 0 1-2-2V9" />
                    </svg>
                  </PaneToggle>
                )}
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
              <TaskOverflowMenu task={task} onRefetch={handleRefetch} size="md" />
            </div>
          </div>
        </div>

        {/* Parent / children relationship bar */}
        {(parentTask || childTasks.length > 0) && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-edge px-3 py-1.5 text-xs text-fg-muted md:px-5">
            {parentTask && (
              <Link
                to={link(`/tasks/${parentTask.id}`)}
                className="flex items-center gap-1 hover:text-fg"
              >
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244" />
                </svg>
                <span>Continued from:</span>
                <span className="font-medium text-fg">{parentTask.title}</span>
              </Link>
            )}
            {childTasks.length > 0 && (
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <span>Related:</span>
                {(showAllChildren ? childTasks : childTasks.slice(0, 3)).map((child) => (
                  <Link
                    key={child.id}
                    to={link(`/tasks/${child.id}`)}
                    className="max-w-[200px] truncate rounded bg-surface-secondary px-1.5 py-0.5 text-xxs font-medium text-fg hover:bg-edge"
                    title={child.title}
                  >
                    Continued in: {child.title}
                  </Link>
                ))}
                {childTasks.length > 3 && (
                  <button
                    onClick={() => setShowAllChildren((v) => !v)}
                    className="rounded bg-surface-secondary px-1.5 py-0.5 text-xxs font-medium text-fg-muted hover:bg-edge hover:text-fg"
                  >
                    {showAllChildren ? "Show less" : `+${childTasks.length - 3} more`}
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Pane layout — single flex container, responsive direction.
             Mobile (flex-col): one pane at a time via mobilePane.
             Desktop (md:flex-row): multi-pane with resize handles via visiblePanes.
             ChatPanel is rendered ONCE to avoid duplicate ChatInput draft saves. */}
        <div ref={containerRef} className="flex min-h-0 flex-1 flex-col md:flex-row">
          {/* Chat pane — single instance for both breakpoints.
               Unmount when hidden at both breakpoints to avoid focusing an invisible input. */}
          {chatTask && (mobilePane === "chat" || visiblePanes.has("chat")) && (
            <div className={[
              "flex min-h-0 min-w-0 flex-col",
              mobilePane === "chat" ? "flex-1" : "hidden",
              visiblePanes.has("chat") ? "md:flex md:flex-1" : "md:hidden",
            ].join(" ")}>
              <ChatPanel
                messages={session.messages}
                tasks={tasks}
                agentStatus={session.agentStatus}
                queueLength={session.queueLength}
                model={chatTask.model}
                provider={chatTask.provider}
                providerModels={providerModels}
                reasoningEffort={chatTask.reasoningEffort}
                taskStatus={chatTask.status}
                taskError={chatTask.error}
                taskId={chatTaskId}
                taskTitle={chatTask.title}
                onSend={handleSend}
                onAbort={session.abort}
                onModelChange={handleModelChange}
                onReasoningEffortChange={handleReasoningEffortChange}
                predefinedPrompts={resolvedPrompts}
                onResolve={canResolve ? handleResolve : undefined}
                canContinue={canContinue}
                taskBranch={chatTask.status === "cancelled" ? (chatTask.branch ?? undefined) : undefined}
                autoFocusKey={chatTaskId}
              />
            </div>
          )}

          {/* Diff pane */}
          {orderedVisible.indexOf("diff") > 0 && (
            <ResizeHandle className="hidden md:flex" onPointerDown={resizeHandlers.diff!} />
          )}
          {hasDiff && (mobilePane === "diff" || visiblePanes.has("diff")) && (
            <div
              className={[
                "@container/diff flex min-h-0 min-w-0 flex-col",
                mobilePane === "diff" ? "flex-1" : "hidden",
                visiblePanes.has("diff")
                  ? `md:flex${desktopIsSolo || firstVisiblePane === "diff" ? " md:flex-1" : " md:[width:var(--pane-w)] md:[flex-shrink:0] md:max-w-full"}`
                  : "md:hidden",
              ].join(" ")}
              style={visiblePanes.has("diff") && !desktopIsSolo && firstVisiblePane !== "diff" ? { "--pane-w": `${diffWidth}px` } as React.CSSProperties : undefined}
            >
              <div className="flex min-h-0 flex-1 flex-col @min-[700px]/diff:flex-row">
                <div className="min-w-0 flex-1 overflow-y-auto">
                  {diffFiles.length > 0 ? (
                    <DiffView files={diffFiles} comments={diffComments} onAddComment={isTerminated ? undefined : handleAddComment} />
                  ) : (
                    <div className="flex h-full items-center justify-center text-md text-fg-muted">
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

          {/* Terminal pane */}
          {orderedVisible.indexOf("terminal") > 0 && (
            <ResizeHandle className="hidden md:flex" onPointerDown={resizeHandlers.terminal!} />
          )}
          {(mobilePane === "terminal" || visiblePanes.has("terminal")) && (
            <div
              className={[
                "flex min-h-0 min-w-0 flex-col",
                mobilePane === "terminal" ? "flex-1" : "hidden",
                visiblePanes.has("terminal")
                  ? `md:flex${desktopIsSolo || firstVisiblePane === "terminal" ? " md:flex-1" : " md:[width:var(--pane-w)] md:[flex-shrink:0] md:max-w-full"}`
                  : "md:hidden",
              ].join(" ")}
              style={visiblePanes.has("terminal") && !desktopIsSolo && firstVisiblePane !== "terminal" ? { "--pane-w": `${terminalWidth}px` } as React.CSSProperties : undefined}
            >
              <TerminalPane taskId={id!} />
            </div>
          )}

          {/* Activity pane */}
          {orderedVisible.indexOf("activity") > 0 && (
            <ResizeHandle className="hidden md:flex" onPointerDown={resizeHandlers.activity!} />
          )}
          {(mobilePane === "activity" || visiblePanes.has("activity")) && (
            <div
              className={[
                "flex min-h-0 min-w-0 flex-col bg-surface-secondary",
                mobilePane === "activity" ? "flex-1" : "hidden",
                visiblePanes.has("activity")
                  ? `md:flex${desktopIsSolo || firstVisiblePane === "activity" ? " md:flex-1" : " md:[width:var(--pane-w)] md:[flex-shrink:0] md:max-w-full"}`
                  : "md:hidden",
              ].join(" ")}
              style={visiblePanes.has("activity") && !desktopIsSolo && firstVisiblePane !== "activity" ? { "--pane-w": `${activityWidth}px` } as React.CSSProperties : undefined}
            >
              <div className="min-h-0 flex-1 overflow-y-auto pt-3">
                <ActivityList activities={session.activities} variant="compact" />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
