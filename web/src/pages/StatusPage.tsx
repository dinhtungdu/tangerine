import { useOutletContext } from "react-router-dom"
import { useProject } from "../context/ProjectContext"
import type { SidebarContext } from "../components/Layout"
import { ActiveRunsCard, SystemLog, ProjectUpdateCard } from "../components/StatusWidgets"
import { PredefinedPromptsEditor } from "../components/PredefinedPromptsEditor"

export function StatusPage() {
  const { current } = useProject()
  const outletCtx = useOutletContext<SidebarContext | null>()
  const tasks = outletCtx?.tasks ?? []

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
                configKey="predefinedPrompts"
                prompts={current.predefinedPrompts ?? []}
              />
              <PredefinedPromptsEditor
                key={`${current.name}-orchestrator`}
                project={current.name}
                title="Orchestrator Quick Replies"
                configKey="orchestratorPrompts"
                prompts={current.orchestratorPrompts ?? []}
              />
              <PredefinedPromptsEditor
                key={`${current.name}-reviewer`}
                project={current.name}
                title="Reviewer Quick Replies"
                configKey="reviewerPrompts"
                prompts={current.reviewerPrompts ?? []}
              />
            </>
          )}

          {/* System log */}
          <SystemLog project={current?.name} />
        </div>
      </div>
    </div>
  )
}
