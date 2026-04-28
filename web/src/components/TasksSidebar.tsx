import { useMemo, useState, useCallback, useEffect, useRef } from "react"
import { Link, useParams } from "react-router-dom"
import { TERMINAL_STATUSES } from "@tangerine/shared"
import type { Task, ProjectConfig } from "@tangerine/shared"
import { Search, Plus, X, ChevronDown } from "lucide-react"
import { getTaskDisplayStatus, getTaskStatusText, hasUnseenUpdates, getPrStatusConfig } from "../lib/status"
import { formatRelativeTime, formatPrNumber } from "../lib/format"
import { useProject } from "../context/ProjectContext"
import { TaskOverflowMenu } from "./TaskListItem"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { ProjectSelector } from "./ProjectSelector"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible"

interface TasksSidebarProps {
  tasks: Task[]
  projects: ProjectConfig[]
  searchQuery: string
  onSearchChange: (query: string) => void
  onNewAgent: () => void
  onRefetch?: () => void
  counts?: Record<string, number>
  loadedCounts?: Record<string, number>
  onLoadMore?: (projectId: string) => Promise<void>
}

const PROJECT_FILTER_KEY = "tangerine:sidebar-project-filter"

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
  const { agents } = useProject()
  const agentLabel = agents.find((agent) => agent.id === task.provider)?.name ?? task.provider
  const statusConfig = getTaskDisplayStatus(task)
  const unseen = !isActive && hasUnseenUpdates(task)

  return (
    <Link
      to={`/tasks/${task.id}?project=${encodeURIComponent(task.projectId)}`}
      className={`group flex items-start gap-2.5 px-4 py-2.5 outline-none focus-visible:ring-1 focus-visible:ring-ring/50 ${
        isActive
          ? "bg-muted border-l-[3px] border-l-status-error"
          : "hover:bg-muted"
      }`}
      style={isActive ? {} : { borderLeft: "3px solid transparent" }}
    >
      <div className="flex h-[18px] w-2 items-start pt-[5px]">
        <div className="h-2 w-2 rounded-full" style={{ backgroundColor: statusConfig.color }} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-1.5">
          <span className={`truncate text-sm text-foreground ${isActive ? "font-semibold" : "font-medium"}`}>
            {task.title}
          </span>
          {unseen && (
            <span className="h-2 w-2 shrink-0 rounded-full bg-status-info" title="New activity" />
          )}
        </div>
        <span className="font-mono text-xxs text-muted-foreground">
          {formatRelativeTime(task.createdAt)} · {getTaskStatusText(task)}
          {" · "}
          <span className="rounded bg-muted px-1 py-px text-2xs">
            {agentLabel}
          </span>
          {task.type !== "worker" && (
            <>
              {" · "}
              <span className="rounded bg-muted px-1 py-px text-2xs">
                {task.type}
              </span>
            </>
          )}
          {task.prUrl && (() => {
            const prConfig = getPrStatusConfig(task.prStatus)
            return (
              <>
                {" · "}
                <span className={`${prConfig.textClass} opacity-70`}>
                  {formatPrNumber(task.prUrl)}
                </span>
              </>
            )
          })()}
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
  tasks: Task[]
}

function ProjectGroupHeader({
  group,
  activeOnly,
  onToggle,
  activeCount,
  totalCount,
  collapsed,
  onToggleCollapse,
}: {
  group: ProjectGroup
  activeOnly: boolean
  onToggle: () => void
  activeCount: number
  totalCount: number
  collapsed: boolean
  onToggleCollapse: () => void
}) {
  const rowClass = "flex w-full items-center border-t border-border bg-muted/50"

  const navContent = (
    <CollapsibleTrigger
      onClick={onToggleCollapse}
      className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 px-4 py-2 hover:bg-muted"
    >
      <ChevronDown
        className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200 ${collapsed ? "-rotate-90" : ""}`}
      />
      <span className="min-w-0 flex-1 truncate text-left text-sm font-semibold text-foreground">
        {group.projectName}
      </span>
    </CollapsibleTrigger>
  )

  const toggleBtn = (
    <Badge
      variant="outline"
      render={<button />}
      onClick={(e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); onToggle() }}
      className="mr-2 shrink-0 cursor-pointer font-mono"
      aria-label={activeOnly ? "Show all tasks" : "Show active tasks only"}
      title={activeOnly ? "Showing active only — click to show all" : "Showing all — click to show active only"}
    >
      <span className={activeOnly ? "text-foreground" : "opacity-40"}>{activeCount}</span>
      <span className="opacity-40">/</span>
      <span className={!activeOnly ? "text-foreground" : "opacity-40"}>{totalCount}</span>
    </Badge>
  )

  return (
    <div className={rowClass}>
      {navContent}
      {toggleBtn}
    </div>
  )
}

export function TasksSidebar({ tasks, projects, searchQuery, onSearchChange, onNewAgent, onRefetch, counts = {}, loadedCounts = {}, onLoadMore }: TasksSidebarProps) {
  const { id: activeId } = useParams<{ id: string }>()
  const [projectFilter, setProjectFilter] = useState(readProjectFilter)
  // Per-group active-only toggle: undefined means default (true = active only)
  const [groupActiveOnly, setGroupActiveOnly] = useState<Record<string, boolean>>({})
  // Per-group collapsed state: undefined means default (false = expanded)
  const [groupCollapsed, setGroupCollapsed] = useState<Record<string, boolean>>({})
  const [loadingMore, setLoadingMore] = useState<Record<string, boolean>>({})
  // Ref for synchronous double-click prevention
  const loadingMoreRef = useRef<Set<string>>(new Set())
  const isSearching = searchQuery.length > 0

  // Group tasks by project (no global active filter — per-group toggles handle it)
  const groups = useMemo(() => {
    // Apply project filter
    const filtered = projectFilter
      ? tasks.filter((t) => t.projectId === projectFilter)
      : tasks

    // Sort: active first, then terminated
    const sorted = [...filtered].sort((a, b) => {
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
        tasks: [],
      })
    }

    // Assign tasks to groups (only for non-archived projects)
    for (const t of sorted) {
      const group = groupMap.get(t.projectId)
      // Skip tasks whose project isn't in groupMap — archived projects are excluded from
      // activeProjects above, so their tasks won't create new groups here
      if (!group) continue
      group.tasks.push(t)
    }

    return Array.from(groupMap.values())
  }, [tasks, projects, projectFilter])

  useEffect(() => {
    // Validate project filter — clear if project no longer exists
    if (projectFilter && !projects.some((p) => p.name === projectFilter)) {
      setProjectFilter("")
      try { localStorage.removeItem(PROJECT_FILTER_KEY) } catch { /* ignore */ }
    }
  }, [projects, projectFilter])

  const handleGroupToggle = useCallback((projectId: string) => {
    setGroupActiveOnly((prev) => ({
      ...prev,
      [projectId]: !(prev[projectId] ?? true),
    }))
  }, [])

  const handleGroupCollapseToggle = useCallback((projectId: string) => {
    setGroupCollapsed((prev) => ({
      ...prev,
      [projectId]: !(prev[projectId] ?? false),
    }))
  }, [])

  const handleProjectFilterChange = useCallback((value: string | null) => {
    const resolvedValue = !value || value === "all" ? "" : value
    setProjectFilter(resolvedValue)
    try {
      if (resolvedValue) localStorage.setItem(PROJECT_FILTER_KEY, resolvedValue)
      else localStorage.removeItem(PROJECT_FILTER_KEY)
    } catch { /* ignore */ }
  }, [])

  const handleLoadMore = useCallback(async (projectId: string) => {
    if (!onLoadMore || loadingMoreRef.current.has(projectId)) return
    loadingMoreRef.current.add(projectId)
    setLoadingMore((prev) => ({ ...prev, [projectId]: true }))
    try {
      await onLoadMore(projectId)
    } finally {
      loadingMoreRef.current.delete(projectId)
      setLoadingMore((prev) => ({ ...prev, [projectId]: false }))
    }
  }, [onLoadMore])

  return (
    <div className="flex h-full w-full shrink-0 flex-col md:border-r border-border bg-background md:w-[240px]">
      {/* Top section */}
      <div className="flex flex-col gap-2 px-4 pt-5 pb-3">
        <Button
          onClick={onNewAgent}
          className="flex"
        >
          <Plus className="h-3.5 w-3.5" />
          <span className="text-sm font-medium">New Run</span>
        </Button>
        <InputGroup className="h-[34px]">
          <InputGroupInput
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search tasks..."
            className="text-base md:text-sm"
          />
          <InputGroupAddon>
            <Search className="size-3.5" />
          </InputGroupAddon>
          {searchQuery && (
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                size="icon-xs"
                onClick={() => onSearchChange("")}
                aria-label="Clear search"
              >
                <X className="size-3" />
              </InputGroupButton>
            </InputGroupAddon>
          )}
        </InputGroup>
        <ProjectSelector
          projects={projects}
          value={projectFilter}
          onChange={handleProjectFilterChange}
          allowAll
          size="sm"
          className="w-full"
          aria-label="Filter by project"
        />
      </div>

      <div className="h-px bg-border" />

      <ScrollArea className="md:flex-1 md:min-h-0">
        {groups.length === 0 ? (
          <div className="px-4 py-3 text-xs text-muted-foreground">No tasks</div>
        ) : (
          groups.map((group) => {
            // Per-group active filter: default true (active only), overridden per group; search shows all
            const groupOnly = !isSearching && (groupActiveOnly[group.projectId] ?? true)
            const activeTasks = group.tasks.filter((t) => !TERMINAL_STATUSES.has(t.status))
            const displayedTasks = groupOnly ? activeTasks : group.tasks
            const totalForProject = counts[group.projectId] ?? 0
            const loadedForProject = loadedCounts[group.projectId] ?? 0
            const hasMore = loadedForProject < totalForProject
            const isLoading = loadingMore[group.projectId] ?? false
            const collapsed = groupCollapsed[group.projectId] ?? false
            // Force expand during search so results are visible
            const effectiveCollapsed = collapsed && !isSearching
            return (
              <Collapsible key={group.projectId} open={!effectiveCollapsed}>
                <ProjectGroupHeader
                  group={group}
                  activeOnly={groupOnly}
                  onToggle={() => handleGroupToggle(group.projectId)}
                  activeCount={activeTasks.length}
                  totalCount={totalForProject}
                  collapsed={effectiveCollapsed}
                  onToggleCollapse={() => handleGroupCollapseToggle(group.projectId)}
                />
                <CollapsibleContent>
                  {displayedTasks.map((task) => (
                    <TaskItem
                      key={task.id}
                      task={task}
                      isActive={task.id === activeId}
                      onRefetch={onRefetch}
                    />
                  ))}
                  {hasMore && !groupOnly && (
                    <button
                      onClick={() => handleLoadMore(group.projectId)}
                      disabled={isLoading}
                      className="flex w-full items-center justify-center gap-1.5 py-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                    >
                      {isLoading ? "Loading..." : `Load more (${loadedForProject}/${totalForProject})`}
                    </button>
                  )}
                </CollapsibleContent>
              </Collapsible>
            )
          })
        )}
      </ScrollArea>
    </div>
  )
}
