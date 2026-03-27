import { useSearchParams } from "react-router-dom"
import { useProject } from "../context/ProjectContext"
import { useProjectNav } from "../hooks/useProjectNav"
import { NewAgentForm } from "../components/NewAgentForm"
import { createTask } from "../lib/api"

export function NewAgentPage() {
  const { navigate } = useProjectNav()
  const { current } = useProject()
  const [searchParams] = useSearchParams()

  const refTaskId = searchParams.get("ref") ?? undefined
  const refTaskTitle = searchParams.get("refTitle") ?? undefined

  const handleSubmit = async (data: { projectId: string; title: string; description?: string; branch?: string; provider?: string; model?: string; reasoningEffort?: string; images?: import("@tangerine/shared").PromptImage[]; type?: "code" | "review"; reviewPrNumber?: number; reviewTaskId?: string }) => {
    if (!current) return
    try {
      const task = await createTask(data)
      navigate(`/tasks/${task.id}`)
    } catch {
      // TODO: error toast
    }
  }

  return <NewAgentForm onSubmit={handleSubmit} refTaskId={refTaskId} refTaskTitle={refTaskTitle} />
}
