import { useState, useEffect } from "react"
import { useParams, useNavigate } from "react-router-dom"
import type { Task } from "@tangerine/shared"
import { fetchTask } from "../lib/api"
import { useSession } from "../hooks/useSession"
import { useTasks } from "../hooks/useTasks"
import { TasksSidebar } from "../components/TasksSidebar"
import { ChatPanel } from "../components/ChatPanel"
import { ActivityPanel } from "../components/ActivityPanel"

export function TaskDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [task, setTask] = useState<Task | null>(null)
  const [loading, setLoading] = useState(true)
  const [showActivity, setShowActivity] = useState(true)

  const session = useSession(id ?? "")
  const { tasks } = useTasks()

  useEffect(() => {
    if (!id) return
    let cancelled = false

    async function load() {
      try {
        const data = await fetchTask(id!)
        if (!cancelled) {
          setTask(data)
        }
      } catch {
        // task not found
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    const interval = setInterval(load, 10000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [id])

  useEffect(() => {
    if (session.taskStatus) {
      setTask((prev) => (prev ? { ...prev, status: session.taskStatus! } : prev))
    }
  }, [session.taskStatus])

  if (loading) {
    return (
      <div className="flex h-full">
        <TasksSidebar tasks={tasks} onNewAgent={() => navigate("/")} />
        <div className="flex flex-1 items-center justify-center text-[13px] text-[#737373]">
          Loading...
        </div>
      </div>
    )
  }

  if (!task) {
    return (
      <div className="flex h-full">
        <TasksSidebar tasks={tasks} onNewAgent={() => navigate("/")} />
        <div className="flex flex-1 items-center justify-center text-[13px] text-[#737373]">
          Task not found
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full">
      <TasksSidebar tasks={tasks} onNewAgent={() => navigate("/")} />

      {/* Chat panel */}
      <div className="flex min-w-0 flex-1 flex-col">
        <ChatPanel
          messages={session.messages}
          agentStatus={session.agentStatus}
          queueLength={session.queueLength}
          taskTitle={task.title}
          branch={task.branch ?? undefined}
          prUrl={task.prUrl ?? undefined}
          onSend={session.sendPrompt}
          onAbort={session.abort}
          onToggleActivity={() => setShowActivity(!showActivity)}
          showActivityToggle
        />
      </div>

      {/* Activity panel */}
      {showActivity && (
        <ActivityPanel
          messages={session.messages}
          onCollapse={() => setShowActivity(false)}
        />
      )}
    </div>
  )
}
