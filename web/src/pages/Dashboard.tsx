import { useState, useEffect } from "react"
import { useNavigate } from "react-router-dom"
import type { ProjectConfig } from "@tangerine/shared"
import { useTasks } from "../hooks/useTasks"
import { TasksSidebar } from "../components/TasksSidebar"
import { NewAgentForm } from "../components/NewAgentForm"
import { createTask, fetchProjects } from "../lib/api"

export function Dashboard() {
  const navigate = useNavigate()
  const [projects, setProjects] = useState<ProjectConfig[]>([])
  const { tasks, refetch } = useTasks()

  useEffect(() => {
    fetchProjects()
      .then(setProjects)
      .catch(() => {})
  }, [])

  const handleNewAgent = async (data: { projectId: string; title: string; description?: string }) => {
    try {
      const task = await createTask(data)
      refetch()
      navigate(`/tasks/${task.id}`)
    } catch {
      // TODO: show error toast
    }
  }

  return (
    <div className="flex h-full">
      <TasksSidebar
        tasks={tasks}
        onNewAgent={() => {/* already on new agent screen */}}
      />
      <NewAgentForm
        projects={projects}
        onSubmit={handleNewAgent}
      />
    </div>
  )
}
