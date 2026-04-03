import { useCallback, useEffect, useRef } from "react"
import { useOutletContext, useSearchParams } from "react-router-dom"
import { useProject } from "../context/ProjectContext"
import { useProjectNav } from "../hooks/useProjectNav"
import { NewAgentForm } from "../components/NewAgentForm"
import { createTask, archiveProject, unarchiveProject } from "../lib/api"
import type { SidebarContext } from "../components/Layout"
import { useToast } from "../context/ToastContext"

export function RunsPage() {
  const { navigate } = useProjectNav()
  const { current, refreshProjects } = useProject()
  const { showToast } = useToast()
  const { tasksLoading } = useOutletContext<SidebarContext>()
  const [searchParams] = useSearchParams()
  const refTaskId = searchParams.get("ref") ?? undefined
  const refTaskTitle = searchParams.get("refTitle") ?? undefined
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

  if (current?.archived) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 p-8 md:h-full">
        <div className="flex items-center gap-2">
          <span className="rounded bg-amber-500/10 px-2 py-1 text-sm font-medium text-amber-600 dark:text-amber-400">
            Archived
          </span>
          <h2 className="text-lg font-semibold text-fg">{current.name}</h2>
        </div>
        <p className="text-center text-sm text-fg-muted">
          This project is archived. Task history is still accessible from the sidebar.
        </p>
        <button
          onClick={handleUnarchive}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-accent/90"
        >
          Unarchive Project
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col md:h-full">
      <div ref={formRef} id="new-agent-form" className="min-h-0 flex-1">
        <NewAgentForm onSubmit={handleSubmit} refTaskId={refTaskId} refTaskTitle={refTaskTitle} autoFocus={shouldFocus} onArchive={handleArchive} />
      </div>
    </div>
  )
}
