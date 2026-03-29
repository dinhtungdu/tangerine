import { useState, useMemo, useCallback } from "react"
import { ORCHESTRATOR_TASK_NAME } from "@tangerine/shared"
import { useProject } from "../context/ProjectContext"
import { useTaskSearch } from "../hooks/useTaskSearch"
import { useProjectNav } from "../hooks/useProjectNav"
import { ProjectSwitcher } from "../components/ProjectSwitcher"
import { RunsTable } from "../components/RunsTable"
import { getStatusConfig } from "../lib/status"
import { ensureOrchestrator } from "../lib/api"

const TERMINATED_STATUSES = new Set(["done", "completed", "cancelled"])

export function RunsPage() {
  const { navigate } = useProjectNav()
  const { current } = useProject()
  const { query, setQuery, tasks, refetch } = useTaskSearch(current?.name)
  const [orchLoading, setOrchLoading] = useState(false)

  const orchestrator = useMemo(() => {
    const orchTasks = tasks.filter((t) => t.title === ORCHESTRATOR_TASK_NAME)
    return orchTasks.find((t) => !TERMINATED_STATUSES.has(t.status)) ?? null
  }, [tasks])

  const nonOrchestratorTasks = useMemo(
    () => tasks.filter((t) => t.title !== ORCHESTRATOR_TASK_NAME),
    [tasks]
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
    <div className="flex h-full flex-col overflow-y-auto">
      {/* Mobile project switcher */}
      <div className="md:hidden">
        <ProjectSwitcher variant="mobile" />
      </div>

      <div className="mx-auto w-full max-w-[1200px] px-4 py-6 md:px-8 md:py-8">
        {/* Header */}
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-[20px] font-bold text-fg md:text-[24px]">Agent Runs</h1>
            <p className="mt-0.5 text-[13px] text-fg-muted">Monitor and manage your agent run history</p>
          </div>
          <button
            onClick={() => navigate("/new")}
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-surface-dark px-4 text-white md:h-10 md:px-5"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            <span className="text-[13px] font-medium md:text-[14px]">New Run</span>
          </button>
        </div>

        {/* Orchestrator entry */}
        <button
          onClick={handleOrchestratorClick}
          disabled={orchLoading}
          className="mb-4 flex w-full items-center gap-3 rounded-lg border border-edge bg-surface px-4 py-3 text-left hover:bg-surface-secondary md:mb-6"
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
          <div className="flex flex-1 items-center gap-2">
            <span className="text-[14px] font-medium text-fg">Orchestrator</span>
            {orchestrator && (
              <span className="text-[12px] text-fg-muted">{orchestrator.status}</span>
            )}
          </div>
          <svg className="h-4 w-4 text-fg-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
          </svg>
        </button>

        {/* Runs table — responsive */}
        <RunsTable
          tasks={nonOrchestratorTasks}
          searchQuery={query}
          onSearchChange={setQuery}
          onRefetch={refetch}
        />
      </div>
    </div>
  )
}
