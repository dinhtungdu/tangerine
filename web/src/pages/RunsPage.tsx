import { useCallback } from "react"
import { useSearchParams } from "react-router-dom"
import { useProject } from "../context/ProjectContext"
import { useProjectNav } from "../hooks/useProjectNav"
import { NewAgentForm } from "../components/NewAgentForm"
import { ProjectSwitcher } from "../components/ProjectSwitcher"
import { createTask } from "../lib/api"

export function RunsPage() {
  const { navigate } = useProjectNav()
  const { current } = useProject()
  const [searchParams] = useSearchParams()
  const refTaskId = searchParams.get("ref") ?? undefined
  const refTaskTitle = searchParams.get("refTitle") ?? undefined

  const handleSubmit = useCallback(async (data: { projectId: string; title: string; description?: string; branch?: string; provider?: string; model?: string; reasoningEffort?: string; parentTaskId?: string; type?: string; images?: import("@tangerine/shared").PromptImage[] }) => {
    if (!current) return
    try {
      const task = await createTask(data)
      navigate(`/tasks/${task.id}`)
    } catch {
      // TODO: error toast
    }
  }, [current, navigate])

  return (
    <div className="flex flex-col md:h-full">
      {/* Mobile project switcher */}
      <div className="md:hidden">
        <ProjectSwitcher variant="mobile" />
      </div>
      <div className="min-h-0 flex-1">
        <NewAgentForm onSubmit={handleSubmit} refTaskId={refTaskId} refTaskTitle={refTaskTitle} />
      </div>
    </div>
  )
}
