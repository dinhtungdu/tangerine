import { useCallback, useEffect, useRef } from "react"
import { useOutletContext, useSearchParams } from "react-router-dom"
import { useProject } from "../context/ProjectContext"
import { useProjectNav } from "../hooks/useProjectNav"
import { NewAgentForm } from "../components/NewAgentForm"
import { createTask } from "../lib/api"
import type { SidebarContext } from "../components/Layout"

export function RunsPage() {
  const { navigate } = useProjectNav()
  const { current } = useProject()
  const { tasksLoading } = useOutletContext<SidebarContext>()
  const [searchParams] = useSearchParams()
  const refTaskId = searchParams.get("ref") ?? undefined
  const refTaskTitle = searchParams.get("refTitle") ?? undefined
  const formRef = useRef<HTMLDivElement>(null)
  const scrolledForRef = useRef<string | undefined>(undefined)

  // On mobile the sidebar stacks above the form. Wait for the sidebar's initial
  // task fetch to complete (sidebar has its full height) before scrolling, so
  // the form doesn't get pushed back below the viewport after we scroll.
  // Track which refTaskId triggered the scroll so repeated continues work correctly.
  useEffect(() => {
    if (refTaskId && !tasksLoading && scrolledForRef.current !== refTaskId && formRef.current) {
      scrolledForRef.current = refTaskId
      formRef.current.scrollIntoView({ behavior: "smooth", block: "start" })
    }
  }, [refTaskId, tasksLoading])

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
      <div ref={formRef} id="new-agent-form" className="min-h-0 flex-1">
        <NewAgentForm onSubmit={handleSubmit} refTaskId={refTaskId} refTaskTitle={refTaskTitle} />
      </div>
    </div>
  )
}
