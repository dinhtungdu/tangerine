import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react"
import { useSearchParams, useNavigate, useLocation } from "react-router-dom"
import type { ProjectConfig, ActionCombo, ShortcutConfig } from "@tangerine/shared"
import { fetchProjects, ensureOrchestrator } from "../lib/api"

interface ProjectContextValue {
  projects: ProjectConfig[]
  current: ProjectConfig | null
  model: string
  models: string[]
  modelsByProvider: Record<string, string[]>
  sshHost: string | undefined
  sshUser: string | undefined
  editor: "vscode" | "cursor" | "zed" | undefined
  actionCombos: ActionCombo[]
  shortcuts: Record<string, ShortcutConfig>
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
  sshHost: undefined,
  sshUser: undefined,
  editor: undefined,
  actionCombos: [],
  shortcuts: {},
  setModel: () => {},
  switchProject: () => {},
  refreshProjects: () => {},
  loading: true,
})

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const location = useLocation()
  const [projects, setProjects] = useState<ProjectConfig[]>([])
  const [globalModel, setGlobalModel] = useState("")
  const [models, setModels] = useState<string[]>([])
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, string[]>>({})
  const [selectedModel, setSelectedModel] = useState<string | null>(null)
  const [sshHost, setSshHost] = useState<string | undefined>(undefined)
  const [sshUser, setSshUser] = useState<string | undefined>(undefined)
  const [editor, setEditor] = useState<"vscode" | "cursor" | "zed" | undefined>(undefined)
  const [actionCombos, setActionCombos] = useState<ActionCombo[]>([])
  const [shortcuts, setShortcuts] = useState<Record<string, ShortcutConfig>>({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchProjects()
      .then((data) => {
        setProjects(data.projects)
        setGlobalModel(data.model)
        setModels(data.models ?? [])
        setModelsByProvider(data.modelsByProvider ?? {})
        setSshHost(data.sshHost)
        setSshUser(data.sshUser)
        setEditor(data.editor)
        setActionCombos(data.actionCombos ?? [])
        setShortcuts(data.shortcuts ?? {})
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const projectParam = searchParams.get("project")
  const defaultProject = projects.find((p) => !p.archived) ?? projects[0] ?? null
  const current = projects.find((p) => p.name === projectParam) ?? defaultProject
  const model = selectedModel ?? current?.model ?? globalModel

  const refreshProjects = useCallback(() => {
    fetchProjects()
      .then((data) => {
        setProjects(data.projects)
        setGlobalModel(data.model)
        setModels(data.models ?? [])
        setModelsByProvider(data.modelsByProvider ?? {})
        setSshHost(data.sshHost)
        setSshUser(data.sshUser)
        setEditor(data.editor)
        setActionCombos(data.actionCombos ?? [])
        setShortcuts(data.shortcuts ?? {})
      })
      .catch(() => {})
  }, [])

  const switchProject = useCallback(
    (name: string, { replace = false }: { replace?: boolean } = {}) => {
      setSelectedModel(null)
      if (location.pathname.startsWith("/tasks/")) {
        // Navigate to the new project's orchestrator chat
        const projectParam = `?project=${encodeURIComponent(name)}`
        ensureOrchestrator(name).then((task) => {
          navigate(`/tasks/${task.id}${projectParam}`, { replace })
        }).catch(() => {
          // Fallback to runs page if orchestrator can't be found
          navigate(`/${projectParam}`, { replace })
        })
      } else {
        setSearchParams((prev) => {
          const next = new URLSearchParams(prev)
          next.set("project", name)
          return next
        }, { replace })
      }
    },
    [setSearchParams, navigate, location.pathname],
  )

  // Set URL param to first project if none specified and projects loaded.
  // Uses replace to avoid polluting the history stack — without this,
  // navigating back to a URL without ?project= would trigger a push forward,
  // trapping the user and preventing browser back navigation.
  // Calls setSearchParams directly (not switchProject) to avoid redirecting
  // away from the current page (e.g. a bookmarked /tasks/:id URL).
  useEffect(() => {
    if (!loading && projects.length > 0 && !projectParam) {
      const preferred = projects.find((p) => !p.archived) ?? projects[0]!
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        next.set("project", preferred.name)
        return next
      }, { replace: true })
    }
  }, [loading, projects, projectParam, setSearchParams])

  return (
    <ProjectContext.Provider value={{ projects, current, model, models, modelsByProvider, sshHost, sshUser, editor, actionCombos, shortcuts, setModel: setSelectedModel, switchProject, refreshProjects, loading }}>
      {children}
    </ProjectContext.Provider>
  )
}

export function useProject() {
  return useContext(ProjectContext)
}
