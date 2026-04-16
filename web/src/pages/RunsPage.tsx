import { useCallback, useEffect, useRef } from "react"
import { useOutletContext, useSearchParams, useNavigate, useLocation } from "react-router-dom"
import { useProject } from "../context/ProjectContext"
import { NewAgentForm, type NewAgentFormHandle } from "../components/NewAgentForm"
import { createTask } from "../lib/api"
import type { SidebarContext } from "../components/Layout"
import { useToast } from "../context/ToastContext"

export function RunsPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const { current } = useProject()
  const { showToast } = useToast()
  const { tasksLoading } = useOutletContext<SidebarContext>()
  const [searchParams] = useSearchParams()
  const refTaskId = searchParams.get("ref") ?? undefined
  const refTaskTitle = searchParams.get("refTitle") ?? undefined
  const refBranch = searchParams.get("branch") ?? undefined
  const refProjectId = searchParams.get("refProject") ?? undefined
  const formRef = useRef<HTMLDivElement>(null)
  const newAgentFormRef = useRef<NewAgentFormHandle>(null)
  const scrolledForRef = useRef<string | undefined>(undefined)
  const focusedForHashRef = useRef<string | null>(null)

  // On mobile the sidebar stacks above the form. Wait for the sidebar's initial
  // task fetch to complete (sidebar has its full height) before scrolling, so
  // the form doesn't get pushed back below the viewport after we scroll.
  // Track which refTaskId triggered the scroll so repeated continues work correctly.
  useEffect(() => {
    if (!tasksLoading && formRef.current && refTaskId && scrolledForRef.current !== refTaskId) {
      scrolledForRef.current = refTaskId
      formRef.current.scrollIntoView({ behavior: "smooth", block: "start" })
    }
  }, [refTaskId, tasksLoading])

  // Hash-based focus: browser scrolls natively, we just need to focus the textarea.
  // Track which hash we focused for to avoid re-focusing on re-renders.
  // Use requestAnimationFrame to defer focus until after paint, ensuring DOM is ready.
  useEffect(() => {
    if (location.hash === "#new-agent-textarea" && focusedForHashRef.current !== location.key) {
      focusedForHashRef.current = location.key
      requestAnimationFrame(() => {
        newAgentFormRef.current?.focus()
      })
    }
  }, [location.hash, location.key])

  const handleSubmit = useCallback(async (data: { projectId: string; title: string; description?: string; branch?: string; provider?: string; model?: string; reasoningEffort?: string; parentTaskId?: string; type?: string; images?: import("@tangerine/shared").PromptImage[] }) => {
    try {
      const task = await createTask(data)
      // Navigate with the task's own projectId so cross-project submits open correctly.
      navigate(`/tasks/${task.id}?project=${encodeURIComponent(task.projectId)}`)
    } catch {
      showToast("Failed to create task")
    }
  }, [navigate, showToast])

  if (current?.archived) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 p-8 md:h-full">
        <span className="rounded bg-amber-500/10 px-2 py-1 text-sm font-medium text-amber-600 dark:text-amber-400">
          Archived
        </span>
        <p className="text-center text-sm text-muted-foreground">
          This project is archived. Task history is still accessible from the sidebar.
          Visit the <strong>Status</strong> tab to unarchive it.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col md:h-full">
      <div ref={formRef} id="new-agent-form" className="min-h-0 flex-1">
        <NewAgentForm ref={newAgentFormRef} onSubmit={handleSubmit} refTaskId={refTaskId} refTaskTitle={refTaskTitle} refBranch={refBranch} refProjectId={refProjectId} />
      </div>
    </div>
  )
}
