import { useProject } from "../context/ProjectContext"
import { useProjectNav } from "../hooks/useProjectNav"
import { NewAgentForm } from "../components/NewAgentForm"
import { createTask } from "../lib/api"

export function NewAgentPage() {
  const { navigate } = useProjectNav()
  const { current } = useProject()

  const handleSubmit = async (data: { projectId: string; title: string; description?: string; provider?: string; model?: string; reasoningEffort?: string; images?: import("@tangerine/shared").PromptImage[] }) => {
    if (!current) return
    try {
      const { images, ...taskData } = data
      const task = await createTask(taskData)
      navigate(`/tasks/${task.id}`, { state: images && images.length > 0 ? { pendingImages: images } : undefined })
    } catch {
      // TODO: error toast
    }
  }

  return <NewAgentForm onSubmit={handleSubmit} />
}
