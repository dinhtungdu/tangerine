import { useState, useEffect, useCallback, useRef, useMemo } from "react"
import { useParams, Link, useOutletContext } from "react-router-dom"
import type { SidebarContext } from "../components/Layout"
import { resolveTaskTypeConfig, type Task } from "@tangerine/shared"
import { fetchTask, fetchChildTasks, changeTaskConfig, markTaskSeen, resolveTask, startTask } from "../lib/api"
import { getTaskDisplayStatus, getPrStatusConfig } from "../lib/status"
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
import { TaskChatSurface, TaskViewModeToggle, shouldSyncAgentTuiOnChatReturn, shouldTrackAgentTuiForTask, type TaskViewMode } from "../components/TaskViewMode"
import { formatPrNumber, formatTaskTitle } from "../lib/format"
import {
  getResponsiveVisiblePanes,
  removePaneCapability,
  selectMobilePane,
  toggleDesktopPaneState,
  toggleMobilePaneActionState,
  type PaneId,
  type ResponsivePaneState,
} from "../lib/panes"
import { copyToClipboard } from "../lib/clipboard"
import { TaskOverflowMenu } from "../components/TaskListItem"
import { useTaskActions } from "../hooks/useTaskActions"
import { usePanelActions } from "../hooks/usePanelActions"
import { useToast } from "../context/ToastContext"

function loadPaneState(taskId: string | undefined): ResponsivePaneState {
  try {
    const saved = localStorage.getItem(`tangerine:panes:${taskId}`)
    if (saved) {
      const parsed = new Set(JSON.parse(saved) as PaneId[])
      if (parsed.size === 0) parsed.add("chat")
      return {
        visiblePanes: parsed,
        mobilePane: "chat",
        desktopSyncPane: null,
      }
    }
  } catch { /* ignore */ }

  return {
    visiblePanes: new Set<PaneId>(["chat", "activity"]),
    mobilePane: "chat",
    desktopSyncPane: null,
  }
}

export function TaskDetail() {
  const { id } = useParams<{ id: string }>()
  const { navigate, link } = useProjectNav()
  const outletCtx = useOutletContext<SidebarContext | null>()
  const tasks = outletCtx?.tasks ?? []
  const [task, setTask] = useState<Task | null>(null)
  const [parentTask, setParentTask] = useState<Task | null>(null)
  const [childTasks, setChildTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [paneState, setPaneState] = useState<ResponsivePaneState>(() => loadPaneState(id))
  const [taskViewMode, setTaskViewMode] = useState<TaskViewMode>("chat")
  const { visiblePanes, mobilePane, desktopSyncPane } = paneState

  const { current, sshHost, sshUser, editor } = useProject()
  const { showToast } = useToast()

  const chatTaskId = id ?? ""
  const session = useSession(chatTaskId, task?.contextTokens, task?.contextWindowMax)
  const { files: diffFiles } = useDiffFiles(id ?? "")
  const diffCommentsKey = `diff-comments:${id}`
  const [diffComments, setDiffComments] = useState<DiffComment[]>([])
  // Reload persisted comments whenever the task ID changes (component may stay mounted across navigations)
  useEffect(() => {
    try {
      const s = localStorage.getItem(`diff-comments:${id}`)
      setDiffComments(s ? (JSON.parse(s) as DiffComment[]) : [])
    } catch { setDiffComments([]) }
  }, [id])
  const setDiffCommentsAndPersist = useCallback((updater: DiffComment[] | ((prev: DiffComment[]) => DiffComment[])) => {
    setDiffComments((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater
      try { localStorage.setItem(diffCommentsKey, JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
  }, [diffCommentsKey])
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

  // Track which pane the current drag handle belongs to, and the ordered
  // visible panes so the resize callback can adjust both adjacent panes.
  const dragPaneRef = useRef<PaneId | null>(null)
  const orderedVisibleRef = useRef<PaneId[]>([])
  const desktopPaneProbeRef = useRef<HTMLButtonElement>(null)
  const mobilePaneProbeRef = useRef<HTMLButtonElement>(null)

  const widthSetters: Record<string, (v: number) => void> = useMemo(() => ({
    diff: (v: number) => { dimsRef.current.diff = v; setDiffWidth(v) },
    terminal: (v: number) => { dimsRef.current.terminal = v; setTerminalWidth(v) },
    activity: (v: number) => { dimsRef.current.activity = v; setActivityWidth(v) },
  }), [])

  const resize = useResizable({
    onResize: useCallback((delta: number) => {
      const pane = dragPaneRef.current
      if (!pane || pane === "chat") return

      const ordered = orderedVisibleRef.current
      const idx = ordered.indexOf(pane)
      if (idx <= 0) return

      const leftPane = ordered[idx - 1]
      const leftIsFlexible = idx === 1 // ordered[0] is always the flex-1 pane
      const paneKey = pane as "diff" | "terminal" | "activity"
      const rightW = dimsRef.current[paneKey]

      const rightSetter = widthSetters[paneKey]
      if (!rightSetter) return

      if (leftIsFlexible || leftPane === "chat") {
        // Left pane is flex-1 — only adjust the right pane
        rightSetter(Math.max(MIN_PANE, rightW - delta))
      } else {
        // Both panes are fixed — adjust both so their shared boundary moves
        const leftKey = leftPane as "diff" | "terminal" | "activity"
        const leftSetter = widthSetters[leftKey]
        if (!leftSetter) return
        const leftW = dimsRef.current[leftKey]
        const effective = Math.max(-(leftW - MIN_PANE), Math.min(delta, rightW - MIN_PANE))
        leftSetter(leftW + effective)
        rightSetter(rightW - effective)
      }
      saveDims()
    }, [saveDims, widthSetters]),
  })

  const persistVisiblePanes = useCallback((next: ReadonlySet<PaneId>) => {
    try { localStorage.setItem(`tangerine:panes:${id}`, JSON.stringify([...next])) } catch { /* ignore */ }
  }, [id])

  // Keep mobile pane switches separate from desktop toggles so hidden mobile
  // panes unmount instead of staying connected off-screen.
  const showMobilePane = useCallback((pane: PaneId) => {
    setPaneState((prev) => selectMobilePane(prev, pane))
  }, [])

  const toggleDesktopPane = useCallback((pane: PaneId) => {
    setPaneState((prev) => {
      const next = toggleDesktopPaneState(prev, pane)
      persistVisiblePanes(next.visiblePanes)
      return next
    })
  }, [persistVisiblePanes])

  const togglePaneFromAction = useCallback((pane: PaneId) => {
    const isDesktopLayout = desktopPaneProbeRef.current != null && desktopPaneProbeRef.current.offsetParent !== null
    const isMobileLayout = mobilePaneProbeRef.current != null && mobilePaneProbeRef.current.offsetParent !== null
    if (isDesktopLayout || !isMobileLayout) {
      setPaneState((prev) => {
        const next = toggleDesktopPaneState(prev, pane)
        persistVisiblePanes(next.visiblePanes)
        return next
      })
      return
    }

    setPaneState((prev) => {
      const next = toggleMobilePaneActionState(prev, pane)
      persistVisiblePanes(next.visiblePanes)
      return next
    })
  }, [persistVisiblePanes])

  const handleAddComment = useCallback((comment: DiffComment) => {
    setDiffCommentsAndPersist((prev) => [...prev, comment])
  }, [setDiffCommentsAndPersist])

  const handleRemoveComment = useCallback((commentId: string) => {
    setDiffCommentsAndPersist((prev) => prev.filter((c) => c.id !== commentId))
  }, [setDiffCommentsAndPersist])

  const handleUpdateComment = useCallback((commentId: string, text: string) => {
    setDiffCommentsAndPersist((prev) => prev.map((c) => c.id === commentId ? { ...c, text } : c))
  }, [setDiffCommentsAndPersist])

  const handleScrollToFile = useCallback((path: string) => {
    const el = document.getElementById(`diff-file-${path}`)
    el?.scrollIntoView({ behavior: "smooth", block: "start" })
  }, [])

  const chatTask = task

  const handleModelChange = useCallback(async (model: string) => {
    const targetId = chatTask?.id
    if (!targetId) return
    try {
      await changeTaskConfig(targetId, { model })
      setTask((prev) => prev ? { ...prev, model } : prev)
    } catch {
      showToast("Failed to change model")
    }
  }, [chatTask?.id, showToast])

  const handleReasoningEffortChange = useCallback(async (reasoningEffort: string) => {
    const targetId = chatTask?.id
    if (!targetId) return
    try {
      await changeTaskConfig(targetId, { reasoningEffort })
      setTask((prev) => prev ? { ...prev, reasoningEffort } : prev)
    } catch {
      showToast("Failed to change reasoning effort")
    }
  }, [chatTask?.id, showToast])

  const handleModeChange = useCallback(async (mode: string) => {
    const targetId = chatTask?.id
    if (!targetId) return
    try {
      await changeTaskConfig(targetId, { mode })
    } catch {
      showToast("Failed to change mode")
    }
  }, [chatTask?.id, showToast])

  const canResolve = chatTask?.capabilities.includes("resolve") ?? false
  const hasPredefinedPrompts = chatTask?.capabilities.includes("predefined-prompts") ?? false
  const hasDiff = task?.capabilities.includes("diff") ?? false
  const canContinue = chatTask?.capabilities.includes("continue") ?? false

  const resolvedPrompts = useMemo(() => {
    if (!hasPredefinedPrompts || !chatTask || !current) return undefined
    return resolveTaskTypeConfig(current, chatTask.type).predefinedPrompts
  }, [hasPredefinedPrompts, chatTask, current])

  const handleResolve = useCallback(async () => {
    if (!chatTask) return
    try {
      await resolveTask(chatTask.id)
      const updated = await fetchTask(chatTask.id)
      setTask(updated)
    } catch {
      showToast("Failed to resolve task")
    }
  }, [chatTask, showToast])

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

    const isDesktopLayout = desktopPaneProbeRef.current != null && desktopPaneProbeRef.current.offsetParent !== null
    const isMobileLayout = mobilePaneProbeRef.current != null && mobilePaneProbeRef.current.offsetParent !== null
    setPaneState((prev) => ({
      ...prev,
      mobilePane: "chat",
      desktopSyncPane: isDesktopLayout || !isMobileLayout
        ? prev.desktopSyncPane
        : prev.desktopSyncPane ? "chat" : prev.desktopSyncPane,
    }))
  }, [diffCommentsKey])

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
  usePanelActions(task, togglePaneFromAction)

  // Start the task on first prompt if it's still in "created" status
  const handleSend = useCallback(
    async (text: string, images?: import("@tangerine/shared").PromptImage[]) => {
      if (chatTask?.status === "created") {
        await startTask(chatTask.id)
        setTask((prev) => prev ? { ...prev, status: "provisioning" } : prev)
      }
      sendPromptRef.current(text, images)
    },
    [chatTask?.status, chatTask?.id],
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
          const p = await fetchTask(data.parentTaskId)
          if (!cancelled) setParentTask(p)
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

  useEffect(() => {
    setPaneState(loadPaneState(id))
    setTaskViewMode("chat")
  }, [id])

  useEffect(() => {
    if (!chatTask?.agentSessionId && taskViewMode !== "chat") {
      setTaskViewMode("chat")
    }
  }, [chatTask?.agentSessionId, taskViewMode])

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
      setPaneState((prev) => removePaneCapability(prev, "diff"))
    }
  }, [task?.id, task?.capabilities])

  useEffect(() => {
    if (!session.taskStatus) return
    const terminal = ["done", "failed", "cancelled"]
    if (terminal.includes(session.taskStatus)) {
      // Refetch the full task to capture error and other fields set on completion
      fetchTask(id!).then(setTask).catch(() => {})
    } else {
      setTask((prev) => (prev ? { ...prev, status: session.taskStatus! } : prev))
    }
  }, [session.taskStatus, id])

  // Desktop shows the persisted pane set plus any temporarily synced pane
  // (desktopSyncPane), so rotating from mobile does not drop the pane the user was viewing.
  const responsiveVisiblePanes = useMemo(
    () => getResponsiveVisiblePanes(visiblePanes, desktopSyncPane),
    [desktopSyncPane, visiblePanes],
  )
  const agentTuiActiveRef = useRef(false)
  const agentTuiTaskIdRef = useRef<string | null>(null)
  const canSyncAgentTui = shouldSyncAgentTuiOnChatReturn(
    chatTask?.status,
    chatTask?.suspended,
    agentTuiActiveRef.current,
    agentTuiTaskIdRef.current,
    id ?? null,
    chatTask?.agentSessionId ?? null,
  )

  useEffect(() => {
    agentTuiActiveRef.current = false
    agentTuiTaskIdRef.current = null
  }, [id])

  useEffect(() => {
    if (taskViewMode === "chat" && canSyncAgentTui) {
      session.syncFromAgent().catch(() => {})
    }
    const isCurrentTaskTui = shouldTrackAgentTuiForTask(taskViewMode, chatTask?.id, id)
    agentTuiActiveRef.current = isCurrentTaskTui
    agentTuiTaskIdRef.current = isCurrentTaskTui ? id ?? null : null
  }, [taskViewMode, id, chatTask?.id, canSyncAgentTui, session.syncFromAgent])

  const PANE_ORDER: PaneId[] = ["chat", "diff", "terminal", "activity"]
  const orderedVisible = PANE_ORDER.filter((p) => responsiveVisiblePanes.has(p) && (p !== "diff" || hasDiff))
  const desktopIsSolo = orderedVisible.length === 1
  const firstVisiblePane = orderedVisible[0]
  orderedVisibleRef.current = orderedVisible

  const resizeHandlers: Record<string, (e: React.PointerEvent<HTMLDivElement>) => void> = {
    diff: (e) => { dragPaneRef.current = "diff"; resize.onPointerDown(e) },
    terminal: (e) => { dragPaneRef.current = "terminal"; resize.onPointerDown(e) },
    activity: (e) => { dragPaneRef.current = "activity"; resize.onPointerDown(e) },
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading...
      </div>
    )
  }

  if (!task) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Task not found
      </div>
    )
  }

  const { color: statusColor, label: statusLabel } = getTaskDisplayStatus(task)
  const isTerminated = task.status === "done" || task.status === "failed" || task.status === "cancelled"

  return (
    <div className="flex h-full">
      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Task header — two rows on mobile (flex-col), one row on desktop (md:flex-row) */}
        <div className="flex flex-col border-b border-border md:h-12 md:flex-row md:items-center md:px-5">
          {/* Row 1 / Left: back + task name + branch */}
          <div className="flex h-11 min-w-0 items-center gap-2 px-3 md:h-auto md:flex-1 md:gap-3 md:px-0">
            <button onClick={() => navigate("/")} aria-label="Back to runs" className="shrink-0 rounded text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring/50 md:hidden">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18" />
              </svg>
            </button>
            <button
              onClick={handleCopyId}
              title="Click to copy task ID"
              className="min-w-0 truncate rounded text-sm font-semibold text-foreground outline-none hover:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring/50"
            >
              {copiedId ? "Copied ID!" : formatTaskTitle(task)}
            </button>
            {task.branch && (
              <button
                onClick={() => handleCopyBranch(task.branch!)}
                title="Click to copy branch name"
                className="flex shrink-0 items-center gap-1 rounded outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/50"
              >
                <svg className="h-3.5 w-3.5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 3v12m0 0a3 3 0 1 0 3 3m-3-3a3 3 0 0 1 3 3m0 0h6a3 3 0 0 0 3-3V9m0 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
                </svg>
                <span className="max-w-[120px] truncate font-mono text-xs text-muted-foreground">{copiedBranch ? "Copied!" : task.branch}</span>
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
                  className="flex shrink-0 items-center gap-1 text-muted-foreground hover:text-foreground"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5" />
                  </svg>
                  <span className="text-xs">{EDITOR_NAMES[editor]}</span>
                </a>
              )
            })()}
            {task.prUrl && (() => {
              const prStatusConfig = getPrStatusConfig(task.prStatus)
              return (
                <a
                  href={task.prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-2xs font-medium ${prStatusConfig.bgClass} ${prStatusConfig.textClass}`}
                >
                  {formatPrNumber(task.prUrl)}
                </a>
              )
            })()}
            <span
              className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-2xs font-medium"
              style={{ backgroundColor: `color-mix(in srgb, ${statusColor} 10%, transparent)`, color: statusColor }}
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: statusColor }} />
              {statusLabel}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <TaskViewModeToggle
                value={taskViewMode}
                agentSessionId={task.agentSessionId}
                onChange={setTaskViewMode}
              />
              <div className="flex items-center gap-0.5 rounded-lg bg-muted p-[3px]">
                <PaneToggle
                  desktopActive={responsiveVisiblePanes.has("chat")}
                  mobileActive={mobilePane === "chat"}
                  onDesktopClick={() => toggleDesktopPane("chat")}
                  onMobileClick={() => showMobilePane("chat")}
                  desktopButtonRef={desktopPaneProbeRef}
                  mobileButtonRef={mobilePaneProbeRef}
                  label="Chat"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                </PaneToggle>
                {hasDiff && (
                  <PaneToggle
                    desktopActive={responsiveVisiblePanes.has("diff")}
                    mobileActive={mobilePane === "diff"}
                    onDesktopClick={() => toggleDesktopPane("diff")}
                    onMobileClick={() => showMobilePane("diff")}
                    label="Diff"
                  >
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" />
                      <path d="M13 6h3a2 2 0 0 1 2 2v7M11 18H8a2 2 0 0 1-2-2V9" />
                    </svg>
                  </PaneToggle>
                )}
                <PaneToggle
                  desktopActive={responsiveVisiblePanes.has("terminal")}
                  mobileActive={mobilePane === "terminal"}
                  onDesktopClick={() => toggleDesktopPane("terminal")}
                  onMobileClick={() => showMobilePane("terminal")}
                  label="Terminal"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="m6.75 7.5 3 2.25-3 2.25m4.5 0h3" />
                    <rect x="2" y="3" width="20" height="18" rx="2" />
                  </svg>
                </PaneToggle>
                <PaneToggle
                  desktopActive={responsiveVisiblePanes.has("activity")}
                  mobileActive={mobilePane === "activity"}
                  onDesktopClick={() => toggleDesktopPane("activity")}
                  onMobileClick={() => showMobilePane("activity")}
                  label="Activity"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
                  </svg>
                </PaneToggle>
              </div>
              <div className="h-5 w-px bg-border" />
              <TaskOverflowMenu task={task} onRefetch={handleRefetch} size="md" />
            </div>
          </div>
        </div>

        {/* Parent / children relationship bar */}
        {(parentTask || childTasks.length > 0) && (
          <div className="flex items-center gap-x-3 overflow-x-auto scrollbar-none border-b border-border px-3 py-1.5 text-xs text-muted-foreground md:px-5">
            {parentTask && (
              <Link
                to={link(`/tasks/${parentTask.id}`)}
                className="flex shrink-0 items-center gap-1 rounded outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/50"
              >
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244" />
                </svg>
                <span>Continued from:</span>
                <span className="font-medium text-foreground">{parentTask.title}</span>
              </Link>
            )}
            {parentTask && childTasks.length > 0 && (
              <span className="shrink-0 text-border">|</span>
            )}
            {childTasks.length > 0 && (
              <div className="flex min-w-0 flex-nowrap items-center gap-1.5">
                <span className="shrink-0">Related:</span>
                {[...childTasks].reverse().map((child) => (
                  <Link
                    key={child.id}
                    to={link(`/tasks/${child.id}`)}
                    className="shrink-0 max-w-[200px] truncate rounded bg-muted px-1.5 py-0.5 text-xxs font-medium text-foreground outline-none hover:bg-border focus-visible:ring-1 focus-visible:ring-ring/50"
                    title={child.title}
                  >
                    Continued in: {child.title}
                  </Link>
                ))}
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
          {chatTask && (mobilePane === "chat" || responsiveVisiblePanes.has("chat")) && (
            <div className={[
              "flex min-h-0 min-w-0 flex-col",
              mobilePane === "chat" ? "flex-1" : "hidden",
              responsiveVisiblePanes.has("chat") ? "md:flex md:flex-1" : "md:hidden",
            ].join(" ")}>
              <TaskChatSurface
                viewMode={taskViewMode}
                agentSessionId={chatTask.agentSessionId}
                terminal={<TerminalPane wsUrl={`/api/tasks/${chatTaskId}/agent-terminal`} />}
              >
                <ChatPanel
                  messages={session.messages}
                  activities={session.activities}
                  tasks={tasks}
                  agentStatus={session.agentStatus}
                  queueLength={session.queueLength}
                  queuedPrompts={session.queuedPrompts}
                  model={chatTask.model}
                  provider={chatTask.provider}
                  reasoningEffort={chatTask.reasoningEffort}
                  taskStatus={chatTask.status}
                  taskError={chatTask.error}
                  taskId={chatTaskId}
                  taskTitle={chatTask.title}
                  onSend={handleSend}
                  onAbort={session.abort}
                  onQueuedPromptUpdate={session.updateQueuedPrompt}
                  onQueuedPromptRemove={session.removeQueuedPrompt}
                  onQueuedPromptClearAll={session.clearAllQueuedPrompts}
                  onQueuedPromptSendNow={session.sendNowQueuedPrompt}
                  onModelChange={handleModelChange}
                  onReasoningEffortChange={handleReasoningEffortChange}
                  onModeChange={handleModeChange}
                  configOptions={session.configOptions}
                  slashCommands={session.slashCommands}
                  predefinedPrompts={resolvedPrompts}
                  onResolve={canResolve ? handleResolve : undefined}
                  canContinue={canContinue}
                  taskBranch={chatTask.status === "cancelled" ? (chatTask.branch ?? undefined) : undefined}
                  taskProjectId={chatTask.projectId}
                  autoFocusKey={chatTaskId}
                  contextTokens={session.contextTokens || undefined}
                  contextWindowMax={session.contextWindowMax ?? undefined}
                  permissionRequest={session.permissionRequest}
                  onPermissionRespond={session.respondToPermission}
                />
              </TaskChatSurface>
            </div>
          )}

          {/* Diff pane */}
          {orderedVisible.indexOf("diff") > 0 && (
            <ResizeHandle className="hidden md:flex" onPointerDown={resizeHandlers.diff!} />
          )}
          {hasDiff && (mobilePane === "diff" || responsiveVisiblePanes.has("diff")) && (
            <div
              className={[
                "@container/diff flex min-h-0 min-w-0 flex-col",
                mobilePane === "diff" ? "flex-1" : "hidden",
                responsiveVisiblePanes.has("diff")
                  ? `md:flex${desktopIsSolo || firstVisiblePane === "diff" ? " md:flex-1" : " md:flex-none md:[width:var(--pane-w)] md:max-w-full"}`
                  : "md:hidden",
              ].join(" ")}
              style={responsiveVisiblePanes.has("diff") && !desktopIsSolo && firstVisiblePane !== "diff" ? { "--pane-w": `${diffWidth}px` } as React.CSSProperties : undefined}
            >
              <div className="flex min-h-0 flex-1 flex-col @min-[700px]/diff:flex-row">
                <div className="min-w-0 flex-1 overflow-y-auto">
                  {diffFiles.length > 0 ? (
                    <DiffView files={diffFiles} comments={diffComments} onAddComment={isTerminated ? undefined : handleAddComment} />
                  ) : (
                    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
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
                    onUpdateComment={handleUpdateComment}
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
          {(mobilePane === "terminal" || responsiveVisiblePanes.has("terminal")) && (
            <div
              className={[
                "flex min-h-0 min-w-0 flex-col",
                mobilePane === "terminal" ? "flex-1" : "hidden",
                responsiveVisiblePanes.has("terminal")
                  ? `md:flex${desktopIsSolo || firstVisiblePane === "terminal" ? " md:flex-1" : " md:flex-none md:[width:var(--pane-w)] md:max-w-full"}`
                  : "md:hidden",
              ].join(" ")}
              style={responsiveVisiblePanes.has("terminal") && !desktopIsSolo && firstVisiblePane !== "terminal" ? { "--pane-w": `${terminalWidth}px` } as React.CSSProperties : undefined}
            >
              <TerminalPane taskId={id!} />
            </div>
          )}

          {/* Activity pane */}
          {orderedVisible.indexOf("activity") > 0 && (
            <ResizeHandle className="hidden md:flex" onPointerDown={resizeHandlers.activity!} />
          )}
          {(mobilePane === "activity" || responsiveVisiblePanes.has("activity")) && (
            <div
              className={[
                "flex min-h-0 min-w-0 flex-col bg-muted",
                mobilePane === "activity" ? "flex-1" : "hidden",
                responsiveVisiblePanes.has("activity")
                  ? `md:flex${desktopIsSolo || firstVisiblePane === "activity" ? " md:flex-1" : " md:flex-none md:[width:var(--pane-w)] md:max-w-full"}`
                  : "md:hidden",
              ].join(" ")}
              style={responsiveVisiblePanes.has("activity") && !desktopIsSolo && firstVisiblePane !== "activity" ? { "--pane-w": `${activityWidth}px` } as React.CSSProperties : undefined}
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
