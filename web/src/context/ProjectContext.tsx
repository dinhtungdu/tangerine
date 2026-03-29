import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react"
import { useSearchParams } from "react-router-dom"
import type { ProjectConfig } from "@tangerine/shared"
import { fetchProjects } from "../lib/api"

interface ProjectContextValue {
  projects: ProjectConfig[]
  current: ProjectConfig | null
  model: string
  models: string[]
  modelsByProvider: Record<string, string[]>
  setModel: (model: string) => void
  switchProject: (name: string, options?: { replace?: boolean }) => void
  refreshProjects: () => void
  loading: boolean
}

const ProjectContext = createContext<ProjectContextValue>({
  projects: [],
  current: null,
  model: "",
  models: [],
  modelsByProvider: {},
  setModel: () => {},
  switchProject: () => {},
  refreshProjects: () => {},
  loading: true,
})

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const [projects, setProjects] = useState<ProjectConfig[]>([])
  const [globalModel, setGlobalModel] = useState("")
  const [models, setModels] = useState<string[]>([])
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, string[]>>({})
  const [selectedModel, setSelectedModel] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchProjects()
      .then((data) => {
        setProjects(data.projects)
        setGlobalModel(data.model)
        setModels(data.models ?? [])
        setModelsByProvider(data.modelsByProvider ?? {})
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const projectParam = searchParams.get("project")
  const current = projects.find((p) => p.name === projectParam) ?? projects[0] ?? null
  const model = selectedModel ?? current?.model ?? globalModel

  const refreshProjects = useCallback(() => {
    fetchProjects()
      .then((data) => {
        setProjects(data.projects)
        setGlobalModel(data.model)
        setModels(data.models ?? [])
        setModelsByProvider(data.modelsByProvider ?? {})
      })
      .catch(() => {})
  }, [])

  const switchProject = useCallback(
    (name: string, { replace = false }: { replace?: boolean } = {}) => {
      setSelectedModel(null)
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        next.set("project", name)
        return next
      }, { replace })
    },
    [setSearchParams],
  )

  // Set URL param to first project if none specified and projects loaded.
  // Uses replace to avoid polluting the history stack — without this,
  // navigating back to a URL without ?project= would trigger a push forward,
  // trapping the user and preventing browser back navigation.
  useEffect(() => {
    if (!loading && projects.length > 0 && !projectParam) {
      switchProject(projects[0]!.name, { replace: true })
    }
  }, [loading, projects, projectParam, switchProject])

  return (
    <ProjectContext.Provider value={{ projects, current, model, models, modelsByProvider, setModel: setSelectedModel, switchProject, refreshProjects, loading }}>
      {children}
    </ProjectContext.Provider>
  )
}

export function useProject() {
  return useContext(ProjectContext)
}
