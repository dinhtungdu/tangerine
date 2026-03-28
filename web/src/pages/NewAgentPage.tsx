import { useMemo } from "react"
import { useSearchParams } from "react-router-dom"
import { useProject } from "../context/ProjectContext"
import { useProjectNav } from "../hooks/useProjectNav"
import { useSwipe } from "../hooks/useSwipe"
import { NewAgentForm } from "../components/NewAgentForm"
import { createTask } from "../lib/api"

export function NewAgentPage() {
  const { navigate } = useProjectNav()
  const { current } = useProject()
  const [searchParams] = useSearchParams()
  const swipe = useSwipe(useMemo(() => ({ onSwipeRight: () => navigate("/") }), [navigate]))

  const refTaskId = searchParams.get("ref") ?? undefined
  const refTaskTitle = searchParams.get("refTitle") ?? undefined

  const handleSubmit = async (data: { projectId: string; title: string; description?: string; branch?: string; provider?: string; model?: string; reasoningEffort?: string; parentTaskId?: string; images?: import("@tangerine/shared").PromptImage[] }) => {
    if (!current) return
    try {
      const task = await createTask(data)
      navigate(`/tasks/${task.id}`)
    } catch {
      // TODO: error toast
    }
  }

  return (
    <div className="flex h-full flex-1 flex-col" {...swipe}>
      <NewAgentForm onSubmit={handleSubmit} refTaskId={refTaskId} refTaskTitle={refTaskTitle} />
    </div>
  )
}
