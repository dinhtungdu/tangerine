import { useCallback, useEffect, useRef } from "react"
import { useOutletContext, useSearchParams } from "react-router-dom"
import { useProject } from "../context/ProjectContext"
import { useProjectNav } from "../hooks/useProjectNav"
import { NewAgentForm } from "../components/NewAgentForm"
import { createTask } from "../lib/api"
import type { SidebarContext } from "../components/Layout"
import { useToast } from "../context/ToastContext"

export function RunsPage() {
  const { navigate } = useProjectNav()
  const { current } = useProject()
  const { showToast } = useToast()
  const { tasksLoading } = useOutletContext<SidebarContext>()
  const [searchParams] = useSearchParams()
  const refTaskId = searchParams.get("ref") ?? undefined
  const refTaskTitle = searchParams.get("refTitle") ?? undefined
  const refBranch = searchParams.get("branch") ?? undefined
  const shouldFocus = searchParams.get("focus") === "1"
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
      showToast("Failed to create task")
    }
  }, [current, navigate, showToast])

  if (current?.archived) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 p-8 md:h-full">
        <span className="rounded bg-amber-500/10 px-2 py-1 text-sm font-medium text-amber-600 dark:text-amber-400">
          Archived
        </span>
        <p className="text-center text-sm text-fg-muted">
          This project is archived. Task history is still accessible from the sidebar.
          Visit the <strong>Status</strong> tab to unarchive it.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col md:h-full">
      <div ref={formRef} id="new-agent-form" className="min-h-0 flex-1">
        <NewAgentForm onSubmit={handleSubmit} refTaskId={refTaskId} refTaskTitle={refTaskTitle} refBranch={refBranch} autoFocus={shouldFocus} />
      </div>
    </div>
  )
}
