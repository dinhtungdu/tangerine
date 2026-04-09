import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react"
import { useSearchParams, useNavigate, useLocation } from "react-router-dom"
import type { ProjectConfig, ActionCombo, ShortcutConfig, SystemCapabilities } from "@tangerine/shared"
import { fetchProjects, fetchTasks, ensureOrchestrator, type ProviderMeta } from "../lib/api"
import { getMostRecentTask } from "../lib/task-recency"

interface ProjectContextValue {
  projects: ProjectConfig[]
  current: ProjectConfig | null
  model: string
  modelsByProvider: Record<string, string[]>
  providerMetadata: Record<string, ProviderMeta>
  systemCapabilities: SystemCapabilities | null
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
  modelsByProvider: {},
  providerMetadata: {},
  systemCapabilities: null,
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
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, string[]>>({})
  const [providerMetadata, setProviderMetadata] = useState<Record<string, ProviderMeta>>({})
  const [systemCapabilities, setSystemCapabilities] = useState<SystemCapabilities | null>(null)
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
        setModelsByProvider(data.modelsByProvider ?? {})
        setProviderMetadata(data.providerMetadata ?? {})
        setSystemCapabilities(data.systemCapabilities ?? null)
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
        setModelsByProvider(data.modelsByProvider ?? {})
        setProviderMetadata(data.providerMetadata ?? {})
        setSystemCapabilities(data.systemCapabilities ?? null)
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
        const projectParam = `?project=${encodeURIComponent(name)}`
        fetchTasks({ project: name }).then((tasks) => {
          const task = getMostRecentTask(tasks)
          if (task) {
            navigate(`/tasks/${task.id}${projectParam}`, { replace })
            return
          }
          return ensureOrchestrator(name).then((orchestrator) => {
            navigate(`/tasks/${orchestrator.id}${projectParam}`, { replace })
          })
        }).catch(() => {
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
    <ProjectContext.Provider value={{ projects, current, model, modelsByProvider, providerMetadata, systemCapabilities, sshHost, sshUser, editor, actionCombos, shortcuts, setModel: setSelectedModel, switchProject, refreshProjects, loading }}>
      {children}
    </ProjectContext.Provider>
  )
}

export function useProject() {
  return useContext(ProjectContext)
}
