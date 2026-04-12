import { useCallback, useMemo } from "react"
import { useOutletContext } from "react-router-dom"
import { useProject } from "../context/ProjectContext"
import { useToast } from "../context/ToastContext"
import { resolveTaskTypeConfig } from "@tangerine/shared"
import type { SidebarContext } from "../components/Layout"
import { ActiveRunsCard, SystemLog, ProjectUpdateCard } from "../components/StatusWidgets"
import { PredefinedPromptsEditor } from "../components/PredefinedPromptsEditor"
import { SystemPromptEditor } from "../components/SystemPromptEditor"
import { archiveProject, unarchiveProject } from "../lib/api"
import { ProjectSelector } from "../components/ProjectSelector"

export function StatusPage() {
  const { current, projects, switchProject, refreshProjects } = useProject()
  const { showToast } = useToast()
  const outletCtx = useOutletContext<SidebarContext | null>()
  const allTasks = outletCtx?.tasks ?? []
  const tasks = useMemo(
    () => current ? allTasks.filter((t) => t.projectId === current.name) : allTasks,
    [allTasks, current],
  )

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
          {/* Title + project selector */}
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-semibold text-foreground md:text-2xl">System Status</h1>
              <ProjectSelector
                projects={projects}
                value={current?.name ?? ""}
                onChange={(v) => switchProject(v, { replace: true })}
                hideArchived={false}
                aria-label="Select project"
              />
            </div>
            <p className="hidden text-sm text-muted-foreground md:block">Infrastructure health for {current?.name ?? "the current project"}</p>
          </div>

          {/* Project update + Active runs */}
          <div className="flex flex-col gap-4 md:flex-row md:gap-6">
            <ProjectUpdateCard project={current?.name} />
            <ActiveRunsCard tasks={tasks} />
          </div>

          {/* Per-task-type config */}
          {current && (
            <>
              <SystemPromptEditor
                key={`${current.name}-worker-sp`}
                project={current.name}
                title="Worker System Prompt"
                taskType="worker"
                value={resolveTaskTypeConfig(current, "worker").systemPrompt}
              />
              <PredefinedPromptsEditor
                key={`${current.name}-worker`}
                project={current.name}
                title="Worker Quick Replies"
                taskType="worker"
                prompts={resolveTaskTypeConfig(current, "worker").predefinedPrompts}
              />
              <SystemPromptEditor
                key={`${current.name}-orchestrator-sp`}
                project={current.name}
                title="Orchestrator System Prompt"
                taskType="orchestrator"
                value={resolveTaskTypeConfig(current, "orchestrator").systemPrompt}
              />
              <PredefinedPromptsEditor
                key={`${current.name}-orchestrator`}
                project={current.name}
                title="Orchestrator Quick Replies"
                taskType="orchestrator"
                prompts={resolveTaskTypeConfig(current, "orchestrator").predefinedPrompts}
              />
              <SystemPromptEditor
                key={`${current.name}-reviewer-sp`}
                project={current.name}
                title="Reviewer System Prompt"
                taskType="reviewer"
                value={resolveTaskTypeConfig(current, "reviewer").systemPrompt}
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
                  className="text-sm text-muted-foreground transition hover:text-foreground"
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
