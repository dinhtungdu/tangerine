import { useCallback } from "react"
import { useOutletContext } from "react-router-dom"
import { useProject } from "../context/ProjectContext"
import { useToast } from "../context/ToastContext"
import { resolveTaskTypeConfig } from "@tangerine/shared"
import type { SidebarContext } from "../components/Layout"
import { ActiveRunsCard, SystemLog, ProjectUpdateCard } from "../components/StatusWidgets"
import { PredefinedPromptsEditor } from "../components/PredefinedPromptsEditor"
import { archiveProject, unarchiveProject } from "../lib/api"

export function StatusPage() {
  const { current, refreshProjects } = useProject()
  const { showToast } = useToast()
  const outletCtx = useOutletContext<SidebarContext | null>()
  const tasks = outletCtx?.tasks ?? []

  const handleArchive = useCallback(async () => {
    if (!current) return
    try {
      await archiveProject(current.name)
      refreshProjects()
      showToast(`Project "${current.name}" archived`)
    } catch {
      showToast("Failed to archive project")
    }
  }, [current, refreshProjects, showToast])

  const handleUnarchive = useCallback(async () => {
    if (!current) return
    try {
      await unarchiveProject(current.name)
      refreshProjects()
      showToast(`Project "${current.name}" unarchived`)
    } catch {
      showToast("Failed to unarchive project")
    }
  }, [current, refreshProjects, showToast])

  return (
    <div className="flex h-full w-full flex-col">
      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto p-4 md:p-6">
        <div className="flex flex-col gap-4 md:gap-6">
          {/* Title — desktop only */}
          <div className="hidden flex-col gap-1 md:flex">
            <h1 className="text-2xl font-semibold text-fg">System Status</h1>
            <p className="text-sm text-fg-muted">Infrastructure health for the current project</p>
          </div>

          {/* Project update + Active runs */}
          <div className="flex flex-col gap-4 md:flex-row md:gap-6">
            <ProjectUpdateCard project={current?.name} />
            <ActiveRunsCard tasks={tasks} />
          </div>

          {/* Predefined prompts */}
          {current && (
            <>
              <PredefinedPromptsEditor
                key={`${current.name}-worker`}
                project={current.name}
                title="Worker Quick Replies"
                taskType="worker"
                prompts={resolveTaskTypeConfig(current, "worker").predefinedPrompts}
              />
              <PredefinedPromptsEditor
                key={`${current.name}-orchestrator`}
                project={current.name}
                title="Orchestrator Quick Replies"
                taskType="orchestrator"
                prompts={resolveTaskTypeConfig(current, "orchestrator").predefinedPrompts}
              />
              <PredefinedPromptsEditor
                key={`${current.name}-reviewer`}
                project={current.name}
                title="Reviewer Quick Replies"
                taskType="reviewer"
                prompts={resolveTaskTypeConfig(current, "reviewer").predefinedPrompts}
              />
            </>
          )}

          {/* System log */}
          <SystemLog project={current?.name} />

          {/* Archive / Unarchive */}
          {current && (
            <div className="flex justify-end">
              {current.archived ? (
                <button
                  onClick={handleUnarchive}
                  className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-accent/90"
                >
                  Unarchive Project
                </button>
              ) : (
                <button
                  onClick={handleArchive}
                  className="text-sm text-fg-muted transition hover:text-fg"
                >
                  Archive project
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
