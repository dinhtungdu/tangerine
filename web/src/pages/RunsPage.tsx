import { useState, useMemo, useCallback } from "react"
import { useOutletContext } from "react-router-dom"
import type { SidebarContext } from "../components/Layout"
import { useProjectNav } from "../hooks/useProjectNav"
import { useProject } from "../context/ProjectContext"
import { ProjectSwitcher } from "../components/ProjectSwitcher"
import { MobileTaskItem } from "../components/TaskListItem"
import { getStatusConfig } from "../lib/status"
import { ensureOrchestrator } from "../lib/api"

const TERMINATED_STATUSES = new Set(["done", "completed", "cancelled"])
const SHOW_COMPLETED_KEY = "tangerine:sidebar-show-completed"

export function RunsPage() {
  const { navigate } = useProjectNav()
  const { current } = useProject()
  const outletCtx = useOutletContext<SidebarContext | null>()
  const tasks = outletCtx?.tasks ?? []
  const refetch = outletCtx?.refetch
  const [orchLoading, setOrchLoading] = useState(false)
  const [showCompleted, setShowCompleted] = useState(() => {
    try { return localStorage.getItem(SHOW_COMPLETED_KEY) === "true" } catch { return false }
  })

  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks])

  const orchestrator = useMemo(() => {
    const orchTasks = tasks.filter((t) => t.type === "orchestrator")
    return orchTasks.find((t) => !TERMINATED_STATUSES.has(t.status)) ?? null
  }, [tasks])

  const activeTasks = useMemo(
    () => tasks.filter((t) => !TERMINATED_STATUSES.has(t.status) && t.type !== "orchestrator"),
    [tasks],
  )

  const completedTasks = useMemo(
    () => tasks.filter((t) => TERMINATED_STATUSES.has(t.status) && t.type !== "orchestrator"),
    [tasks],
  )

  const handleOrchestratorClick = useCallback(async () => {
    if (!current) return
    if (orchestrator) {
      navigate(`/tasks/${orchestrator.id}`)
      return
    }
    setOrchLoading(true)
    try {
      const task = await ensureOrchestrator(current.name)
      navigate(`/tasks/${task.id}`)
    } finally {
      setOrchLoading(false)
    }
  }, [current, orchestrator, navigate])

  return (
    <div className="flex h-full flex-col">
      {/* Mobile: project switcher */}
      <div className="md:hidden">
        <ProjectSwitcher variant="mobile" />
      </div>

      {/* Mobile: full task list */}
      <div className="flex flex-1 flex-col overflow-y-auto px-4 py-4 md:hidden">
        {/* Orchestrator */}
        <button
          onClick={handleOrchestratorClick}
          disabled={orchLoading}
          className="mb-3 flex w-full items-center gap-3 rounded-lg border border-edge bg-surface px-3.5 py-3 text-left"
        >
          <div className="flex h-5 w-5 items-center justify-center">
            {orchLoading ? (
              <div className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-fg-muted border-t-transparent" />
            ) : (
              <div
                className="h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: orchestrator ? getStatusConfig(orchestrator.status).color : "var(--color-fg-muted)" }}
              />
            )}
          </div>
          <span className="flex-1 text-[14px] font-medium text-fg">Orchestrator</span>
          <svg className="h-4 w-4 text-fg-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
          </svg>
        </button>

        {/* New Agent button */}
        <button
          onClick={() => navigate("/new")}
          className="mb-4 flex h-10 w-full items-center justify-center gap-1.5 rounded-lg bg-surface-dark text-white"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          <span className="text-[14px] font-medium">New Agent</span>
        </button>

        {/* Active runs */}
        {activeTasks.length > 0 && (
          <>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-medium tracking-wider text-fg-muted">ACTIVE RUNS</span>
              <span className="font-mono text-[11px] text-fg-muted">{activeTasks.length}</span>
            </div>
            <div className="flex flex-col gap-2">
              {activeTasks.map((task) => (
                <MobileTaskItem key={task.id} task={task} taskById={taskById} onRefetch={refetch} />
              ))}
            </div>
          </>
        )}

        {activeTasks.length === 0 && (
          <div className="flex flex-1 items-center justify-center text-[13px] text-fg-muted">
            No active runs
          </div>
        )}

        {/* Completed toggle */}
        {completedTasks.length > 0 && (
          <>
            <button
              onClick={() => setShowCompleted((prev) => {
                const next = !prev
                try { localStorage.setItem(SHOW_COMPLETED_KEY, String(next)) } catch { /* ignore */ }
                return next
              })}
              className="mt-4 flex w-full items-center justify-between py-2"
            >
              <span className="text-[11px] font-medium tracking-wider text-fg-muted">COMPLETED</span>
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-[11px] text-fg-muted">{completedTasks.length}</span>
                <svg
                  className={`h-3 w-3 text-fg-muted transition-transform ${showCompleted ? "rotate-180" : ""}`}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
                </svg>
              </div>
            </button>
            {showCompleted && (
              <div className="flex flex-col gap-2">
                {completedTasks.map((task) => (
                  <MobileTaskItem key={task.id} task={task} taskById={taskById} onRefetch={refetch} />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Desktop: empty state (sidebar is the task list) */}
      <div className="hidden h-full flex-col items-center justify-center md:flex">
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-surface-secondary">
            <svg className="h-6 w-6 text-fg-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.076-4.076a1.526 1.526 0 0 1 1.037-.443 48.282 48.282 0 0 0 5.68-.494c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z" />
            </svg>
          </div>
          <div>
            <p className="text-[14px] font-medium text-fg">Select a task from the sidebar</p>
            <p className="mt-1 text-[13px] text-fg-muted">or create a new agent to get started</p>
          </div>
          <button
            onClick={() => navigate("/new")}
            className="flex h-9 items-center gap-1.5 rounded-lg bg-surface-dark px-4 text-white"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            <span className="text-[13px] font-medium">New Agent</span>
          </button>
        </div>
      </div>
    </div>
  )
}
