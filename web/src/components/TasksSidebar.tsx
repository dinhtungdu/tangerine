import { useMemo, useState, useCallback, useEffect } from "react"
import { Link, useParams, useNavigate } from "react-router-dom"
import { TERMINAL_STATUSES } from "@tangerine/shared"
import type { Task, ProjectConfig } from "@tangerine/shared"
import { Search, Plus, X } from "lucide-react"
import { getStatusConfig, hasUnseenUpdates } from "../lib/status"
import { formatRelativeTime } from "../lib/format"
import { useProject } from "../context/ProjectContext"
import { ensureOrchestrator } from "../lib/api"
import { TaskOverflowMenu } from "./TaskListItem"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"

interface TasksSidebarProps {
  tasks: Task[]
  projects: ProjectConfig[]
  searchQuery: string
  onSearchChange: (query: string) => void
  onNewAgent: () => void
  onRefetch?: () => void
}

const ACTIVE_ONLY_KEY = "tangerine:sidebar-active-only"
const PROJECT_FILTER_KEY = "tangerine:sidebar-project-filter"

function readActiveOnly(): boolean {
  try {
    const v = localStorage.getItem(ACTIVE_ONLY_KEY)
    if (v !== null) return v !== "false"
    const old = localStorage.getItem("tangerine:sidebar-show-completed")
    if (old === "true") return false
    return true
  } catch {
    return true
  }
}

function readProjectFilter(): string {
  try {
    return localStorage.getItem(PROJECT_FILTER_KEY) ?? ""
  } catch {
    return ""
  }
}

function TaskItem({
  task,
  isActive,
  onRefetch,
}: {
  task: Task
  isActive: boolean
  onRefetch?: () => void
}) {
  const { providerMetadata } = useProject()
  const statusConfig = getStatusConfig(task.status)
  const color = task.status === "running" && task.agentStatus === "idle"
    ? "var(--color-status-warning)"
    : statusConfig.color
  const unseen = !isActive && hasUnseenUpdates(task)

  return (
    <Link
      to={`/tasks/${task.id}?project=${encodeURIComponent(task.projectId)}`}
      className={`group flex items-start gap-2.5 px-4 py-2.5 ${
        isActive
          ? "bg-muted border-l-[3px] border-l-status-error"
          : "hover:bg-muted"
      }`}
      style={isActive ? {} : { borderLeft: "3px solid transparent" }}
    >
      <div className="flex h-[18px] w-2 items-start pt-[5px]">
        <div className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-1.5">
          <span className={`truncate text-md text-foreground ${isActive ? "font-semibold" : "font-medium"}`}>
            {task.title}
          </span>
          {unseen && (
            <span className="h-2 w-2 shrink-0 rounded-full bg-status-info" title="New activity" />
          )}
        </div>
        <span className="font-mono text-xxs text-muted-foreground">
          {formatRelativeTime(task.createdAt)} · {task.status === "running" && task.agentStatus === "idle" ? "idle" : task.status}
          {" · "}
          <span className="rounded bg-muted px-1 py-px text-2xs">
            {providerMetadata[task.provider]?.abbreviation ?? task.provider}
          </span>
          {task.type !== "worker" && (
            <>
              {" · "}
              <span className="rounded bg-muted px-1 py-px text-2xs">
                {task.type}
              </span>
            </>
          )}
        </span>
      </div>
      <div className="shrink-0 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100">
        <TaskOverflowMenu task={task} onRefetch={onRefetch} size="sm" />
      </div>
    </Link>
  )
}

interface ProjectGroup {
  projectId: string
  projectName: string
  orchestrator: Task | null
  tasks: Task[]
}

function ProjectGroupHeader({
  group,
  isActive,
  onRefetch,
}: {
  group: ProjectGroup
  isActive: boolean
  onRefetch?: () => void
}) {
  const nav = useNavigate()
  const [creating, setCreating] = useState(false)
  const projectQs = `?project=${encodeURIComponent(group.projectName)}`

  const baseClass = "flex w-full items-center gap-2.5 border-t border-border bg-muted/50 px-4 py-2 text-left"
  const activeClass = isActive ? "border-l-[3px] border-l-status-error" : "hover:bg-muted"

  const content = (
    <>
      <span className="truncate text-md font-semibold text-foreground">
        {group.projectName}
      </span>
      <div className="flex items-center justify-center rounded-sm bg-muted px-1.5 py-px">
        <span className="font-mono text-2xs text-muted-foreground">{group.tasks.length}</span>
      </div>
    </>
  )

  if (group.orchestrator) {
    return (
      <Link
        to={`/tasks/${group.orchestrator.id}${projectQs}`}
        className={`${baseClass} ${activeClass}`}
        style={isActive ? {} : { borderLeft: "3px solid transparent" }}
      >
        {content}
      </Link>
    )
  }

  // No orchestrator yet — click to create one
  return (
    <button
      disabled={creating}
      onClick={async () => {
        setCreating(true)
        try {
          const task = await ensureOrchestrator(group.projectName)
          onRefetch?.()
          nav(`/tasks/${task.id}${projectQs}`)
        } finally {
          setCreating(false)
        }
      }}
      className={`${baseClass} hover:bg-muted`}
      style={{ borderLeft: "3px solid transparent" }}
    >
      {content}
    </button>
  )
}

export function TasksSidebar({ tasks, projects, searchQuery, onSearchChange, onNewAgent, onRefetch }: TasksSidebarProps) {
  const { id: activeId } = useParams<{ id: string }>()
  const [activeOnly, setActiveOnly] = useState(readActiveOnly)
  const [projectFilter, setProjectFilter] = useState(readProjectFilter)
  const isSearching = searchQuery.length > 0

  // Filter tasks by activeOnly and project filter, then group by project
  const { groups, activeCount, totalCount } = useMemo(() => {
    // Apply project filter
    const filtered = projectFilter
      ? tasks.filter((t) => t.projectId === projectFilter)
      : tasks

    // Split orchestrators vs workers, count active in one pass
    const orchestrators = new Map<string, Task>()
    const workers: Task[] = []
    let ac = 0
    for (const t of filtered) {
      if (t.type === "orchestrator") {
        const existing = orchestrators.get(t.projectId)
        if (!existing || (!TERMINAL_STATUSES.has(t.status) && TERMINAL_STATUSES.has(existing.status))) {
          orchestrators.set(t.projectId, t)
        }
      } else {
        workers.push(t)
        if (!TERMINAL_STATUSES.has(t.status)) ac++
      }
    }

    // Filter workers by active status
    const filteredWorkers = activeOnly && !isSearching
      ? workers.filter((t) => !TERMINAL_STATUSES.has(t.status))
      : workers

    // Sort: active first, then terminated
    const sorted = [...filteredWorkers].sort((a, b) => {
      const aTerminated = TERMINAL_STATUSES.has(a.status) ? 1 : 0
      const bTerminated = TERMINAL_STATUSES.has(b.status) ? 1 : 0
      return aTerminated - bTerminated
    })

    // Group by project
    const groupMap = new Map<string, ProjectGroup>()

    // Initialize groups from projects list (to maintain order)
    const activeProjects = projects.filter((p) => !p.archived)
    for (const p of activeProjects) {
      if (projectFilter && p.name !== projectFilter) continue
      groupMap.set(p.name, {
        projectId: p.name,
        projectName: p.name,
        orchestrator: orchestrators.get(p.name) ?? null,
        tasks: [],
      })
    }

    // Assign tasks to groups
    for (const t of sorted) {
      let group = groupMap.get(t.projectId)
      if (!group) {
        group = {
          projectId: t.projectId,
          projectName: t.projectId,
          orchestrator: orchestrators.get(t.projectId) ?? null,
          tasks: [],
        }
        groupMap.set(t.projectId, group)
      }
      group.tasks.push(t)
    }

    const result = Array.from(groupMap.values())

    return { groups: result, activeCount: ac, totalCount: filteredWorkers.length }
  }, [tasks, projects, activeOnly, isSearching, projectFilter])

  useEffect(() => {
    // Validate project filter — clear if project no longer exists
    if (projectFilter && !projects.some((p) => p.name === projectFilter)) {
      setProjectFilter("")
      try { localStorage.removeItem(PROJECT_FILTER_KEY) } catch { /* ignore */ }
    }
  }, [projects, projectFilter])

  const handleToggleActiveOnly = useCallback(() => {
    setActiveOnly((prev) => {
      const next = !prev
      try { localStorage.setItem(ACTIVE_ONLY_KEY, String(next)) } catch { /* ignore */ }
      return next
    })
  }, [])

  const handleProjectFilterChange = useCallback((value: string | null) => {
    const resolvedValue = !value || value === "all" ? "" : value
    setProjectFilter(resolvedValue)
    try {
      if (resolvedValue) localStorage.setItem(PROJECT_FILTER_KEY, resolvedValue)
      else localStorage.removeItem(PROJECT_FILTER_KEY)
    } catch { /* ignore */ }
  }, [])

  return (
    <div className="flex h-full w-full shrink-0 flex-col border-r border-border bg-background md:w-[240px]">
      {/* Top section */}
      <div className="flex flex-col gap-3 p-4 pt-5">
        <Button
          onClick={onNewAgent}
          className="hidden md:flex h-9 items-center justify-center gap-1.5 rounded-md bg-primary text-primary-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
          <span className="text-md font-medium">New Run</span>
        </Button>
        <div className="flex h-[34px] items-center gap-2 rounded-md border border-border bg-background px-2.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <Input
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search tasks..."
            className="min-w-0 flex-1 border-0 bg-transparent p-0 text-base text-foreground placeholder:text-muted-foreground shadow-none outline-none focus-visible:ring-0 md:text-md"
          />
          {searchQuery && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onSearchChange("")}
              aria-label="Clear search"
              className="h-5 w-5 shrink-0 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </Button>
          )}
        </div>
      </div>

      <div className="flex w-full shrink-0 items-center justify-between px-4 py-2.5">
        <Select
          value={projectFilter || "all"}
          onValueChange={handleProjectFilterChange}
        >
          <SelectTrigger
            aria-label="Filter by project"
            className="h-auto border-0 bg-transparent p-0 text-xxs font-medium tracking-wider text-muted-foreground shadow-none focus:ring-1 focus:ring-muted-foreground"
          >
            <SelectValue placeholder="PROJECTS" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">PROJECTS</SelectItem>
            {projects.filter((p) => !p.archived).map((p) => (
              <SelectItem key={p.name} value={p.name}>{p.name.toUpperCase()}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="default"
          size="sm"
          onClick={handleToggleActiveOnly}
          aria-label={activeOnly && !isSearching ? "Show all runs" : "Show active runs only"}
          className="h-auto rounded-sm bg-primary px-2 py-0.5 hover:opacity-80"
        >
          <span className="font-mono text-xxs font-semibold text-primary-foreground">
            {activeOnly && !isSearching ? activeCount : totalCount}
          </span>
        </Button>
      </div>

      <div className="h-px bg-border" />

      <ScrollArea className="md:flex-1 md:min-h-0">
        {groups.length === 0 ? (
          <div className="px-4 py-3 text-xs text-muted-foreground">No tasks</div>
        ) : (
          groups.map((group) => (
            <div key={group.projectId}>
              <ProjectGroupHeader
                group={group}
                isActive={group.orchestrator?.id === activeId}
                onRefetch={onRefetch}
              />
              {group.tasks.map((task) => (
                <TaskItem
                  key={task.id}
                  task={task}
                  isActive={task.id === activeId}
                  onRefetch={onRefetch}
                />
              ))}
            </div>
          ))
        )}
      </ScrollArea>
    </div>
  )
}
