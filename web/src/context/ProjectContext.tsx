import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react"
import { useSearchParams } from "react-router-dom"
import type { ProjectConfig } from "@tangerine/shared"
import { fetchProjects } from "../lib/api"

interface ProjectContextValue {
  projects: ProjectConfig[]
  current: ProjectConfig | null
  model: string
  models: string[]
  setModel: (model: string) => void
  switchProject: (name: string) => void
  loading: boolean
}

const ProjectContext = createContext<ProjectContextValue>({
  projects: [],
  current: null,
  model: "",
  models: [],
  setModel: () => {},
  switchProject: () => {},
  loading: true,
})

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const [projects, setProjects] = useState<ProjectConfig[]>([])
  const [globalModel, setGlobalModel] = useState("")
  const [models, setModels] = useState<string[]>([])
  const [selectedModel, setSelectedModel] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchProjects()
      .then((data) => {
        setProjects(data.projects)
        setGlobalModel(data.model)
        setModels(data.models)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const projectParam = searchParams.get("project")
  const current = projects.find((p) => p.name === projectParam) ?? projects[0] ?? null
  const model = selectedModel ?? current?.model ?? globalModel

  const switchProject = useCallback(
    (name: string) => {
      setSelectedModel(null)
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        next.set("project", name)
        return next
      })
    },
    [setSearchParams],
  )

  // Set URL param to first project if none specified and projects loaded
  useEffect(() => {
    if (!loading && projects.length > 0 && !projectParam) {
      switchProject(projects[0]!.name)
    }
  }, [loading, projects, projectParam, switchProject])

  return (
    <ProjectContext.Provider value={{ projects, current, model, models, setModel: setSelectedModel, switchProject, loading }}>
      {children}
    </ProjectContext.Provider>
  )
}

export function useProject() {
  return useContext(ProjectContext)
}
